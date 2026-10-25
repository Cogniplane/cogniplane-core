// MCP gateway.
//
// Handles JSON-RPC 2.0 traffic from the agent runtime's MCP client and
// dispatches to managed tools or proxies to upstream servers.
//
// The gateway resolves the per-turn `toolContextId` from four sources, in this
// order. The deep-agents loop sends the id and any approval proof in the
// request's trusted `params._meta` entry (services/mcp/invocation-metadata.ts).
// Older callers put the id in the args or in the URL query param. When none of
// these is present, the gateway looks up the latest context of the session in
// the runtime token's `sid` claim. Keep all four paths. Do not collapse them
// into one. The gateway reads an approval proof from `_meta` only.

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AppDependencies } from "../app-dependencies.js";
import { clientSafeToolErrorMessage, ToolCallError } from "../lib/tool-call-error.js";
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
import type { ManagedToolApproval, ManagedToolDefinition } from "../services/managed-tools/types.js";
import { PolicyBlockedError, type PolicyService } from "../services/policy/policy-service.js";
import { AdminConfigError } from "../services/admin-config-error.js";
import { MemberMcpAccessError } from "../services/member-mcp-credential-store.js";
import { withoutPolicyApprovalMetadata } from "../services/policy/policy-approval-proof.js";
import {
  readInvocationMetadata,
  withoutInvocationMetadata,
  type McpInvocationMetadata
} from "../services/mcp/invocation-metadata.js";
import type {
  ToolExecutionContext,
  ToolExecutionContextStore
} from "../services/auth/tool-execution-context-store.js";
import type { IntegrationRegistryService } from "../services/integrations/integration-registry-service.js";
import {
  enforcePolicyCenter,
  getRuntimePolicySnapshot,
  type PolicyGate,
  type PolicyGateOutcome
} from "../services/mcp/policy-gate.js";
import { resolveBoundToolContext } from "../services/mcp/tool-context-binder.js";
import { forwardSignedProxyRpc, proxySigningSecret, proxyUpstreamLimits } from "../services/mcp/proxy-forward.js";
import { runGatewayAdmission } from "../services/mcp/gateway-admission.js";
import {
  scrubUpstreamCredential,
  scrubUpstreamCredentialValues
} from "../services/mcp/scrub-upstream-credential.js";
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
    artifactMaxBytes: number;
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
    jiraConnections: deps.jiraConnectionService,
    piiProtection: deps.piiProtection,
    managedToolFactoryRegistry: deps.managedToolFactoryRegistry,
    managedToolCatalog: deps.managedToolCatalog,
    policyService: deps.policyService,
    approvals: deps.approvals,
    readRuntimeFile: extras.readRuntimeFile,
    statRuntimeFile: extras.statRuntimeFile,
    writeRuntimeFile: extras.writeRuntimeFile,
    projectFiles: deps.projectFiles,
    artifactMaxBytes: extras.artifactMaxBytes,
    limits: deps.limits,
    runtimeTokenSecret: extras.runtimeTokenSecret,
    proxyToolMetadataCache: deps.proxyToolMetadataCache,
    activationTracker: deps.activationTracker,
    integrationToolCalls: deps.integrationRegistry
  };
}

export type McpRouteStores = Omit<ManagedToolFactoryDeps, "dynamicConfig"> & {
  dynamicConfig: Pick<AppDependencies["dynamicConfig"], "getMcpServerForUser" | "listSkills">;
  toolContexts: Pick<ToolExecutionContextStore, "require" | "findLatestActiveBySession">;
  managedToolFactoryRegistry: AppDependencies["managedToolFactoryRegistry"];
  managedToolCatalog: AppDependencies["managedToolCatalog"];
  policyService: Pick<PolicyService, "gateAction" | "evaluate">;
  approvals: Pick<AppDependencies["approvals"], "get" | "consume">;
  runtimeTokenSecret: string;
  proxyToolMetadataCache: AppDependencies["proxyToolMetadataCache"];
  activationTracker?: Pick<ActivationTracker, "recordFailure" | "recordInvocation" | "recordSkillInvocationsForTool">;
  // Checks an integration tool call against live toggles and the turn's account.
  integrationToolCalls: Pick<IntegrationRegistryService, "checkToolCall">;
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
    jiraConnections: stores.jiraConnections,
    piiProtection: stores.piiProtection,
    readRuntimeFile: stores.readRuntimeFile,
    statRuntimeFile: stores.statRuntimeFile,
    writeRuntimeFile: stores.writeRuntimeFile,
    projectFiles: stores.projectFiles,
    artifactMaxBytes: app.config.ARTIFACT_MAX_UPLOAD_BYTES,
    limits: stores.limits
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

    let server: Awaited<ReturnType<typeof stores.dynamicConfig.getMcpServerForUser>>;
    try {
      server = await stores.dynamicConfig.getMcpServerForUser(tenantId, serverId, runtimeTokenClaims.uid);
    } catch (error) {
      if (!(error instanceof AdminConfigError || error instanceof MemberMcpAccessError)) {
        request.log.error({ err: error, serverId, tenantId }, "MCP server lookup failed");
        reply.code(500);
        return failure(rpc.id, -32603, "Internal error.");
      }
      request.log.warn({ serverId, tenantId }, "MCP server unavailable for member");
      reply.code(403);
      return failure(rpc.id, -32000, "MCP server unavailable.");
    }
    if (server.credentialScope === "personal" && rpc.method === "initialize") {
      const context = await stores.toolContexts.findLatestActiveBySession(tenantId, sessionIdFromRuntimeToken);
      if (context && (context.tenantId !== runtimeTokenClaims.tid ||
          context.sessionId !== runtimeTokenClaims.sid || context.userId !== runtimeTokenClaims.uid ||
          context.runtimeId !== runtimeTokenClaims.rid ||
          !matchesBoundServerSource(server, context))) {
        reply.code(403);
        return failure(rpc.id, -32000, "MCP server changed during this turn.");
      }
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
    const upstreamLimits = proxyUpstreamLimits(app.config, request.log);

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
          runtimeTokenClaims,
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
          upstreamSignatureSecret: proxySigningSecret(app.config),
          upstreamLimits,
          integrationToolCalls: stores.integrationToolCalls,
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

function proxyMetadataScope(server: McpServerRegistration, userId: string): string {
  return JSON.stringify([server.hash, server.credentialBindingId ?? "",
    server.credentialScope === "personal" ? userId : "organization",
    server.credentialScope === "personal" ? server.credentialVersion ?? null : null]);
}

function matchesBoundServerSource(server: McpServerRegistration, context: ToolExecutionContext): boolean {
  const sources = context.metadata.mcpServerSources;
  if (!Array.isArray(sources)) return server.credentialScope !== "personal";
  const source = sources.find((item): item is { id: string; hash: string; credentialVersion?: number | null } =>
    isPlainObject(item) && item.id === server.id && typeof item.hash === "string");
  if (!source) return false;
  return source.hash === server.hash && (server.credentialScope !== "personal" ||
    source.credentialVersion === server.credentialVersion);
}

async function handleToolsList(input: {
  rpc: z.infer<typeof rpcRequestSchema>;
  server: McpServerRegistration;
  tenantId: string;
  managedTools: ManagedToolDefinition[];
  toolContexts: Pick<ToolExecutionContextStore, "require" | "findLatestActiveBySession">;
  sessionIdFromRuntimeToken: string;
  runtimeTokenClaims: RuntimeTokenClaims;
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
    runtimeTokenClaims,
    listingId,
    proxyToolMetadataCache,
    upstreamLimits,
    logger
  } = input;
  const context = await toolContexts.findLatestActiveBySession(tenantId, sessionIdFromRuntimeToken);
  if (!context || context.tenantId !== runtimeTokenClaims.tid ||
      context.sessionId !== runtimeTokenClaims.sid || context.userId !== runtimeTokenClaims.uid ||
      context.runtimeId !== runtimeTokenClaims.rid) {
    return ok(rpc.id, { tools: [] });
  }
  const runtimePolicy = getRuntimePolicySnapshot(context);
  if (!runtimePolicy.enabledMcpServers.includes(server.id)) return ok(rpc.id, { tools: [] });
  if (server.mode === "proxy" && !matchesBoundServerSource(server, context)) return ok(rpc.id, { tools: [] });
  const managedToolsForRequest =
    server.mode === "managed"
      ? await getVisibleManagedTools({
          serverId: server.id,
          managedTools,
          context
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
        ...(tool.appResource ? { _meta: { ui: { resourceUri: tool.appResource.uri } } } : {}),
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
  const cacheScope = proxyMetadataScope(server, runtimeTokenClaims.uid);

  const response = await forwardRpc(
    server.upstreamUrl,
    rpc,
    { "X-Forwarded-By": "cogniplane-core" },
    undefined,
    // serverId, not the URL path, is what tells two upstreams on one origin
    // apart in the failure log — see logSafeUrl.
    { ...upstreamLimits, serverId: server.id },
    server.upstreamAuth ?? null
  );

  const safeResponse = scrubRpcPayload(response, server.upstreamAuth?.secret);
  if (
    !safeResponse.error &&
    safeResponse.result &&
    typeof safeResponse.result === "object" &&
    "tools" in safeResponse.result &&
    Array.isArray((safeResponse.result as { tools?: unknown }).tools)
  ) {
    // The runtime token's unique jti stays constant across this client's
    // pagination sequence. It isolates staging from other sessions even when
    // their upstream cursors happen to have the same value. An error or
    // malformed body skips this call and keeps the last complete listing.
    const result = safeResponse.result as { tools: readonly ProxyToolMetadata[]; nextCursor?: unknown };
    const requestCursor = (rpc.params as { cursor?: unknown } | undefined)?.cursor;
    proxyToolMetadataCache.recordToolsPage(tenantId, server.id, listingId, {
      requestCursor: typeof requestCursor === "string" ? requestCursor : null,
      nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
      tools: result.tools
    }, cacheScope);
  }

  return redactRpcEnvelope(safeResponse);
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
  approvals: Pick<ApprovalStore, "get" | "consume">;
  proxyToolMetadataCache: ProxyToolMetadataCache;
  upstreamSignatureSecret: string;
  upstreamLimits: ForwardRpcLimits;
  integrationToolCalls: Pick<IntegrationRegistryService, "checkToolCall">;
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
    integrationToolCalls,
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
  // The error does not repeat the rejected values.
  const invocation = readInvocationMetadata(rpc.params);
  if (!invocation.ok) {
    return failure(rpc.id, -32602, "Invalid params: malformed invocation metadata.");
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
          invocation.metadata,
          urlToolContextId,
          sessionIdFromRuntimeToken,
          runtimeTokenClaims,
          policyGate,
          integrationToolCalls,
          logger,
          captureContext
        )
      : await handleForwardedToolCall(
          rpc,
          tenantId,
          server,
          toolContexts,
          invocation.metadata,
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

  // Redact before telemetry too: an upstream error can echo its credential,
  // and telemetry metadata is stored.
  const safeResponse = redactRpcEnvelope(scrubRpcPayload(response, server.upstreamAuth?.secret));
  await recordToolCallTelemetry({
    activationTracker,
    tenantId,
    sessionIdFromRuntimeToken,
    server,
    rpc,
    response: safeResponse,
    messageId
  });

  return safeResponse;
}

/**
 * Redact credentials in a tool response at the gateway boundary, BEFORE it
 * reaches the runtime or telemetry. The transcript/tool-result stores already
 * run redactSecrets(), but the LangGraph result is separately persisted into
 * the durable checkpointer as a ToolMessage and restored into model context
 * on later turns — a path the store-layer redaction never touches. A proxy
 * upstream's JSON-RPC error envelope is forwarded as-is (message, data and
 * extension members), so it is redacted like a result.
 *
 * The managed path also redacts its handler result before serialising it
 * into content[0].text, because key-based redaction cannot reach a value
 * that is already inside a JSON string. This pass is what covers the
 * *forwarded* path, whose result never goes through that function, and it
 * is idempotent over the managed one.
 */
// Scrub the upstream secret from a response's result and error, never from the
// JSON-RPC envelope (`jsonrpc`, `id`) or the field names of the result and
// error themselves: a short secret must not corrupt the protocol.
function scrubRpcPayload(response: RpcResponse, secret: string | null | undefined): RpcResponse {
  if (!secret) return response;
  const { result, error } = response;
  return {
    ...response,
    ...(result !== undefined ? {
      result: isPlainObject(result) ? scrubUpstreamCredentialValues(result, secret) : scrubUpstreamCredential(result, secret)
    } : {}),
    ...(error !== undefined ? { error: scrubUpstreamCredentialValues(error, secret) } : {})
  };
}

function redactRpcEnvelope(response: RpcResponse): RpcResponse {
  return {
    ...response,
    ...(response.result !== undefined ? { result: redactSecrets(response.result) } : {}),
    ...(response.error !== undefined ? { error: redactSecrets(response.error) } : {})
  };
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
 *   0. toolContextId in the request's trusted `_meta` entry. This is the
 *      primary path. The deep-agents loop sends it at call time. When it is
 *      present, the gateway ignores a toolContextId in the args, because the
 *      model wrote that value.
 *   1. toolContextId in the RPC args (older callers).
 *   2. toolContextId in the MCP URL query string.
 *   3. Active session fallback — look up the latest non-expired context for the
 *      sessionId carried by the runtime token. Resilience path when a runtime
 *      sends no id.
 *
 * SECURITY (paths 0 to 2): a metadata/arg/URL-supplied toolContextId is otherwise
 * resolved by TENANT only, which would let a same-tenant attacker substitute
 * another user's or session's context id into a tool call — for proxy mode that
 * means the gateway would sign identity headers for the substituted identity.
 * We therefore assert that the resolved context belongs to the runtime token's
 * tenant, session, user and runtime ID on all three paths. Session fallback may
 * return a newer participant's context and requires the same checks.
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
  invocation: McpInvocationMetadata | null,
  urlToolContextId: string | null,
  sessionIdFromRuntimeToken: string,
  runtimeTokenClaims: RuntimeTokenClaims,
  policyGate: PolicyGate,
  integrationToolCalls: Pick<IntegrationRegistryService, "checkToolCall">,
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
    metadataToolContextId: invocation?.toolContextId ?? null,
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
    if (isProjectToolUnavailableInTurn(tool, context)) {
      throw new ToolCallError("Project tools are only available during interactive project turns.");
    }
    // The runtime policy is a snapshot from the turn start. An integration
    // toggle or the connected account can change while the turn runs or waits
    // for an approval, so check both again for each call.
    const integrationRefusal = await integrationToolCalls.checkToolCall({
      tenantId: context.tenantId,
      userId: context.userId,
      toolName: tool.name,
      boundAccounts: isPlainObject(context.metadata.integrationAccounts)
        ? context.metadata.integrationAccounts : undefined
    });
    if (integrationRefusal) throw new ToolCallError(integrationRefusal);
    // A tool that saves durable data never runs on the model's word. A scheduled
    // run has nobody to approve it, so refuse before anything is claimed or saved.
    if (tool.requiresUserApproval && context.metadata.turnContext === "scheduled") {
      return toolRefusal(
        rpc.id,
        `${tool.name} saves data that a user must approve, and a scheduled run has nobody to ask. Nothing was saved.`
      );
    }
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
    const policyOutcome = await enforcePolicyCenter(
      policyGate,
      context,
      tool.name,
      serverId,
      { readOnly: tool.readOnly },
      args,
      invocation?.policyApprovalId ?? null,
      // Category is the tool's bound domain, not the URL serverId — so a
      // `categories` policy rule matches the tool's true domain even if the
      // call arrived through a different enabled managed server's URL.
      tool.category ?? serverId
    );
    // The tenant approval policy and Policy Center rules never lower this check.
    // The approval came from the graph's interrupt, belongs to this exact call
    // and was claimed above, so a replay or a changed value finds none.
    let approval: ManagedToolApproval | undefined;
    if (tool.requiresUserApproval) {
      const checked = checkUserApproval(policyOutcome);
      if ("refusal" in checked) {
        return toolRefusal(rpc.id, `${tool.name} saves data that the user must approve. ${checked.refusal} Nothing was saved.`);
      }
      approval = checked.approval;
    }
    const handlerArgs = withoutPolicyApprovalMetadata(args);
    const rawResult = await tool.handler({
      context,
      arguments: handlerArgs,
      ...(approval ? { approval } : {})
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
      isError: false,
      ...(tool.appResource ? { _meta: mcpAppResultMeta(tool.appResource.uri, tool.readOnly, context) } : {})
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

/**
 * A refusal that the model reads as the tool result, as the GitHub and Jira tools
 * return theirs. A JSON-RPC error would reach the graph as a thrown tool exception,
 * which ends the turn, so the model could not tell the user that nothing was saved.
 */
function toolRefusal(id: z.infer<typeof rpcRequestSchema>["id"], message: string): RpcResponse {
  return ok(id, {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    structuredContent: { error: message },
    isError: false
  });
}

/**
 * The proof that a user approved this exact call, for a tool with
 * `requiresUserApproval`, or the reason why there is none.
 */
function checkUserApproval(
  outcome: PolicyGateOutcome
): { approval: ManagedToolApproval } | { refusal: string } {
  const { approval, approvalDisposition } = outcome;
  if (approvalDisposition === "approve" && approval) {
    const bound = approval.requestPayload.bound;
    return {
      approval: {
        approvalId: approval.approvalId,
        approvedByUserId: approval.userId,
        approvedAt: approval.resolvedAt ?? approval.updatedAt,
        bound: isPlainObject(bound) ? bound : {}
      }
    };
  }
  return {
    refusal:
      approvalDisposition === "consumed" ? "That approval was already used."
      : approvalDisposition === "reject" ? "The user declined it."
      : approvalDisposition === "expired" ? "The approval request expired."
      : "No approval for this exact call was recorded."
  };
}

// The MCP App keys that the runtime reads from a tool result. Only the gateway
// sets them; the proxy path strips upstream copies first.
function mcpAppResultMeta(
  resourceUri: string,
  readOnly: boolean,
  context: Pick<ToolExecutionContext, "metadata">
): Record<string, unknown> {
  const turnContext = context.metadata.turnContext;
  return {
    cogniplaneAppResourceUri: resourceUri,
    cogniplaneAppReadOnly: readOnly,
    cogniplaneAppTurnContext: turnContext === "interactive" || turnContext === "scheduled" ? turnContext : null
  };
}

// Project tools need the project snapshot that an interactive project turn
// writes into the tool context. Hide them from scheduled turns and from
// standalone chats, where the handler can only fail.
function isProjectToolUnavailableInTurn(
  tool: ManagedToolDefinition,
  context: Pick<ToolExecutionContext, "metadata">
): boolean {
  return tool.category === "project" &&
    (context.metadata.turnContext === "scheduled" || !context.metadata.projectContext);
}

async function getVisibleManagedTools(input: {
  serverId: string;
  managedTools: ManagedToolDefinition[];
  context: ToolExecutionContext;
}): Promise<ManagedToolDefinition[]> {
  const context = input.context;

  // If the runtime policy forbids this MCP server, advertise no tools
  // rather than throwing — `tools/list` is probed by every SDK at startup and
  // should not 500 on misconfiguration. Tool *calls* still fail via the
  // existing `requireMcpServerAllowed` check in `handleManagedToolCall`.
  const runtimePolicy = getRuntimePolicySnapshot(context);
  if (!runtimePolicy.enabledMcpServers.includes(input.serverId)) {
    return [];
  }

  return input.managedTools.filter((tool) =>
    runtimePolicy.enabledToolIds.includes(tool.name) &&
    !isProjectToolUnavailableInTurn(tool, context)
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
  invocation: McpInvocationMetadata | null,
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
    metadataToolContextId: invocation?.toolContextId ?? null,
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
    if (!matchesBoundServerSource(server, context)) {
      throw new ToolCallError(`MCP server ${server.id} changed during this turn.`);
    }
    const toolName = String(params.name ?? "");
    const cacheScope = proxyMetadataScope(server, context.userId);
    await proxyToolMetadataCache.refreshMissing(tenantId, server.id, toolName,
      () => refreshProxyToolMetadata(tenantId, server, proxyToolMetadataCache, upstreamLimits, logger, cacheScope), cacheScope);
    const isReadOnly = proxyToolMetadataCache.isReadOnly(tenantId, server.id, toolName, cacheScope) ?? null;
    await enforcePolicyCenter(
      policyGate,
      context,
      toolName,
      server.id,
      { readOnly: isReadOnly },
      args,
      invocation?.policyApprovalId ?? null
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
  // The toolContextId and the approval proof are for the gateway only. Never
  // forward them upstream, in the arguments or in `_meta`. Other `_meta`
  // entries, such as a progress token, go through.
  const forwardArgs = withoutPolicyApprovalMetadata(args);
  delete forwardArgs.toolContextId;

  const response = await forwardSignedProxyRpc({
    server,
    rpc: {
      ...rpc,
      params: {
        ...withoutInvocationMetadata(params),
        arguments: forwardArgs
      }
    },
    tenantId,
    userId: context.userId,
    sessionId: context.sessionId,
    runtimeId: context.runtimeId,
    signingSecret: upstreamSignatureSecret,
    limits: upstreamLimits
  });
  const toolName = String(params.name ?? "");
  const cacheScope = proxyMetadataScope(server, context.userId);
  const resourceUri = proxyToolMetadataCache.appResourceUri(tenantId, server.id, toolName, cacheScope);
  if (!isPlainObject(response.result)) {
    return response;
  }
  const result = response.result;
  const meta = isPlainObject(result._meta) ? result._meta : {};
  const { cogniplaneAppResourceUri: _untrusted, cogniplaneAppReadOnly: _untrustedReadOnly,
    cogniplaneAppTurnContext: _untrustedTurnContext, ...upstreamMeta } = meta;
  if (response.error || !Array.isArray(result.content) || !resourceUri) {
    const hadUntrusted = _untrusted !== undefined || _untrustedReadOnly !== undefined || _untrustedTurnContext !== undefined;
    return hadUntrusted ? { ...response, result: { ...result, _meta: upstreamMeta } } : response;
  }
  const readOnly = proxyToolMetadataCache.isReadOnly(tenantId, server.id, toolName, cacheScope) === true;
  return {
    ...response,
    result: { ...result, _meta: { ...upstreamMeta, ...mcpAppResultMeta(resourceUri, readOnly, context) } }
  };
}

async function refreshProxyToolMetadata(
  tenantId: string,
  server: McpServerRegistration,
  cache: ProxyToolMetadataCache,
  limits: ForwardRpcLimits,
  logger: Pick<FastifyBaseLogger, "warn">,
  cacheScope: string
): Promise<void> {
  if (!server.upstreamUrl) return;
  const listingId = randomUUID();
  const seen = new Set<string>();
  let cursor: string | null = null;
  const deadline = Date.now() + 5_000;
  for (let page = 0; page < 20; page += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const response = await forwardRpc(
      server.upstreamUrl,
      { jsonrpc: "2.0", id: `${listingId}:${page}`, method: "tools/list", ...(cursor ? { params: { cursor } } : {}) },
      { "X-Forwarded-By": "cogniplane-core" },
      undefined,
      { ...limits, timeoutMs: Math.min(limits.timeoutMs ?? remaining, remaining) },
      server.upstreamAuth ?? null
    );
    const safeResult = scrubRpcPayload(response, server.upstreamAuth?.secret).result;
    if (response.error || !isPlainObject(safeResult) || !Array.isArray(safeResult.tools)) {
      logger.warn({ serverId: server.id }, "Could not refresh proxy tool metadata");
      return;
    }
    const nextCursor = typeof safeResult.nextCursor === "string" ? safeResult.nextCursor : null;
    cache.recordToolsPage(tenantId, server.id, listingId, {
      requestCursor: cursor,
      nextCursor,
      tools: safeResult.tools as ProxyToolMetadata[]
    }, cacheScope);
    if (nextCursor === null) return;
    if (seen.has(nextCursor)) break;
    seen.add(nextCursor);
    cursor = nextCursor;
  }
  logger.warn({ serverId: server.id }, "Proxy tool metadata listing did not complete");
}
