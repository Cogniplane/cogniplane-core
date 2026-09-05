// MCP gateway.
//
// Handles JSON-RPC 2.0 traffic from the agent runtime's MCP client and
// dispatches to managed tools or proxies to upstream servers.
//
// Per-turn `toolContextId` resolution has three fallbacks — args, URL query
// param, and session-scoped lookup via the runtime token's `sid` claim.
// The deep-agents loop injects the id into args at call time; the URL
// query-param path is a defensive fallback some transports use, and the
// session-scoped lookup covers a runtime that omits the argument. All three
// must keep working — don't collapse them into one path.

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDependencies } from "../app-dependencies.js";
import { proxySignatureSecret } from "../lib/derived-secrets.js";
import { clientSafeToolErrorMessage, ToolCallError } from "../lib/tool-call-error.js";
import { signProxyHeaders } from "../lib/mcp-proxy-signature.js";
import {
  forwardRpc,
  type ForwardRpcLimits,
  rpcFailure as failure,
  rpcOk as ok,
  type McpRpcResponse as RpcResponse
} from "../lib/mcp-upstream-client.js";
import type { RuntimeTokenClaims } from "../services/auth/runtime-token.js";
import type { ApprovalStore } from "../services/auth/approval-store.js";

import type { ActivationTracker } from "../services/activation-tracker.js";
import {
  type McpServerRegistration,
  type ResolvedRuntimePolicy
} from "../services/admin-config-records.js";
import type { ManagedToolFactoryDeps } from "../services/managed-tools/factory.js";
import type { ManagedToolDefinition } from "../services/managed-tools/types.js";
import { PolicyBlockedError, type PolicyService } from "../services/policy/policy-service.js";
import { withoutPolicyApprovalMetadata } from "../services/policy/policy-approval-proof.js";
import type {
  ToolExecutionContext,
  ToolExecutionContextStore
} from "../services/auth/tool-execution-context-store.js";
import {
  enforcePolicyCenter,
  getRuntimePolicySnapshot,
  type PolicyGate
} from "../services/mcp/policy-gate.js";
import { resolveBoundToolContext } from "../services/mcp/tool-context-binder.js";
import { runGatewayAdmission } from "../services/mcp/gateway-admission.js";
import { redactSecrets } from "../services/redact-secrets.js";
import type {
  ProxyToolMetadata,
  ProxyToolMetadataCache
} from "../services/mcp/proxy-tool-metadata-cache.js";

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
  }
) {
  return {
    db: deps.db,
    dynamicConfig: deps.dynamicConfig,
    sessions: deps.sessions,
    messages: deps.messages,
    memories: deps.memories,
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
    approvals: deps.approvals,
    readRuntimeFile: extras.readRuntimeFile,
    statRuntimeFile: extras.statRuntimeFile,
    writeRuntimeFile: extras.writeRuntimeFile,
    runtimeTokenSecret: extras.runtimeTokenSecret,
    proxyToolMetadataCache: deps.proxyToolMetadataCache,
    activationTracker: deps.activationTracker
  };
}

export type McpRouteStores = Omit<ManagedToolFactoryDeps, "dynamicConfig"> & {
  dynamicConfig: Pick<AppDependencies["dynamicConfig"], "getMcpServer" | "listSkills">;
  toolContexts: Pick<ToolExecutionContextStore, "require" | "findLatestActiveBySession">;
  managedToolFactoryRegistry: AppDependencies["managedToolFactoryRegistry"];
  managedToolCatalog: AppDependencies["managedToolCatalog"];
  policyService: Pick<PolicyService, "gateAction" | "evaluate">;
  approvals: Pick<AppDependencies["approvals"], "get">;
  runtimeTokenSecret: string;
  proxyToolMetadataCache: AppDependencies["proxyToolMetadataCache"];
  activationTracker?: Pick<ActivationTracker, "recordFailure" | "recordInvocation" | "recordSkillInvocationsForTool">;
};

export async function registerMcpRoutes(app: FastifyInstance, stores: McpRouteStores): Promise<void> {
  const managedTools = stores.managedToolFactoryRegistry.createDefinitions({
    db: stores.db,
    dynamicConfig: stores.dynamicConfig,
    sessions: stores.sessions,
    messages: stores.messages,
    memories: stores.memories,
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

    const admission = await runGatewayAdmission({
      authorizationHeader: request.headers.authorization,
      rpcId: rpc.id,
      rpcMethod: rpc.method,
      serverId,
      tenantId: request.auth.tenantId,
      remoteAddress: request.raw.socket.remoteAddress,
      stores,
      logger: request.log
    });
    if (!admission.ok) {
      reply.code(admission.statusCode);
      return admission.body;
    }
    const runtimeTokenClaims = admission.claims;
    const sessionIdFromRuntimeToken = runtimeTokenClaims.sid;
    const tenantId = runtimeTokenClaims.tid;

    let server: Awaited<ReturnType<typeof stores.dynamicConfig.getMcpServer>>;
    try {
      server = await stores.dynamicConfig.getMcpServer(tenantId, serverId);
    } catch (error) {
      request.log.warn({ err: error, serverId, tenantId }, "MCP server lookup failed");
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

    // Transport limits for proxy-mode upstreams. A proxy upstream is a third
    // party on the critical path of a turn: without a timeout it can hold the
    // turn open until the watchdog fires, and without a byte cap it can OOM
    // the shared backend with one oversized body.
    const upstreamLimits: ForwardRpcLimits = {
      timeoutMs: app.config.MCP_UPSTREAM_TIMEOUT_MS,
      maxResponseBytes: app.config.MCP_UPSTREAM_MAX_RESPONSE_BYTES,
      // The client-visible RPC error is a fixed string; this is where the real
      // transport failure lands.
      logger: request.log,
      // Integration tests run a real upstream on 127.0.0.1, which the
      // first-hop private-address check correctly refuses. Vitest sets
      // NODE_ENV=test; production never has it, so the guard is unconditional
      // where it matters. Keyed off the environment rather than a config flag
      // so there is no operator-settable switch that can disable it.
      allowPrivateUpstreamForTests: process.env.NODE_ENV === "test"
    };

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
          tenantId,
          managedTools,
          toolContexts: stores.toolContexts,
          sessionIdFromRuntimeToken,
          listingId: runtimeTokenClaims.jti,
          proxyToolMetadataCache: stores.proxyToolMetadataCache,
          upstreamLimits,
          logger: request.log
        });

      case "tools/call": {
        return handleToolsCall({
          rpc,
          server,
          tenantId,
          managedTools,
          toolContexts: stores.toolContexts,
          urlToolContextId,
          sessionIdFromRuntimeToken,
          runtimeTokenClaims,
          activationTracker: stores.activationTracker,
          policyService: stores.policyService,
          approvals: stores.approvals,
          proxyToolMetadataCache: stores.proxyToolMetadataCache,
          upstreamSignatureSecret: proxySignatureSecret(
            app.config.DATA_ENCRYPTION_SECRET,
            app.config.MCP_UPSTREAM_SIGNING_SECRET
          ),
          upstreamLimits,
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
  toolContexts: Pick<ToolExecutionContextStore, "require" | "findLatestActiveBySession">;
  sessionIdFromRuntimeToken: string;
  listingId: string;
  proxyToolMetadataCache: ProxyToolMetadataCache;
  upstreamLimits: ForwardRpcLimits;
  logger: Pick<FastifyBaseLogger, "debug">;
}): Promise<RpcResponse> {
  const {
    rpc,
    server,
    tenantId,
    managedTools,
    toolContexts,
    sessionIdFromRuntimeToken,
    listingId,
    proxyToolMetadataCache,
    upstreamLimits,
    logger
  } = input;
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
    // `annotations.readOnlyHint` lets clients run read-only tools concurrently,
    // so a read-heavy turn
    // (session_context / list_artifacts / read_text_artifact) can fan those
    // reads out in parallel.
    return ok(rpc.id, {
      tools: managedToolsForRequest!.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
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

  const response = await forwardRpc(
    server.upstreamUrl,
    rpc,
    { "X-Forwarded-By": "cogniplane-core" },
    undefined,
    // serverId, not the URL path, is what tells two upstreams on one origin
    // apart in the failure log — see logSafeUrl.
    { ...upstreamLimits, serverId: server.id }
  );

  if (
    !response.error &&
    response.result &&
    typeof response.result === "object" &&
    "tools" in response.result &&
    Array.isArray((response.result as { tools?: unknown }).tools)
  ) {
    // The runtime token's unique jti stays constant across this client's
    // pagination sequence. It isolates staging from other sessions even when
    // their upstream cursors happen to have the same value. An error or
    // malformed body skips this call and keeps the last complete listing.
    const result = response.result as { tools: readonly ProxyToolMetadata[]; nextCursor?: unknown };
    const requestCursor = (rpc.params as { cursor?: unknown } | undefined)?.cursor;
    proxyToolMetadataCache.recordToolsPage(tenantId, server.id, listingId, {
      requestCursor: typeof requestCursor === "string" ? requestCursor : null,
      nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
      tools: result.tools
    });
  }

  return response;
}

async function handleToolsCall(input: {
  rpc: z.infer<typeof rpcRequestSchema>;
  server: McpServerRegistration;
  tenantId: string;
  managedTools: ManagedToolDefinition[];
  toolContexts: Pick<ToolExecutionContextStore, "require" | "findLatestActiveBySession">;
  urlToolContextId: string | null;
  sessionIdFromRuntimeToken: string;
  runtimeTokenClaims: RuntimeTokenClaims;
  activationTracker?: Pick<ActivationTracker, "recordFailure" | "recordInvocation" | "recordSkillInvocationsForTool">;
  policyService: Pick<PolicyService, "gateAction" | "evaluate">;
  approvals: Pick<ApprovalStore, "get">;
  proxyToolMetadataCache: ProxyToolMetadataCache;
  upstreamSignatureSecret: string;
  upstreamLimits: ForwardRpcLimits;
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
    activationTracker,
    policyService,
    approvals,
    proxyToolMetadataCache,
    upstreamSignatureSecret,
    upstreamLimits,
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

  const policyGate: PolicyGate = { policyService, approvals, logger };
  let messageId: string | null = null;
  const captureContext = (context: ToolExecutionContext): void => {
    messageId = context.messageId;
  };

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
          policyGate,
          logger,
          captureContext
        )
      : await handleForwardedToolCall(
          rpc,
          tenantId,
          server,
          toolContexts,
          urlToolContextId,
          sessionIdFromRuntimeToken,
          runtimeTokenClaims,
          upstreamSignatureSecret,
          upstreamLimits,
          policyGate,
          proxyToolMetadataCache,
          logger,
          captureContext
        );

  await recordToolCallTelemetry({
    activationTracker,
    tenantId,
    sessionIdFromRuntimeToken,
    server,
    rpc,
    response,
    messageId
  });

  // Strip credentials from a successful tool result at the gateway boundary,
  // BEFORE it reaches the runtime. The transcript/tool-result stores already
  // run redactSecrets(), but the LangGraph result is separately persisted into
  // the durable checkpointer as a ToolMessage and restored into model context
  // on later turns — a path the store-layer redaction never touches. Redacting
  // here covers both: a managed tool echoing a token or a proxy upstream
  // returning auth material can't land a live credential in checkpoint state.
  // Errors carry only a message (already generic) and are left untouched.
  //
  // The managed path also redacts its handler result before serialising it
  // into content[0].text, because key-based redaction cannot reach a value
  // that is already inside a JSON string. This pass is what covers the
  // *forwarded* path, whose result never goes through that function, and it
  // is idempotent over the managed one.
  if (response.error === undefined && response.result !== undefined) {
    return { ...response, result: redactSecrets(response.result) };
  }

  return response;
}

/**
 * Record server activity and credit skills offered to the bound message.
 * The runtime token supplies session identity; the validated tool context
 * supplies turn identity. Availability metadata links tool names to skills.
 */
async function recordToolCallTelemetry(input: {
  activationTracker?: Pick<ActivationTracker, "recordFailure" | "recordInvocation" | "recordSkillInvocationsForTool">;
  tenantId: string;
  sessionIdFromRuntimeToken: string;
  server: McpServerRegistration;
  rpc: z.infer<typeof rpcRequestSchema>;
  response: RpcResponse;
  messageId: string | null;
}): Promise<void> {
  const { activationTracker, tenantId, sessionIdFromRuntimeToken, server, rpc, response, messageId } = input;
  if (!activationTracker) return;

  const toolName = typeof rpc.params?.name === "string" ? (rpc.params.name as string) : null;
  const eventCtx = { tenantId, sessionId: sessionIdFromRuntimeToken, messageId };

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
 *   1. toolContextId in the RPC args (primary path — injected at call time
 *      by the deep-agents loop).
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
  toolContexts: Pick<ToolExecutionContextStore, "require" | "findLatestActiveBySession">,
  urlToolContextId: string | null,
  sessionIdFromRuntimeToken: string,
  runtimeTokenClaims: RuntimeTokenClaims,
  policyGate: PolicyGate,
  logger: Pick<FastifyBaseLogger, "debug" | "warn">,
  captureContext: (context: ToolExecutionContext) => void
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
  captureContext(context);

  // Stamp the resolved context id into the args so handlers that expect it
  // (and downstream auditing) see a consistent value.
  args.toolContextId = context.toolContextId;

  try {
    const runtimePolicy = requireMcpServerAllowed(serverId, context);
    requireManagedToolAllowed(tool.name, runtimePolicy);
    // Native approval for managed tool calls is NOT enforced here. The
    // deep-agents HITL interceptor gates every tool call (including MCP)
    // in-process before the HTTP request is made, where
    // autoApproveReadOnlyTools decides whether read-only tools skip the prompt
    // — by the time the call arrives the native approval already happened.
    // Policy Center (below) remains the gateway-side enforcement point. Its
    // require_approval rules arrive with the graph's call-bound proof.
    //
    // Policy Center gate — records a decision and, in enforce mode, verifies
    // approval proof or throws PolicyBlockedError (block / approval denied —
    // surfaced as a distinct RPC error below). Severity is derived from the
    // managed tool's readOnly flag.
    await enforcePolicyCenter(
      policyGate,
      context,
      tool.name,
      serverId,
      { readOnly: tool.readOnly },
      args,
      // Category is the tool's bound domain, not the URL serverId — so a
      // `categories` policy rule matches the tool's true domain even if the
      // call arrived through a different enabled managed server's URL.
      tool.category ?? serverId
    );
    const handlerArgs = withoutPolicyApprovalMetadata(args);
    const rawResult = await tool.handler({
      context,
      arguments: handlerArgs
    });

    // Redact BEFORE serialising, not after. The outer gateway-boundary pass
    // (handleToolsCall) runs redactSecrets over the finished envelope, and
    // walking a string only applies the *pattern* rules — `sk-ant-…`,
    // `Bearer …`, `rt_…`. The key-based rules (`{"password": "hunter2"}`,
    // `{"api_key": "abc123"}` with no recognisable prefix) match object keys,
    // and once the value is inside content[0].text there are no keys left to
    // match. That left the text channel — the one the model reads and the
    // checkpointer persists — holding a live credential while
    // structuredContent showed [REDACTED]. Redacting the object first means
    // both channels are built from the same cleaned value.
    const result = redactSecrets(rawResult);

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
    // The raw error is logged here and only here: the RPC error the model reads
    // is deliberately generic unless the throw was written for it.
    logger.warn({ error, serverId, toolName }, "Managed tool call failed");
    return failure(rpc.id, -32000, clientSafeToolErrorMessage(error, "Tool call failed."));
  }
}

async function getVisibleManagedTools(input: {
  tenantId: string;
  serverId: string;
  managedTools: ManagedToolDefinition[];
  toolContexts: Pick<ToolExecutionContextStore, "require" | "findLatestActiveBySession">;
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
    throw new ToolCallError(
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
    throw new ToolCallError(
      `Managed tool ${toolName} is not allowed by runtime policy ${runtimePolicy.id}.`
    );
  }
}

async function handleForwardedToolCall(
  rpc: z.infer<typeof rpcRequestSchema>,
  tenantId: string,
  server: McpServerRegistration,
  toolContexts: Pick<ToolExecutionContextStore, "require" | "findLatestActiveBySession">,
  urlToolContextId: string | null,
  sessionIdFromRuntimeToken: string,
  runtimeTokenClaims: RuntimeTokenClaims,
  upstreamSignatureSecret: string,
  upstreamLimits: ForwardRpcLimits,
  policyGate: PolicyGate,
  proxyToolMetadataCache: ProxyToolMetadataCache,
  logger: Pick<FastifyBaseLogger, "debug" | "warn">,
  captureContext: (context: ToolExecutionContext) => void
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
  captureContext(context);

  try {
    requireMcpServerAllowed(server.id, context);
    const toolName = String(params.name ?? "");
    const isReadOnly = proxyToolMetadataCache.isReadOnly(tenantId, server.id, toolName) ?? null;
    await enforcePolicyCenter(
      policyGate,
      context,
      toolName,
      server.id,
      { readOnly: isReadOnly },
      args
    );
  } catch (error) {
    if (error instanceof PolicyBlockedError) {
      return failure(rpc.id, -32004, error.explanation);
    }
    logger.warn(
      { error, serverId: server.id, toolName: String(params.name ?? "") },
      "Forwarded tool call failed"
    );
    return failure(rpc.id, -32000, clientSafeToolErrorMessage(error, "Tool call failed."));
  }
  // The runtime token's toolContextId is a gateway concern — never forward it
  // upstream.
  const forwardArgs = withoutPolicyApprovalMetadata(args);
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
    signProxyHeaders({
      userId: context.userId,
      sessionId: context.sessionId,
      runtimeId: context.runtimeId,
      secret: upstreamSignatureSecret
    }),
    undefined,
    { ...upstreamLimits, serverId: server.id }
  );
}
