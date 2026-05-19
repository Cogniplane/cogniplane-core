// MCP gateway.
//
// Handles JSON-RPC 2.0 traffic from runtimes (Codex and Claude SDK) and
// dispatches to managed tools or proxies to upstream servers.
//
// Per-turn `toolContextId` resolution has three fallbacks — args, URL query
// param, and session-scoped lookup via the runtime token's `sid` claim.
// Each runtime hits a different path: Codex injects the id into args, the
// Claude SDK in local mode passes it as a query param, and the in-sandbox
// Claude harness can only rely on the session-scoped lookup. All three
// must keep working — don't collapse them into one path.

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";

import type { AppDependencies } from "../app-dependencies.js";
import { getErrorMessage } from "../lib/http-errors.js";
import { signProxyHeaders } from "../lib/mcp-proxy-signature.js";
import { ssrfSafeAgent } from "../lib/url-validation.js";
import { verifyRuntimeToken } from "../services/auth/runtime-token.js";

import type { ActivationTracker } from "../services/activation-tracker.js";
import {
  parseRuntimePolicySnapshot,
  type McpServerRegistration,
  type ResolvedRuntimePolicy
} from "../services/admin-config-records.js";
import type { ManagedToolDefinition } from "../services/managed-tools/types.js";
import type {
  ToolExecutionContext,
  ToolExecutionContextStore
} from "../services/auth/tool-execution-context-store.js";

const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional()
});

const mcpRouteParamsSchema = z.object({
  serverId: z.string().min(1)
});

type RpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

function ok(id: string | number | undefined, result: unknown): RpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result
  };
}

function failure(id: string | number | undefined, code: number, message: string): RpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildMcpRouteStores(
  deps: AppDependencies,
  extras: {
    runtimeTokenSecret: string;
    readRuntimeFile: (sessionId: string, runtimeId: string, filePath: string) => Promise<Uint8Array>;
    writeRuntimeFile: (
      sessionId: string,
      runtimeId: string,
      filePath: string,
      data: Uint8Array | ArrayBuffer | string
    ) => Promise<string>;
  }
) {
  return {
    dynamicConfig: deps.dynamicConfig,
    sessions: deps.sessions,
    messages: deps.messages,
    artifacts: deps.artifacts,
    storage: deps.artifactStorage,
    auditEvents: deps.auditEvents,
    toolContexts: deps.toolContexts,
    githubConnections: deps.githubConnectionService,
    notionConnections: deps.notionConnectionService,
    managedToolFactoryRegistry: deps.managedToolFactoryRegistry,
    readRuntimeFile: extras.readRuntimeFile,
    writeRuntimeFile: extras.writeRuntimeFile,
    runtimeTokenSecret: extras.runtimeTokenSecret,
    activationTracker: deps.activationTracker
  };
}

export type McpRouteStores = ReturnType<typeof buildMcpRouteStores>;

export async function registerMcpRoutes(app: FastifyInstance, stores: McpRouteStores): Promise<void> {
  const managedTools = stores.managedToolFactoryRegistry.createDefinitions({
    sessions: stores.sessions,
    messages: stores.messages,
    artifacts: stores.artifacts,
    storage: stores.storage,
    auditEvents: stores.auditEvents,
    githubConnections: stores.githubConnections,
    notionConnections: stores.notionConnections,
    readRuntimeFile: stores.readRuntimeFile,
    writeRuntimeFile: stores.writeRuntimeFile
  });

  // Streamable HTTP transport clients may open a GET
  // SSE stream after `initialize` so the server can push responses and
  // server-initiated messages. We don't need server→client streaming — the
  // POST handler returns results inline — but the CLI still issues the GET
  // and treats a 404 as a transport-level failure, which cascades into
  // "tool call failed" errors for the model. Per the MCP spec, returning
  // 405 "Method Not Allowed" tells the client to fall back to POST-only
  // response mode, which is what our POST handler already supports.
  app.get("/mcp/:serverId", async (_request, reply) => {
    reply.header("Allow", "POST, DELETE");
    reply.code(405);
    return { error: "GET stream not supported; use POST for JSON-RPC." };
  });

  // DELETE terminates an MCP session. We don't hold per-connection state at
  // the route layer (runtime lifecycle is managed by the runtime adapter),
  // so this is a no-op acknowledgement.
  app.delete("/mcp/:serverId", async (_request, reply) => {
    reply.code(204);
    return null;
  });

  app.post("/mcp/:serverId", async (request, reply) => {
    const parsed = rpcRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return failure(undefined, -32600, "Invalid JSON-RPC request.");
    }

    const serverId = mcpRouteParamsSchema.parse(request.params).serverId;
    const rpc = parsed.data;

    let server: Awaited<ReturnType<typeof stores.dynamicConfig.getMcpServer>>;
    try {
      server = await stores.dynamicConfig.getMcpServer(request.auth.tenantId, serverId);
    } catch (error) {
      request.log.warn({ err: error, serverId, tenantId: request.auth.tenantId }, "MCP server lookup failed");
      reply.code(500);
      return failure(rpc.id, -32603, "Internal error.");
    }

    // Some runtimes may embed the per-turn toolContextId in the MCP URL as
    // `?toolContextId=ctx_...`. Extract it here so it can be used as a
    // fallback when the RPC args omit it.
    const urlToolContextId = (() => {
      try {
        const url = new URL(request.url, "http://localhost");
        const v = url.searchParams.get("toolContextId");
        return v && v.startsWith("ctx_") ? v : null;
      } catch {
        return null;
      }
    })();

    // Session-scoped fallback: when neither args nor URL carry a
    // toolContextId, the gateway looks up the active turn's context by
    // sessionId. The sessionId comes from the runtime token (rt_*) that
    // authenticated this request — we re-verify it here rather than threading
    // the claim through request.auth so the rest of the API surface stays
    // unchanged.
    const sessionIdFromRuntimeToken = resolveSessionIdFromRuntimeToken(
      request.headers.authorization,
      request.url,
      stores.runtimeTokenSecret
    );

    request.log.debug(
      {
        serverId,
        rpcMethod: rpc.method,
        sessionIdFromRuntimeToken,
        urlToolContextId,
        rpcId: rpc.id ?? null
      },
      "MCP RPC received"
    );

    switch (rpc.method) {
      case "initialize":
        request.log.debug({ serverId, sessionIdFromRuntimeToken }, "MCP initialize");
        return handleInitialize(rpc, server);

      case "notifications/initialized":
        reply.code(202);
        return null;

      case "tools/list":
        return handleToolsList({
          rpc,
          server,
          tenantId: request.auth.tenantId,
          managedTools,
          toolContexts: stores.toolContexts,
          sessionIdFromRuntimeToken,
          logger: request.log
        });

      case "tools/call":
        return handleToolsCall({
          rpc,
          server,
          tenantId: request.auth.tenantId,
          managedTools,
          toolContexts: stores.toolContexts,
          urlToolContextId,
          sessionIdFromRuntimeToken,
          activationTracker: stores.activationTracker,
          dataEncryptionSecret: app.config.DATA_ENCRYPTION_SECRET,
          logger: request.log
        });

      default:
        return failure(rpc.id, -32601, `Unsupported MCP method ${rpc.method}.`);
    }
  });
}

// ---------------------------------------------------------------------------
// MCP method handlers
// ---------------------------------------------------------------------------

function handleInitialize(
  rpc: z.infer<typeof rpcRequestSchema>,
  server: McpServerRegistration
): RpcResponse {
  return ok(rpc.id, {
    protocolVersion: "2025-03-26",
    capabilities: { tools: {} },
    serverInfo: {
      name: `cogniplane-${server.id}`,
      version: "0.1.0"
    }
  });
}

async function handleToolsList(input: {
  rpc: z.infer<typeof rpcRequestSchema>;
  server: McpServerRegistration;
  tenantId: string;
  managedTools: ManagedToolDefinition[];
  toolContexts: ToolExecutionContextStore;
  sessionIdFromRuntimeToken: string | null;
  logger: Pick<FastifyBaseLogger, "debug">;
}): Promise<RpcResponse> {
  const { rpc, server, tenantId, managedTools, toolContexts, sessionIdFromRuntimeToken, logger } = input;
  const managedToolsForRequest =
    server.mode === "managed"
      ? await getVisibleManagedTools({
          tenantId,
          serverId: server.id,
          managedTools,
          toolContexts,
          sessionIdFromRuntimeToken
        })
      : null;

  logger.debug(
    {
      serverId: server.id,
      mode: server.mode,
      toolCount: managedToolsForRequest?.length ?? null,
      managedToolNames: managedToolsForRequest?.map((tool) => tool.name) ?? null,
      sessionIdFromRuntimeToken
    },
    "MCP tools/list"
  );

  if (server.mode === "managed") {
    // NOTE: we intentionally do NOT advertise `outputSchema` here.
    // Our managed tool outputs use a top-level `{ oneOf: [...] }`
    // discriminator (success vs. error), which the Claude Agent SDK's
    // bundled MCP client rejects during tools/list validation —
    // every tool in the response is then silently dropped from the
    // model's tool list (empty `tools[]` in mcpServerStatus and no
    // `mcp__managed-session-context__*` entries in system/init).
    // `outputSchema` is optional per MCP spec; callers get the same
    // structured data via the `content` array on tool calls.
    return ok(rpc.id, {
      tools: managedToolsForRequest!.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    });
  }

  return forwardRpc(server.upstreamUrl, rpc, {
    "X-Forwarded-By": "cogniplane-core"
  });
}

async function handleToolsCall(input: {
  rpc: z.infer<typeof rpcRequestSchema>;
  server: McpServerRegistration;
  tenantId: string;
  managedTools: ManagedToolDefinition[];
  toolContexts: ToolExecutionContextStore;
  urlToolContextId: string | null;
  sessionIdFromRuntimeToken: string | null;
  activationTracker?: ActivationTracker;
  dataEncryptionSecret: string;
  logger: Pick<FastifyBaseLogger, "debug">;
}): Promise<RpcResponse> {
  const {
    rpc,
    server,
    tenantId,
    managedTools,
    toolContexts,
    urlToolContextId,
    sessionIdFromRuntimeToken,
    activationTracker,
    dataEncryptionSecret,
    logger
  } = input;

  logger.debug(
    {
      serverId: server.id,
      mode: server.mode,
      toolName: typeof rpc.params?.name === "string" ? rpc.params.name : null,
      argumentKeys:
        rpc.params?.arguments && typeof rpc.params.arguments === "object"
          ? Object.keys(rpc.params.arguments as Record<string, unknown>)
          : [],
      sessionIdFromRuntimeToken,
      urlToolContextId
    },
    "MCP tools/call"
  );

  if (rpc.params?.arguments !== undefined && !isPlainObject(rpc.params.arguments)) {
    return failure(rpc.id, -32602, "Invalid params: 'arguments' must be an object.");
  }

  const response =
    server.mode === "managed"
      ? await handleManagedToolCall(
          rpc,
          tenantId,
          server.id,
          managedTools,
          toolContexts,
          urlToolContextId,
          sessionIdFromRuntimeToken
        )
      : await handleForwardedToolCall(
          rpc,
          tenantId,
          server.id,
          toolContexts,
          server.upstreamUrl,
          urlToolContextId,
          sessionIdFromRuntimeToken,
          dataEncryptionSecret
        );

  await recordToolCallTelemetry({
    activationTracker,
    tenantId,
    sessionIdFromRuntimeToken,
    server,
    rpc,
    response
  });

  return response;
}

/**
 * Record per-tool-call activation telemetry. Best-effort: the session id is
 * the runtime token's `sid` claim (which authenticated this request). On
 * success we record the MCP server invocation AND credit every materialized
 * skill whose `associatedToolIds` includes this tool — that's the Tier 1
 * skill-attribution signal the corpus assembler and "Used 30d" counters
 * consume. No-op when activation tracking is unwired or the request didn't
 * come over a runtime token (e.g. admin probe).
 */
async function recordToolCallTelemetry(input: {
  activationTracker?: ActivationTracker;
  tenantId: string;
  sessionIdFromRuntimeToken: string | null;
  server: McpServerRegistration;
  rpc: z.infer<typeof rpcRequestSchema>;
  response: RpcResponse;
}): Promise<void> {
  const { activationTracker, tenantId, sessionIdFromRuntimeToken, server, rpc, response } = input;
  if (!activationTracker || !sessionIdFromRuntimeToken) return;

  const toolName = typeof rpc.params?.name === "string" ? (rpc.params.name as string) : null;
  const eventCtx = { tenantId, sessionId: sessionIdFromRuntimeToken };

  if (response.error) {
    await activationTracker.recordFailure(eventCtx, "mcp_server", server.id, {
      message: response.error.message,
      code: response.error.code,
      toolName
    });
    return;
  }

  await activationTracker.recordInvocation(eventCtx, "mcp_server", server.id, {
    toolName,
    mode: server.mode
  });
  if (toolName) {
    await activationTracker.recordSkillInvocationsForTool(eventCtx, toolName, {
      mcpServerId: server.id
    });
  }
}

async function handleManagedToolCall(
  rpc: z.infer<typeof rpcRequestSchema>,
  tenantId: string,
  serverId: string,
  managedTools: ManagedToolDefinition[],
  toolContexts: ToolExecutionContextStore,
  urlToolContextId: string | null,
  sessionIdFromRuntimeToken: string | null
): Promise<RpcResponse> {
  const params = rpc.params ?? {};
  const toolName = String(params.name ?? "");
  const args =
    params.arguments && typeof params.arguments === "object"
      ? { ...(params.arguments as Record<string, unknown>) }
      : {};
  const tool = managedTools.find((entry) => entry.name === toolName);

  if (!tool) {
    return failure(rpc.id, -32601, `Unknown managed tool ${toolName}.`);
  }

  // Resolution order for the tool context:
  //   1. toolContextId in the RPC args (primary path — Codex, Claude SDK).
  //   2. toolContextId in the MCP URL query string.
  //   3. Active session fallback — look up the latest non-expired context
  //      for the sessionId carried by the runtime token. This remains as a
  //      compatibility and resilience path when a runtime omits the argument.
  const argToolContextId = typeof args.toolContextId === "string" ? args.toolContextId : "";
  let context: ToolExecutionContext | null = null;

  try {
    if (argToolContextId) {
      context = await toolContexts.require(tenantId, argToolContextId);
    } else if (urlToolContextId) {
      context = await toolContexts.require(tenantId, urlToolContextId);
    } else if (sessionIdFromRuntimeToken) {
      context = await toolContexts.findLatestActiveBySession(tenantId, sessionIdFromRuntimeToken);
    }
  } catch (error) {
    return failure(rpc.id, -32000, getErrorMessage(error, "Tool context lookup failed."));
  }

  if (!context) {
    return failure(rpc.id, -32602, "toolContextId is required.");
  }

  // Stamp the resolved context id into the args so handlers that expect it
  // (and downstream auditing) see a consistent value.
  args.toolContextId = context.toolContextId;

  try {
    const runtimePolicy = requireMcpServerAllowed(serverId, context);
    requireManagedToolAllowed(tool.name, runtimePolicy);
    enforceManagedToolPolicy(tool, runtimePolicy.id, runtimePolicy.autoApproveReadOnlyTools);
    const result = await tool.handler({
      context,
      arguments: args
    });

    return ok(rpc.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ],
      structuredContent: result,
      isError: false
    });
  } catch (error) {
    return failure(rpc.id, -32000, getErrorMessage(error, "Tool call failed."));
  }
}

async function getVisibleManagedTools(input: {
  tenantId: string;
  serverId: string;
  managedTools: ManagedToolDefinition[];
  toolContexts: ToolExecutionContextStore;
  sessionIdFromRuntimeToken: string | null;
}): Promise<ManagedToolDefinition[]> {
  if (!input.sessionIdFromRuntimeToken) {
    return input.managedTools;
  }

  const context = await input.toolContexts.findLatestActiveBySession(
    input.tenantId,
    input.sessionIdFromRuntimeToken
  );
  if (!context) {
    return input.managedTools;
  }

  // If the runtime policy forbids this MCP server, advertise no tools
  // rather than throwing — `tools/list` is probed by every SDK at startup and
  // should not 500 on misconfiguration. Tool *calls* still fail via the
  // existing `requireMcpServerAllowed` check in `handleManagedToolCall`.
  const runtimePolicy = getRuntimePolicySnapshot(context);
  if (!runtimePolicy.enabledMcpServers.includes(input.serverId)) {
    return [];
  }

  return input.managedTools.filter((tool) =>
    runtimePolicy.enabledToolIds.includes(tool.name)
  );
}

function requireMcpServerAllowed(serverId: string, context: ToolExecutionContext) {
  const runtimePolicy = getRuntimePolicySnapshot(context);
  if (!runtimePolicy.enabledMcpServers.includes(serverId)) {
    throw new Error(
      `MCP server ${serverId} is not allowed by runtime policy ${runtimePolicy.id}.`
    );
  }

  return runtimePolicy;
}

function requireManagedToolAllowed(
  toolName: string,
  runtimePolicy: ResolvedRuntimePolicy
): void {
  if (!runtimePolicy.enabledToolIds.includes(toolName)) {
    throw new Error(
      `Managed tool ${toolName} is not allowed by runtime policy ${runtimePolicy.id}.`
    );
  }
}

function getRuntimePolicySnapshot(context: ToolExecutionContext): ResolvedRuntimePolicy {
  return parseRuntimePolicySnapshot(context.metadata.runtimePolicy, {
    toolContextId: context.toolContextId
  });
}

/**
 * Enforces the auto-approval policy for managed MCP tools.
 *
 * Read-only tools are allowed when autoApproveReadOnlyTools is enabled.
 * Write tools are always allowed through at the MCP layer — the runtime's
 * approval flow (based on the profile's approvalPolicy) gates destructive
 * operations separately.
 */
function enforceManagedToolPolicy(
  tool: { name: string; readOnly: boolean },
  runtimePolicyId: string,
  autoApproveReadOnlyTools: boolean
): void {
  if (tool.readOnly && !autoApproveReadOnlyTools) {
    throw new Error(
      `Read-only managed tool ${tool.name} is not auto-approved by runtime policy ${runtimePolicyId}.`
    );
  }
}

async function handleForwardedToolCall(
  rpc: z.infer<typeof rpcRequestSchema>,
  tenantId: string,
  serverId: string,
  toolContexts: ToolExecutionContextStore,
  upstreamUrl: string | null,
  urlToolContextId: string | null,
  sessionIdFromRuntimeToken: string | null,
  dataEncryptionSecret: string
): Promise<RpcResponse> {
  if (!upstreamUrl) {
    return failure(rpc.id, -32601, "Trusted MCP upstream is not configured.");
  }

  const params = rpc.params ?? {};
  const args =
    params.arguments && typeof params.arguments === "object"
      ? ({ ...(params.arguments as Record<string, unknown>) } satisfies Record<string, unknown>)
      : {};
  const argToolContextId = typeof args.toolContextId === "string" ? args.toolContextId : "";

  // Same resolution order as the managed path — see handleManagedToolCall.
  let context: ToolExecutionContext | null = null;
  try {
    if (argToolContextId) {
      context = await toolContexts.require(tenantId, argToolContextId);
    } else if (urlToolContextId) {
      context = await toolContexts.require(tenantId, urlToolContextId);
    } else if (sessionIdFromRuntimeToken) {
      context = await toolContexts.findLatestActiveBySession(tenantId, sessionIdFromRuntimeToken);
    }
  } catch (error) {
    return failure(rpc.id, -32000, getErrorMessage(error, "Tool context lookup failed."));
  }

  if (!context) {
    return failure(rpc.id, -32602, "toolContextId is required.");
  }

  requireMcpServerAllowed(serverId, context);
  delete args.toolContextId;

  return forwardRpc(
    upstreamUrl,
    {
      ...rpc,
      params: {
        ...params,
        arguments: args
      }
    },
    signProxyHeaders({
      userId: context.userId,
      sessionId: context.sessionId,
      runtimeId: context.runtimeId,
      secret: dataEncryptionSecret
    })
  );
}

async function forwardRpc(
  upstreamUrl: string | null,
  payload: z.infer<typeof rpcRequestSchema>,
  headers: Record<string, string>
): Promise<RpcResponse> {
  if (!upstreamUrl) {
    return failure(payload.id, -32601, "MCP upstream is not configured.");
  }

  // dispatcher pins the connection to the pre-validated resolved IP, closing
  // the DNS-rebinding TOCTOU window between admin-time URL validation and
  // this runtime fetch. Must use undici's fetch directly — the Node global
  // fetch (also undici-backed) ignores the `dispatcher` option as of undici v8.
  const response = await undiciFetch(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(payload),
    dispatcher: ssrfSafeAgent
  });

  if (!response.ok) {
    return failure(payload.id, -32000, `Upstream MCP request failed with ${response.status}.`);
  }

  return (await response.json()) as RpcResponse;
}

/**
 * Extracts the sessionId claim from a runtime token (rt_*) on the incoming
 * request, checking the Authorization header then the `?token=` query param.
 *
 * The auth middleware already verified this token before the handler ran;
 * re-verifying here keeps the claim extraction localised to MCP routes
 * instead of widening `request.auth` for every endpoint.
 */
function resolveSessionIdFromRuntimeToken(
  authHeader: string | string[] | undefined,
  requestUrl: string,
  secret: string
): string | null {
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  let token: string | null = null;

  if (header?.startsWith("Bearer rt_")) {
    token = header.slice("Bearer ".length);
  } else {
    try {
      const url = new URL(requestUrl, "http://localhost");
      const queryToken = url.searchParams.get("token");
      if (queryToken?.startsWith("rt_")) {
        token = queryToken;
      }
    } catch {
      // Malformed URL — nothing to resolve from
    }
  }

  if (!token) return null;
  const result = verifyRuntimeToken(token, secret);
  return result.kind === "valid" ? result.claims.sid : null;
}
