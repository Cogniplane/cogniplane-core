// MCP gateway.
//
// Handles JSON-RPC 2.0 traffic from runtimes (Codex and Claude SDK) and
// dispatches to managed tools or proxies to upstream servers.
//
// Per-turn `toolContextId` resolution has three fallbacks — args, URL query
// param, and session-scoped lookup via the runtime token's `sid` claim.
// Different runtimes hit different paths: Codex injects the id into args; the
// in-sandbox Claude harness relies on the session-scoped lookup. The URL
// query-param path is a defensive fallback some transports use. All three
// must keep working — don't collapse them into one path.

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDependencies } from "../app-dependencies.js";
import { parseCidrAllowlist } from "../lib/cidr-allowlist.js";
import { resolveEgressClientIp } from "../lib/egress-client-ip.js";
import { getErrorMessage } from "../lib/http-errors.js";
import { signProxyHeaders } from "../lib/mcp-proxy-signature.js";
import {
  forwardRpc,
  rpcFailure as failure,
  rpcOk as ok,
  selectAllowlistedHeaders,
  type McpRpcResponse as RpcResponse
} from "../lib/mcp-upstream-client.js";
import type { RuntimeTokenClaims } from "../services/auth/runtime-token.js";

import type { ActivationTracker } from "../services/activation-tracker.js";
import {
  type McpServerRegistration,
  type ResolvedRuntimePolicy
} from "../services/admin-config-records.js";
import type { ManagedToolDefinition } from "../services/managed-tools/types.js";
import { PolicyBlockedError, type PolicyService } from "../services/policy/policy-service.js";
import type {
  ToolExecutionContext,
  ToolExecutionContextStore
} from "../services/auth/tool-execution-context-store.js";
import {
  enforcePolicyCenter,
  getRuntimePolicySnapshot,
  type GatewayPolicyApprovalRouter,
  type PolicyGate
} from "../services/mcp/policy-gate.js";
import { resolveBoundToolContext } from "../services/mcp/tool-context-binder.js";
import { runGatewayAdmission } from "../services/mcp/gateway-admission.js";

const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional()
});

const mcpRouteParamsSchema = z.object({
  serverId: z.string().min(1)
});

export const MCP_REQUEST_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildMcpRouteStores(
  deps: AppDependencies,
  extras: {
    runtimeTokenSecret: string;
    egressCidrs: string;
    readRuntimeFile: (sessionId: string, runtimeId: string, filePath: string) => Promise<Uint8Array>;
    statRuntimeFile: (
      sessionId: string,
      runtimeId: string,
      filePath: string
    ) => Promise<{ sizeBytes: number }>;
    writeRuntimeFile: (
      sessionId: string,
      runtimeId: string,
      filePath: string,
      data: Uint8Array | ArrayBuffer | string
    ) => Promise<string>;
    requestPolicyApproval: GatewayPolicyApprovalRouter;
  }
) {
  return {
    db: deps.db,
    dynamicConfig: deps.dynamicConfig,
    sessions: deps.sessions,
    messages: deps.messages,
    artifacts: deps.artifacts,
    storage: deps.artifactStorage,
    auditEvents: deps.auditEvents,
    toolContexts: deps.toolContexts,
    githubConnections: deps.githubConnectionService,
    notionConnections: deps.notionConnectionService,
    piiProtection: deps.piiProtection,
    managedToolFactoryRegistry: deps.managedToolFactoryRegistry,
    managedToolCatalog: deps.managedToolCatalog,
    policyService: deps.policyService,
    readRuntimeFile: extras.readRuntimeFile,
    statRuntimeFile: extras.statRuntimeFile,
    writeRuntimeFile: extras.writeRuntimeFile,
    requestPolicyApproval: extras.requestPolicyApproval,
    runtimeTokenSecret: extras.runtimeTokenSecret,
    egressAllowlist: parseCidrAllowlist(extras.egressCidrs),
    egressIpPins: deps.egressIpPins,
    activationTracker: deps.activationTracker
  };
}

export type McpRouteStores = ReturnType<typeof buildMcpRouteStores>;

export async function registerMcpRoutes(app: FastifyInstance, stores: McpRouteStores): Promise<void> {
  const managedTools = stores.managedToolFactoryRegistry.createDefinitions({
    db: stores.db,
    dynamicConfig: stores.dynamicConfig,
    sessions: stores.sessions,
    messages: stores.messages,
    artifacts: stores.artifacts,
    storage: stores.storage,
    auditEvents: stores.auditEvents,
    githubConnections: stores.githubConnections,
    notionConnections: stores.notionConnections,
    piiProtection: stores.piiProtection,
    readRuntimeFile: stores.readRuntimeFile,
    statRuntimeFile: stores.statRuntimeFile,
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

  app.post(
    "/mcp/:serverId",
    { bodyLimit: MCP_REQUEST_BODY_LIMIT_BYTES },
    async (request, reply) => {
    const parsed = rpcRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return failure(undefined, -32600, "Invalid JSON-RPC request.");
    }

    const serverId = mcpRouteParamsSchema.parse(request.params).serverId;
    const rpc = parsed.data;

    const ipAddress = resolveEgressClientIp(request);
    const admission = await runGatewayAdmission({
      authorizationHeader: request.headers.authorization,
      rpcId: rpc.id,
      rpcMethod: rpc.method,
      serverId,
      tenantId: request.auth.tenantId,
      ipAddress,
      stores,
      logger: request.log
    });
    if (!admission.ok) {
      reply.code(admission.statusCode);
      return admission.body;
    }
    const runtimeTokenClaims = admission.claims;
    const sessionIdFromRuntimeToken = runtimeTokenClaims.sid;

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

      case "tools/call": {
        // A Policy Center require_approval can hold this response open for
        // minutes. If the connection dies first (runtime HTTP client timeout,
        // sandbox teardown) nobody will consume the result — abort the held
        // approval so a late human approve can't dispatch a tool call with no
        // consumer (the runtime may meanwhile have retried the call).
        const clientDisconnect = new AbortController();
        reply.raw.on("close", () => {
          if (!reply.raw.writableEnded) clientDisconnect.abort();
        });
        return handleToolsCall({
          rpc,
          server,
          tenantId: request.auth.tenantId,
          managedTools,
          toolContexts: stores.toolContexts,
          urlToolContextId,
          sessionIdFromRuntimeToken,
          runtimeTokenClaims,
          requestHeaders: request.headers,
          activationTracker: stores.activationTracker,
          policyService: stores.policyService,
          requestPolicyApproval: stores.requestPolicyApproval,
          dataEncryptionSecret: app.config.DATA_ENCRYPTION_SECRET,
          clientDisconnectSignal: clientDisconnect.signal,
          logger: request.log
        });
      }

      default:
        return failure(rpc.id, -32601, `Unsupported MCP method ${rpc.method}.`);
    }
    }
  );
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
  sessionIdFromRuntimeToken: string;
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
    // `annotations.readOnlyHint` is the standard MCP tool annotation (distinct
    // from the `outputSchema` field warned about above — annotations do not
    // trip the SDK's tools/list validation drop). Codex 0.134.0+ runs tools
    // that advertise `readOnlyHint: true` concurrently instead of serially, so
    // a read-heavy turn (session_context / list_artifacts / read_text_artifact)
    // fans those reads out in parallel.
    return ok(rpc.id, {
      tools: managedToolsForRequest!.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly }
      }))
    });
  }

  // Proxy mode: apply the same enabledMcpServers policy check the managed
  // path enforces. If the active turn's runtime policy forbids this server,
  // advertise no tools rather than forwarding to the upstream — `tools/list`
  // is probed by every SDK at startup, so we return an empty list instead of
  // throwing (mirrors getVisibleManagedTools). Tool *calls* are still gated by
  // requireMcpServerAllowed in handleForwardedToolCall.
  if (sessionIdFromRuntimeToken) {
    const context = await toolContexts.findLatestActiveBySession(tenantId, sessionIdFromRuntimeToken);
    if (context) {
      const runtimePolicy = getRuntimePolicySnapshot(context);
      if (!runtimePolicy.enabledMcpServers.includes(server.id)) {
        return ok(rpc.id, { tools: [] });
      }
    }
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
  sessionIdFromRuntimeToken: string;
  runtimeTokenClaims: RuntimeTokenClaims;
  requestHeaders: Record<string, string | string[] | undefined>;
  activationTracker?: ActivationTracker;
  policyService: PolicyService;
  requestPolicyApproval: GatewayPolicyApprovalRouter;
  dataEncryptionSecret: string;
  clientDisconnectSignal?: AbortSignal;
  logger: Pick<FastifyBaseLogger, "debug" | "warn">;
}): Promise<RpcResponse> {
  const {
    rpc,
    server,
    tenantId,
    managedTools,
    toolContexts,
    urlToolContextId,
    sessionIdFromRuntimeToken,
    runtimeTokenClaims,
    requestHeaders,
    activationTracker,
    policyService,
    requestPolicyApproval,
    dataEncryptionSecret,
    clientDisconnectSignal,
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

  const policyGate: PolicyGate = { policyService, requestPolicyApproval, clientDisconnectSignal, logger };

  const response =
    server.mode === "managed"
      ? await handleManagedToolCall(
          rpc,
          tenantId,
          server.id,
          managedTools,
          toolContexts,
          urlToolContextId,
          sessionIdFromRuntimeToken,
          runtimeTokenClaims,
          policyGate
        )
      : await handleForwardedToolCall(
          rpc,
          tenantId,
          server,
          toolContexts,
          urlToolContextId,
          sessionIdFromRuntimeToken,
          runtimeTokenClaims,
          requestHeaders,
          dataEncryptionSecret,
          policyGate
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
  sessionIdFromRuntimeToken: string;
  server: McpServerRegistration;
  rpc: z.infer<typeof rpcRequestSchema>;
  response: RpcResponse;
}): Promise<void> {
  const { activationTracker, tenantId, sessionIdFromRuntimeToken, server, rpc, response } = input;
  if (!activationTracker) return;

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

/**
 * Resolves the per-turn tool-execution context for a tool call and binds it to
 * the runtime token's identity.
 *
 * Resolution order:
 *   1. toolContextId in the RPC args (primary path — Codex, Claude SDK).
 *   2. toolContextId in the MCP URL query string.
 *   3. Active session fallback — look up the latest non-expired context for the
 *      sessionId carried by the runtime token. Resilience path when a runtime
 *      omits the argument.
 *
 * SECURITY (paths 1 and 2): an arg/URL-supplied toolContextId is otherwise
 * resolved by TENANT only, which would let a same-tenant attacker substitute
 * another user's or session's context id into a tool call — for proxy mode that
 * means the gateway would sign identity headers for the substituted identity.
 * We therefore assert that the resolved context belongs to the runtime token's
 * sid + uid. Path 3 is inherently bound: it looks up by the token's sid.
 *
 * The claims are always present: the POST /mcp/:serverId handler rejects any
 * request that did not authenticate with a valid rt_* token before this
 * function is reached, so the binding is unconditional.
 */
async function handleManagedToolCall(
  rpc: z.infer<typeof rpcRequestSchema>,
  tenantId: string,
  serverId: string,
  managedTools: ManagedToolDefinition[],
  toolContexts: ToolExecutionContextStore,
  urlToolContextId: string | null,
  sessionIdFromRuntimeToken: string,
  runtimeTokenClaims: RuntimeTokenClaims,
  policyGate: PolicyGate
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

  const resolved = await resolveBoundToolContext({
    rpc,
    tenantId,
    args,
    urlToolContextId,
    sessionIdFromRuntimeToken,
    runtimeTokenClaims,
    toolContexts
  });
  if ("error" in resolved) {
    return resolved.error;
  }
  const context = resolved.context;

  // Stamp the resolved context id into the args so handlers that expect it
  // (and downstream auditing) see a consistent value.
  args.toolContextId = context.toolContextId;

  try {
    const runtimePolicy = requireMcpServerAllowed(serverId, context);
    requireManagedToolAllowed(tool.name, runtimePolicy);
    // Approval for managed tool calls is NOT enforced here. Claude gates every
    // tool call (including MCP) through canUseTool inside the sandbox, where
    // autoApproveReadOnlyTools decides whether read-only tools skip the prompt
    // — by the time the HTTP call arrives the approval already happened. For
    // Codex, Policy Center (below) is the control plane for gating MCP calls;
    // its require_approval rules pause right here at the gateway.
    //
    // Policy Center gate — records a decision and, in enforce mode, may pause for
    // human approval (require_approval) or throw PolicyBlockedError (block /
    // approval denied — surfaced as a distinct RPC error below). Severity is
    // derived from the managed tool's readOnly flag.
    await enforcePolicyCenter(policyGate, context, tool.name, serverId, {
      readOnly: tool.readOnly
    }, args);
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
    if (error instanceof PolicyBlockedError) {
      return failure(rpc.id, -32004, error.explanation);
    }
    return failure(rpc.id, -32000, getErrorMessage(error, "Tool call failed."));
  }
}

async function getVisibleManagedTools(input: {
  tenantId: string;
  serverId: string;
  managedTools: ManagedToolDefinition[];
  toolContexts: ToolExecutionContextStore;
  sessionIdFromRuntimeToken: string;
}): Promise<ManagedToolDefinition[]> {
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

async function handleForwardedToolCall(
  rpc: z.infer<typeof rpcRequestSchema>,
  tenantId: string,
  server: McpServerRegistration,
  toolContexts: ToolExecutionContextStore,
  urlToolContextId: string | null,
  sessionIdFromRuntimeToken: string,
  runtimeTokenClaims: RuntimeTokenClaims,
  requestHeaders: Record<string, string | string[] | undefined>,
  dataEncryptionSecret: string,
  policyGate: PolicyGate
): Promise<RpcResponse> {
  if (!server.upstreamUrl) {
    return failure(rpc.id, -32601, "Trusted MCP upstream is not configured.");
  }

  const params = rpc.params ?? {};
  const args =
    params.arguments && typeof params.arguments === "object"
      ? ({ ...(params.arguments as Record<string, unknown>) } satisfies Record<string, unknown>)
      : {};

  const resolved = await resolveBoundToolContext({
    rpc,
    tenantId,
    args,
    urlToolContextId,
    sessionIdFromRuntimeToken,
    runtimeTokenClaims,
    toolContexts
  });
  if ("error" in resolved) {
    return resolved.error;
  }
  const context = resolved.context;

  try {
    requireMcpServerAllowed(server.id, context);
    // Forwarded/proxy tools have no managed-tool catalog entry, so readOnly is
    // unknown (severity falls back to name-based classification) — only a
    // serverId/category rule can match them. The gate may pause for approval or
    // refuse the call.
    await enforcePolicyCenter(
      policyGate,
      context,
      String(params.name ?? ""),
      server.id,
      { readOnly: null },
      args
    );
  } catch (error) {
    if (error instanceof PolicyBlockedError) {
      return failure(rpc.id, -32004, error.explanation);
    }
    return failure(rpc.id, -32000, getErrorMessage(error, "Tool call failed."));
  }
  // The runtime token's toolContextId is a gateway concern — never forward it
  // upstream.
  const forwardArgs = { ...args };
  delete forwardArgs.toolContextId;

  return forwardRpc(
    server.upstreamUrl,
    {
      ...rpc,
      params: {
        ...params,
        arguments: forwardArgs
      }
    },
    {
      ...selectAllowlistedHeaders(requestHeaders, server.headersAllowlist),
      ...signProxyHeaders({
        userId: context.userId,
        sessionId: context.sessionId,
        runtimeId: context.runtimeId,
        secret: dataEncryptionSecret
      })
    }
  );
}
