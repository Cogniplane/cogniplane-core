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
import { fetch as undiciFetch } from "undici";
import { z } from "zod";

import {
  POLICY_TURN_CONTEXTS,
  type PolicySeverity,
  type PolicyTurnContext
} from "@cogniplane/shared-types";

import type {
  PolicyApprovalDisposition,
  PolicyApprovalRouteInput,
  RuntimeApprovalKind
} from "../runtime-contracts.js";
import type { AppDependencies } from "../app-dependencies.js";
import { cidrAllowlistAllows, parseCidrAllowlist } from "../lib/cidr-allowlist.js";
import { resolveEgressClientIp } from "../lib/egress-client-ip.js";
import { getErrorMessage } from "../lib/http-errors.js";
import { signProxyHeaders } from "../lib/mcp-proxy-signature.js";
import { ssrfSafeAgent } from "../lib/url-validation.js";
import { verifyRuntimeToken, type RuntimeTokenClaims } from "../services/auth/runtime-token.js";

import type { ActivationTracker } from "../services/activation-tracker.js";
import {
  parseRuntimePolicySnapshot,
  type McpServerRegistration,
  type ResolvedRuntimePolicy
} from "../services/admin-config-records.js";
import type { ManagedToolDefinition } from "../services/managed-tools/types.js";
import { classifyToolSeverity } from "../services/tool-classification.js";
import { PolicyBlockedError, type PolicyService } from "../services/policy/policy-service.js";
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

// Best-effort audit row for gateway-level refusals (egress controls). A
// failed audit write must never change the gating outcome — the 403 already
// protects the platform; losing the evidence row is the lesser failure.
async function recordGatewayRejection(
  stores: Pick<McpRouteStores, "auditEvents">,
  reason: string,
  ctx: {
    claims: RuntimeTokenClaims;
    ipAddress: string | null;
    serverId: string;
    rpcMethod: string;
  },
  log: FastifyBaseLogger
): Promise<void> {
  try {
    await stores.auditEvents.create({
      tenantId: ctx.claims.tid,
      sessionId: ctx.claims.sid,
      userId: ctx.claims.uid,
      type: "mcp.gateway.rejected",
      payload: { reason, serverId: ctx.serverId, rpcMethod: ctx.rpcMethod },
      ipAddress: ctx.ipAddress
    });
  } catch (err) {
    log.warn({ err, reason, serverId: ctx.serverId }, "failed to persist mcp.gateway.rejected audit event");
  }
}

// Routes a Policy Center require_approval to whichever adapter owns the
// session. Returns the human disposition, or null when no adapter could host
// the approval (no active turn) — the gateway then degrades to a deny.
export type GatewayPolicyApprovalRouter = (
  input: PolicyApprovalRouteInput
) => Promise<PolicyApprovalDisposition | null>;

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

  app.post("/mcp/:serverId", async (request, reply) => {
    const parsed = rpcRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return failure(undefined, -32600, "Invalid JSON-RPC request.");
    }

    const serverId = mcpRouteParamsSchema.parse(request.params).serverId;
    const rpc = parsed.data;

    // The MCP gateway exists for the sandboxed runtime alone — every request,
    // including initialize, must carry a valid session-scoped rt_* token
    // (Authorization header for Claude; ?token= for Codex, whose Streamable
    // HTTP transport drops the header on the initialize POST). User JWTs and
    // dev headers are deliberately rejected: resolveBoundToolContext binds
    // caller-supplied toolContextIds to these claims, so admitting non-runtime
    // callers would let a same-tenant user substitute another user's context
    // id and execute tools under that identity. We re-verify the token here
    // rather than threading claims through request.auth so the rest of the
    // API surface stays unchanged.
    const runtimeTokenClaims = resolveRuntimeTokenClaims(
      request.headers.authorization,
      request.url,
      stores.runtimeTokenSecret
    );
    if (!runtimeTokenClaims) {
      request.log.warn(
        { serverId, rpcMethod: rpc.method, tenantId: request.auth.tenantId },
        "MCP gateway 401: request authenticated without a valid runtime token (rt_*)"
      );
      reply.code(401);
      return failure(rpc.id, -32000, "The MCP gateway requires a valid runtime token (rt_*).");
    }
    const sessionIdFromRuntimeToken = runtimeTokenClaims.sid;

    // Same egress controls as the LLM proxy (llm-proxy-core.ts). The CIDR
    // allowlist (E2B_EGRESS_CIDRS) is dormant unless configured — E2B does not
    // publish egress ranges — so the per-runtime IP pin is the operative
    // control: the first gateway/proxy call for a runtimeId records the peer
    // IP, and a leaked rt_* token replayed from any other host is refused for
    // the rest of its TTL. The pin store is shared with /llm/*, so whichever
    // route the sandbox hits first establishes the pin for both.
    //
    // The pinned IP must be the real sandbox peer, not an intermediate proxy.
    // Behind Cloudflare (CDN → ALB → backend) `request.ip` resolves to a
    // rotating Cloudflare edge IP, so resolveEgressClientIp prefers the
    // origin client from CF-Connecting-IP when the request crossed a trusted
    // proxy hop, falling back to request.ip otherwise (see egress-client-ip.ts).
    const ipAddress = resolveEgressClientIp(request);
    if (stores.egressAllowlist && !cidrAllowlistAllows(stores.egressAllowlist, ipAddress ?? "")) {
      await recordGatewayRejection(stores, "egress_ip_not_allowed", {
        claims: runtimeTokenClaims,
        ipAddress,
        serverId,
        rpcMethod: rpc.method
      }, request.log);
      reply.code(403);
      return failure(rpc.id, -32000, "Egress IP is not allowed.");
    }
    if (ipAddress) {
      const pinResult = stores.egressIpPins.checkAndPin(runtimeTokenClaims.rid, ipAddress);
      if (pinResult.kind === "mismatch") {
        await recordGatewayRejection(stores, "egress_ip_mismatch", {
          claims: runtimeTokenClaims,
          ipAddress,
          serverId,
          rpcMethod: rpc.method
        }, request.log);
        // Log expected/observed at warn so an operator investigating a leak
        // can see both — the audit payload deliberately omits the expected IP
        // to avoid storing per-runtime peer addresses in a long-retention
        // table (mirrors the LLM proxy).
        request.log.warn(
          {
            runtimeId: runtimeTokenClaims.rid,
            expectedIp: pinResult.expectedIp,
            observedIp: pinResult.observedIp
          },
          "MCP gateway egress IP mismatch — refusing rt_* call from unexpected peer"
        );
        reply.code(403);
        return failure(rpc.id, -32000, "Egress IP mismatch.");
      }
    }

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
async function resolveBoundToolContext(input: {
  rpc: z.infer<typeof rpcRequestSchema>;
  tenantId: string;
  args: Record<string, unknown>;
  urlToolContextId: string | null;
  sessionIdFromRuntimeToken: string;
  runtimeTokenClaims: RuntimeTokenClaims;
  toolContexts: ToolExecutionContextStore;
}): Promise<{ context: ToolExecutionContext } | { error: RpcResponse }> {
  const { rpc, tenantId, args, urlToolContextId, sessionIdFromRuntimeToken, runtimeTokenClaims, toolContexts } = input;
  const argToolContextId = typeof args.toolContextId === "string" ? args.toolContextId : "";

  let context: ToolExecutionContext | null;
  let suppliedByCaller = false;

  try {
    if (argToolContextId) {
      context = await toolContexts.require(tenantId, argToolContextId);
      suppliedByCaller = true;
    } else if (urlToolContextId) {
      context = await toolContexts.require(tenantId, urlToolContextId);
      suppliedByCaller = true;
    } else {
      context = await toolContexts.findLatestActiveBySession(tenantId, sessionIdFromRuntimeToken);
    }
  } catch (error) {
    return { error: failure(rpc.id, -32000, getErrorMessage(error, "Tool context lookup failed.")) };
  }

  if (!context) {
    return { error: failure(rpc.id, -32602, "toolContextId is required.") };
  }

  // Bind a caller-supplied context id to the authenticated runtime token so a
  // same-tenant caller cannot substitute another user's/session's context.
  if (suppliedByCaller) {
    if (context.sessionId !== runtimeTokenClaims.sid || context.userId !== runtimeTokenClaims.uid) {
      return { error: failure(rpc.id, -32000, "Tool context does not belong to the authenticated runtime session.") };
    }
  }

  return { context };
}

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

function getRuntimePolicySnapshot(context: ToolExecutionContext): ResolvedRuntimePolicy {
  return parseRuntimePolicySnapshot(context.metadata.runtimePolicy, {
    toolContextId: context.toolContextId
  });
}

// Dependencies the Policy Center hook needs at the tool-call choke point.
type PolicyGate = {
  policyService: PolicyService;
  requestPolicyApproval: GatewayPolicyApprovalRouter;
  /** Aborts when the gateway's HTTP response dies before the tool call returns. */
  clientDisconnectSignal?: AbortSignal;
  logger: Pick<FastifyBaseLogger, "warn">;
};

/**
 * Derive the policy severity for a tool action.
 *
 * Managed tools carry an authoritative `readOnly` boolean (from the catalog):
 * read-only → `read_only`, otherwise it's a state-changing call → `file_change`.
 * We deliberately do NOT name-classify managed tools — `classifyToolSeverity`
 * only knows Claude SDK native names (Read/Write/Bash/…), so a managed write
 * like `github_write_file` would mis-classify as `command_execution` and a
 * `file_change` rule would silently never match it.
 *
 * Forwarded/proxy tools have no catalog entry (`readOnly === null`), so their
 * severity is genuinely unknown — name-based classification is the only signal
 * available and is used as a best-effort fallback.
 */
export function deriveActionSeverity(
  toolName: string,
  readOnly: boolean | null
): PolicySeverity {
  if (readOnly === true) return "read_only";
  if (readOnly === false) return "file_change";
  return classifyToolSeverity(toolName);
}

// Map the policy severity onto the approval `kind` the SSE prompt + approvals
// row use. A read-only or state-changing tool surfaces as a "file_change"
// approval (it isn't a shell command); command_execution maps through directly.
function severityToApprovalKind(severity: PolicySeverity): RuntimeApprovalKind {
  return severity === "command_execution" ? "command_execution" : "file_change";
}

// Read a policy turn-context off the tool-execution context metadata, validating
// against the enum. Anything unexpected (missing, stale, malformed) degrades to
// null so the dimension acts as "no constraint" instead of throwing.
function parsePolicyTurnContext(value: unknown): PolicyTurnContext | null {
  return typeof value === "string" && (POLICY_TURN_CONTEXTS as readonly string[]).includes(value)
    ? (value as PolicyTurnContext)
    : null;
}

/**
 * Policy Center gate at the runtime choke point. Evaluates the proposed action
 * against the tenant's rules, records a decision as evidence (audit +
 * policy_decision), and either:
 *   - proceeds (returns) — for allow / monitor mode / no-match; or
 *   - routes a human approval for an enforce-mode `require_approval`, holding
 *     this gateway HTTP response open until the decision lands (approve →
 *     proceed, reject/expire → throw); or
 *   - throws {@link PolicyBlockedError} for an enforce-mode `block`.
 *
 * Whether a gating rule actually gates is the tenant's `policyEnforcementMode`,
 * read from the runtime-policy snapshot already on the tool-execution context.
 */
// The signal that varies per managed/forwarded path and isn't on the
// ToolExecutionContext: the tool's read/write flag (drives severity). Null for
// forwarded tools (no catalog entry → name-based severity classification).
type PolicyToolFacts = {
  readOnly: boolean | null;
};

async function enforcePolicyCenter(
  gate: PolicyGate,
  context: ToolExecutionContext,
  toolName: string,
  serverId: string,
  facts: PolicyToolFacts,
  args: Record<string, unknown>
): Promise<void> {
  const severity = deriveActionSeverity(toolName, facts.readOnly);
  // Turn context is snapshotted into the tool-execution context at creation time
  // (see sse-stream-writer / scheduler), so the hot path reads it with no extra
  // DB lookup. A malformed snapshot degrades to null ("no constraint").
  const turnContext = parsePolicyTurnContext(context.metadata.turnContext);
  // The tenant-level monitor/enforce switch rides on the runtime-policy snapshot
  // already on the context — no extra DB call.
  const enforcementMode = getRuntimePolicySnapshot(context).policyEnforcementMode;
  await gate.policyService.gateAction({
    tenantId: context.tenantId,
    sessionId: context.sessionId,
    userId: context.userId,
    runtimeId: context.runtimeId,
    toolName,
    // The MCP server the tool is hosted on, recorded as `category` (== serverId).
    category: serverId,
    severity,
    serverId,
    turnContext,
    enforcementMode,
    // `toolContextId` is stamped into args by the gateway, not supplied by the
    // model — exclude it so the evidence snapshot reflects the caller's real
    // argument set.
    actionSnapshot: {
      argumentKeys: Object.keys(args).filter((key) => key !== "toolContextId")
    },
    approvalRouter: async (request) => {
      const disposition = await gate.requestPolicyApproval({
        tenantId: request.tenantId,
        sessionId: request.sessionId ?? "",
        userId: request.userId ?? "",
        runtimeId: request.runtimeId,
        toolName: request.toolName,
        serverId: request.serverId,
        kind: severityToApprovalKind(request.severity ?? severity),
        explanation: request.explanation,
        signal: gate.clientDisconnectSignal
      });
      if (disposition === null) {
        // No adapter could host the approval (no active turn) — deny.
        gate.logger.warn(
          { toolName, serverId, sessionId: context.sessionId },
          "policy require_approval: no runtime adapter to host approval — denying"
        );
        return "reject";
      }
      return disposition;
    }
  });
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

/**
 * Picks the incoming request headers named in the MCP server's
 * `headersAllowlist` so they can be forwarded to the proxy upstream. Header
 * names are matched case-insensitively (Fastify lower-cases incoming header
 * keys). Two classes of header are reserved and dropped regardless of the
 * allowlist:
 *   - The framework's own signed identity headers (`X-Framework-*`), which are
 *     set separately and take priority so a caller can never spoof them.
 *   - Inbound credential headers. The request that reaches `/mcp` carries the
 *     gateway runtime token (`Authorization: Bearer rt_*`) plus any session
 *     cookies; reflecting those to a third-party proxy upstream would hand it a
 *     gateway credential it could replay against `/mcp` until expiry. These are
 *     NEVER forwardable, even if an admin lists them in `headersAllowlist`.
 */
export function selectAllowlistedHeaders(
  requestHeaders: Record<string, string | string[] | undefined>,
  allowlist: string[]
): Record<string, string> {
  const reservedLower = new Set(
    [
      "x-framework-user-id",
      "x-framework-session-id",
      "x-framework-runtime-id",
      "x-framework-timestamp",
      "x-framework-signature",
      // Inbound credentials — must never leak to a proxy upstream.
      "authorization",
      "proxy-authorization",
      "cookie",
      "x-api-key"
    ]
  );
  const selected: Record<string, string> = {};
  for (const name of allowlist) {
    const lower = name.toLowerCase();
    if (reservedLower.has(lower)) continue;
    const value = requestHeaders[lower];
    const resolved = Array.isArray(value) ? value[0] : value;
    if (typeof resolved === "string") {
      selected[name] = resolved;
    }
  }
  return selected;
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
 * Extracts the full claims from a runtime token (rt_*) on the incoming request,
 * checking the Authorization header then the `?token=` query param.
 *
 * The auth middleware already verified this token before the handler ran;
 * re-verifying here keeps the claim extraction localised to MCP routes instead
 * of widening `request.auth` for every endpoint. Callers use `sid` for the
 * session-scoped context fallback/telemetry and `sid` + `uid` to bind a
 * caller-supplied toolContextId to the authenticated identity.
 */
function resolveRuntimeTokenClaims(
  authHeader: string | string[] | undefined,
  requestUrl: string,
  secret: string
): RuntimeTokenClaims | null {
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
  return result.kind === "valid" ? result.claims : null;
}
