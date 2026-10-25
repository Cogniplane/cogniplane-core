import { test, expect, onTestFinished, vi } from "vitest";
import Fastify from "fastify";

import type { PolicyRule } from "@cogniplane/shared-types";

import { testRuntimePolicy } from "../test-helpers/test-runtime-policy.js";
import { createProxyMcpUpstream } from "../test-helpers/mcp-route-test-support.js";
import {
  createTestApp,
  createTestToolContext,
  TEST_RUNTIME_TOKEN_SECRET
} from "../test-helpers/routes-test-support.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { generateRuntimeToken } from "../services/auth/runtime-token.js";
import type { ApprovalRecord } from "../services/auth/approval-store.js";
import { PolicyService } from "../services/policy/policy-service.js";
import {
  POLICY_APPROVAL_MARKER_KEY,
  POLICY_APPROVAL_REQUEST_METHOD,
  createPolicyApprovalProof
} from "../services/policy/policy-approval-proof.js";
import type { PolicyDecisionStore } from "../services/policy/policy-decision-store.js";
import type { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import { deriveActionSeverity } from "../services/mcp/policy-gate.js";
import { runGatewayAdmission } from "../services/mcp/gateway-admission.js";
import { forwardRpc } from "../lib/mcp-upstream-client.js";
import { MCP_REQUEST_BODY_LIMIT_BYTES } from "./mcp.js";
import { MCP_INVOCATION_META_KEY, type McpInvocationMetadata } from "../services/mcp/invocation-metadata.js";
import { AdminConfigError } from "../services/admin-config-error.js";
import { INTERACTIVE_UI_RESOURCE_URI } from "../services/managed-tools/interactive-ui.js";
import { GatewayMcpClient } from "../services/deep-agents/gateway-mcp-client.js";
import { EventType } from "@ag-ui/client";
import { createStreamEventsToAGUIState, streamEventsToAGUI } from "../services/deep-agents/stream-events-to-agui.js";
import { AguiTurnAccumulator } from "../services/agui-turn-accumulator.js";

test("carries a managed widget through the runtime's real MCP client into a saved AG-UI tool result", async () => {
  const { app, toolContexts } = await createTestApp();
  const sessionId = "managed-widget-transport";
  const context = await createTestToolContext(toolContexts, { sessionId, metadata: {
    runtimePolicy: { ...testRuntimePolicy, enabledToolIds: [...testRuntimePolicy.enabledToolIds, "render_interactive_ui"] },
    turnContext: "interactive"
  } });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new GatewayMcpClient({
    servers: [{ id: "widgets", url: `${url}/mcp/managed-session-context`,
      authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "test-user", rid: context.runtimeId })}` }],
    resolveInvocation: () => ({ toolContextId: context.toolContextId }),
    logger: { warn: () => {} }, sessionId
  });
  onTestFinished(async () => { await client.close(); await app.close(); });
  const tool = (await client.loadTools()).flatMap((toolset) => toolset.tools).find((tool) => tool.name === "render_interactive_ui")!;
  expect(tool).toBeDefined();
  const input = { toolContextId: context.toolContextId, title: "Spending", description: "Travel is the largest category.",
    html: '<button id="filter">Filter</button><script>document.querySelector("#filter").onclick = () => {};</script>' };
  const output = await tool.invoke({ type: "tool_call", id: "widget-call", name: tool.name, args: input });
  const state = createStreamEventsToAGUIState();
  const options = { mcpToolNames: new Set([tool.name]), mcpToolServers: new Map([[tool.name, "managed-session-context"]]) };
  const start = streamEventsToAGUI(state, { event: "on_tool_start", name: tool.name, run_id: "widget-call",
    data: { input } }, options);
  const end = streamEventsToAGUI(state, { event: "on_tool_end", name: tool.name, run_id: "widget-call",
    data: { output } }, options);
  expect(end.find((event) => event.type === EventType.CUSTOM && event.name === "tool_mcp_app"))
    .toMatchObject({ value: { app: { resourceUri: INTERACTIVE_UI_RESOURCE_URI, input,
      result: { structuredContent: { title: input.title, description: input.description, characters: input.html.length } } } } });
  const accumulator = new AguiTurnAccumulator();
  for (const event of [...start, ...end]) accumulator.apply(event);
  expect(accumulator.toolResults()[0]).toMatchObject({
    kind: "mcp", server: "managed-session-context", status: "completed",
    mcpApp: { resourceUri: INTERACTIVE_UI_RESOURCE_URI, input, readOnly: true, turnContext: "interactive" }
  });
});

test("advertises and binds the managed widget resource only for an enabled successful call", async () => {
  const { app, toolContexts } = await createTestApp();
  onTestFinished(() => app.close());
  const sessionId = "interactive-ui-session";
  const runtimePolicy = { ...testRuntimePolicy,
    enabledToolIds: [...testRuntimePolicy.enabledToolIds, "render_interactive_ui"] };
  const context = await createTestToolContext(toolContexts, { sessionId,
    metadata: { runtimePolicy, turnContext: "interactive" } });
  const headers = { authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "test-user", rid: context.runtimeId })}` };
  const request = (method: string, params?: Record<string, unknown>) => app.inject({
    method: "POST", url: "/mcp/managed-session-context", headers,
    payload: { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }
  });
  const listing = (await request("tools/list")).json();
  expect(listing.result.tools.find((tool: { name: string }) => tool.name === "render_interactive_ui"))
    .toMatchObject({ annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: INTERACTIVE_UI_RESOURCE_URI } } });
  const html = '<button id="calculate">Calculate</button><script>const total = 42;</script>';
  const called = (await request("tools/call", { name: "render_interactive_ui", arguments: {
    toolContextId: context.toolContextId, title: "Calculation", description: "The total is 42.", html
  } })).json();
  expect(called.result).toMatchObject({
    structuredContent: { title: "Calculation", description: "The total is 42.", characters: html.length },
    _meta: { cogniplaneAppResourceUri: INTERACTIVE_UI_RESOURCE_URI, cogniplaneAppReadOnly: true,
      cogniplaneAppTurnContext: "interactive" }
  });
  expect(JSON.stringify(called.result)).not.toContain(html);
  expect((await request("tools/call", { name: "render_interactive_ui", arguments: {
    toolContextId: context.toolContextId, title: "Calculation", description: "Summary", html: " "
  } })).json()).toMatchObject({ error: { code: -32000 } });
  runtimePolicy.enabledToolIds = [...testRuntimePolicy.enabledToolIds];
  expect((await request("tools/list")).json().result.tools.map((tool: { name: string }) => tool.name))
    .not.toContain("render_interactive_ui");
  expect((await request("tools/call", { name: "render_interactive_ui", arguments: {
    toolContextId: context.toolContextId, title: "Calculation", description: "Summary", html
  } })).json()).toMatchObject({ error: { code: -32000 } });
});

type ProxyRequest = Awaited<ReturnType<typeof createProxyMcpUpstream>>["upstreamRequests"][number];
const toolCallRequests = (requests: ProxyRequest[]) => requests.filter((request) => request.body.method === "tools/call");

test("proxy calls use each runtime member's credential and reject a disconnected member before egress", async () => {
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const connected = new Map([["alice", "alice-token"], ["bob", "bob-token"]]);
  const { app, toolContexts } = await createTestApp({
    resolveMcpServer: async (_tenant, serverId, userId) => {
      const secret = connected.get(userId);
      if (!secret) throw new AdminConfigError("Credential unavailable");
      return { id: serverId, description: "Personal proxy", mode: "proxy", routePath: `/mcp/${serverId}`,
        upstreamUrl, transportKind: "http", version: 1, hash: "server-hash",
        credentialScope: "personal", credentialBindingId: "binding-1", credentialVersion: 1,
        upstreamAuth: { type: "bearer", secret } };
    }
  });
  onTestFinished(async () => { await Promise.all([app.close(), upstream.close()]); });
  for (const userId of ["alice", "bob"]) {
    const sessionId = `session-${userId}`;
    const context = await createTestToolContext(toolContexts, { sessionId, userId,
      metadata: { runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: ["test-proxy"] },
        mcpServerSources: [{ id: "test-proxy", hash: "server-hash", credentialVersion: 1 }] } });
    const response = await app.inject({ method: "POST", url: "/mcp/test-proxy",
      headers: { authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: userId, rid: context.runtimeId })}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "search", arguments: { toolContextId: context.toolContextId } } } });
    expect(response.statusCode).toBe(200);
  }
  expect(toolCallRequests(upstreamRequests).map(request => request.headers.authorization))
    .toEqual(["Bearer alice-token", "Bearer bob-token"]);
  connected.delete("bob");
  const denied = await app.inject({ method: "POST", url: "/mcp/test-proxy",
    headers: { authorization: `Bearer ${runtimeToken({ sid: "session-bob", uid: "bob" })}` },
    payload: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
  expect(denied.statusCode).toBe(403);
  expect(upstreamRequests).toHaveLength(4);
});

test("an MCP server lookup failure is an internal error, not an access denial", async () => {
  const { app } = await createTestApp({
    resolveMcpServer: async () => { throw new Error("connection terminated"); }
  });
  onTestFinished(async () => { await app.close(); });
  const response = await app.inject({ method: "POST", url: "/mcp/test-proxy",
    headers: { authorization: `Bearer ${runtimeToken({ sid: "session-alice", uid: "alice" })}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  expect(response.statusCode).toBe(500);
  expect(response.json().error).toMatchObject({ code: -32603, message: "Internal error." });
});

test("proxy rejects an approved turn after credential rotation or server reconfiguration", async () => {
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  let hash = "original-hash";
  let credentialVersion = 1;
  const { app, toolContexts } = await createTestApp({
    resolveMcpServer: async (_tenant, serverId) => ({ id: serverId, description: "Personal proxy",
      mode: "proxy", routePath: `/mcp/${serverId}`, upstreamUrl, transportKind: "http", version: 1,
      hash, credentialScope: "personal", credentialBindingId: "binding-1", credentialVersion,
      upstreamAuth: { type: "bearer", secret: "current-secret" } })
  });
  onTestFinished(async () => { await Promise.all([app.close(), upstream.close()]); });
  const context = await createTestToolContext(toolContexts, { sessionId: "approval-session", userId: "alice",
    metadata: { runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: ["test-proxy"] },
      mcpServerSources: [{ id: "test-proxy", hash: "original-hash", credentialVersion: 1 }] } });
  const headers = { authorization: `Bearer ${runtimeToken({ sid: "approval-session", uid: "alice", rid: context.runtimeId })}` };
  const call = () => app.inject({ method: "POST", url: "/mcp/test-proxy", headers,
    payload: { jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "search", arguments: { toolContextId: context.toolContextId } } } });
  credentialVersion = 2;
  expect((await app.inject({ method: "POST", url: "/mcp/test-proxy", headers,
    payload: { jsonrpc: "2.0", id: 0, method: "initialize" } })).statusCode).toBe(403);
  expect((await call()).json().error.message).toMatch(/changed during this turn/);
  expect((await app.inject({ method: "POST", url: "/mcp/test-proxy", headers,
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).json().result.tools).toEqual([]);
  expect(upstreamRequests).toHaveLength(0);
  credentialVersion = 1;
  hash = "new-endpoint-hash";
  expect((await call()).json().error.message).toMatch(/changed during this turn/);
  expect(upstreamRequests).toHaveLength(0);
});

test("links a forwarded result only to the app URI advertised in tools/list", async () => {
  const upstream = Fastify();
  let omitContent = false;
  let paginate = false;
  const accepted: string[] = [];
  upstream.post("/", async (request, reply) => {
    accepted.push(String(request.headers.accept));
    const rpc = request.body as { id: number; method: string; params?: { cursor?: string } };
    const response = { jsonrpc: "2.0", id: rpc.id, result: rpc.method === "tools/list"
      ? paginate && !rpc.params?.cursor ? { tools: [], nextCursor: "page-2" }
        : { tools: [{ name: "show_quote_picker", description: "Show quotes", inputSchema: { type: "object" },
          _meta: { ui: { resourceUri: "ui://quote-picker/app.html" } } }] }
      : { ...(omitContent ? {} : { content: [{ type: "text", text: "Three quotes" }] }), structuredContent: { quotes: [1, 2, 3] },
        _meta: { cogniplaneAppResourceUri: "ui://spoofed", other: "kept" } } };
    return reply.header("content-type", "text/event-stream")
      .send(`: upstream comment\n\nevent: message\ndata: ${JSON.stringify(response)}\n\n`);
  });
  const upstreamUrl = await upstream.listen({ host: "127.0.0.1", port: 0 });
  const { app, toolContexts } = await createTestApp({ proxyUpstreamUrl: upstreamUrl });
  onTestFinished(async () => { await Promise.all([app.close(), upstream.close()]); });
  const sessionId = "quote-app-session";
  const context = await createTestToolContext(toolContexts, { sessionId,
    metadata: { runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: ["test-proxy"] } }
  });
  const headers = { authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "test-user", rid: context.runtimeId })}` };
  const listed = await app.inject({ method: "POST", url: "/mcp/test-proxy", headers,
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  expect(listed.json().result.tools[0]._meta.ui.resourceUri).toBe("ui://quote-picker/app.html");
  const called = await app.inject({ method: "POST", url: "/mcp/test-proxy", headers,
    payload: { jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "show_quote_picker", arguments: { toolContextId: context.toolContextId } } } });
  expect(called.json().result).toMatchObject({
    structuredContent: { quotes: [1, 2, 3] },
    _meta: { cogniplaneAppResourceUri: "ui://quote-picker/app.html", other: "kept" }
  });
  omitContent = true;
  const withoutContent = await app.inject({ method: "POST", url: "/mcp/test-proxy", headers,
    payload: { jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "show_quote_picker", arguments: { toolContextId: context.toolContextId } } } });
  expect(withoutContent.json().result._meta).toEqual({ other: "kept" });

  omitContent = false;
  paginate = true;
  const { app: replicaB, toolContexts: contextsB } = await createTestApp({ proxyUpstreamUrl: upstreamUrl });
  onTestFinished(async () => replicaB.close());
  const contextB = await createTestToolContext(contextsB, { sessionId: "replica-b-session",
    metadata: { runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: ["test-proxy"] } }
  });
  const calledOnReplicaB = await replicaB.inject({ method: "POST", url: "/mcp/test-proxy",
    headers: { authorization: `Bearer ${runtimeToken({ sid: "replica-b-session", uid: "test-user", rid: contextB.runtimeId })}` },
    payload: { jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "show_quote_picker", arguments: { toolContextId: contextB.toolContextId } } } });
  expect(calledOnReplicaB.json().result._meta.cogniplaneAppResourceUri).toBe("ui://quote-picker/app.html");
  expect(accepted.length).toBeGreaterThanOrEqual(5);
  expect(accepted.every((value) => value === "application/json, text/event-stream")).toBe(true);
});

// A real PolicyService over a fixed rule set, for exercising
// require_approval / block end-to-end through the MCP gateway.
function makePolicyService(rules: PolicyRule[]) {
  const decisions: unknown[] = [];
  const ruleStore = { async list() { return rules; } };
  const decisionStore = {
    async record(_t: string, input: unknown) {
      decisions.push(input);
      return { decisionId: `pdc_${decisions.length}` };
    },
    async list() { return []; }
  };
  const service = new PolicyService({
    rules: ruleStore as unknown as PolicyRuleStore,
    decisions: decisionStore as unknown as PolicyDecisionStore,
    auditEvents: new InMemoryAuditEventStore() as unknown as AuditEventStore,
    ruleCacheTtlMs: 0 // no cache so each test's rules apply immediately
  });
  return { service, decisions };
}

function makePolicyRule(overrides: Partial<PolicyRule>): PolicyRule {
  return {
    ruleId: "pol_test",
    tenantId: "test-tenant",
    name: "Test rule",
    description: null,
    priority: 100,
    enabled: true,
    effect: "block",
    conditions: {},
    reason: null,
    createdBy: null,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    ...overrides
  };
}

// The MCP gateway verifies runtime tokens with the HKDF-derived subkey, not
// the raw DATA_ENCRYPTION_SECRET — routes-test-support derives it from the test
// config the same way app-bootstrap derives from the real one, so minting with
// it here exercises the real key relationship rather than a shared literal.
const RUNTIME_TOKEN_SECRET = TEST_RUNTIME_TOKEN_SECRET;

function runtimeToken(claims: { sid: string; uid: string; rid?: string; tid?: string }): string {
  return generateRuntimeToken(
    {
      sid: claims.sid,
      tid: claims.tid ?? "test-tenant",
      uid: claims.uid,
      rid: claims.rid ?? `runtime-${claims.sid}`
    },
    RUNTIME_TOKEN_SECRET
  );
}

/** The request `_meta` that the runtime sends with a call's trusted values. */
function invocationMeta(metadata: McpInvocationMetadata) {
  return { _meta: { [MCP_INVOCATION_META_KEY]: metadata } };
}

/** Calls a managed tool through the gateway with a runtime token for `claims`. */
function callManagedTool(
  app: { inject: ReturnType<typeof Fastify>["inject"] },
  claims: Parameters<typeof runtimeToken>[0],
  name: string,
  args: Record<string, unknown>,
  invocation?: McpInvocationMetadata
) {
  return app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    headers: { authorization: `Bearer ${runtimeToken(claims)}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args, ...(invocation ? invocationMeta(invocation) : {}) } }
  });
}

test("enforces an MCP-specific request body limit even when the global limit is higher", async () => {
  const { app } = await createTestApp({
    MAX_REQUEST_BODY_BYTES: MCP_REQUEST_BODY_LIMIT_BYTES * 2
  });
  onTestFinished(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    headers: {
      authorization: `Bearer ${runtimeToken({ sid: "body-limit-session", uid: "test-user" })}`
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { padding: "x".repeat(MCP_REQUEST_BODY_LIMIT_BYTES) }
    }
  });

  expect(response.statusCode).toBe(413);
});

// ---------------------------------------------------------------------------
// authz-1: arg/URL-supplied toolContextId must be bound to the runtime token's
// sid + uid, preventing same-tenant cross-user/session context substitution.
// ---------------------------------------------------------------------------

test("loopback peer admission allows loopback peers and rejects non-loopback peers", async () => {
  const { app, auditEvents } = await createTestApp();
  onTestFinished(async () => {
    await app.close();
  });

  const headers = {
    authorization: `Bearer ${runtimeToken({ sid: "loopback-session", uid: "test-user", rid: "runtime-loopback" })}`
  };
  const payload = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  // Loopback peer (127.0.0.1) succeeds (200).
  const loopbackV4 = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    remoteAddress: "127.0.0.1",
    headers,
    payload
  });
  expect(loopbackV4.statusCode).toBe(200);

  // Loopback IPv6 (::1) succeeds (200).
  const loopbackV6 = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    remoteAddress: "::1",
    headers,
    payload
  });
  expect(loopbackV6.statusCode).toBe(200);

  // IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) succeeds (200).
  const loopbackV4MappedV6 = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    remoteAddress: "::ffff:127.0.0.1",
    headers,
    payload
  });
  expect(loopbackV4MappedV6.statusCode).toBe(200);

  // Missing/undefined socket peer receives 403 Forbidden.
  const admissionMissingPeer = await runGatewayAdmission({
    authorizationHeader: headers.authorization,
    rpcId: 1,
    rpcMethod: "tools/list",
    serverId: "managed-session-context",
    tenantId: "test-tenant",
    remoteAddress: undefined,
    stores: {
      runtimeTokenSecret: RUNTIME_TOKEN_SECRET,
      auditEvents
    },
    logger: { warn: () => {}, debug: () => {} } as never
  });
  expect(admissionMissingPeer.ok).toBe(false);
  if (!admissionMissingPeer.ok) {
    expect(admissionMissingPeer.statusCode).toBe(403);
    expect(admissionMissingPeer.body.error?.message).toMatch(/Loopback connection required/i);
  }

  // Non-loopback peer (203.0.113.10) receives 403 Forbidden.
  const nonLoopback = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    remoteAddress: "203.0.113.10",
    headers,
    payload
  });
  expect(nonLoopback.statusCode).toBe(403);
  expect(nonLoopback.json().error.message).toMatch(/Loopback connection required/i);

  // Audit event recorded for non-loopback rejection.
  const rejectedEvent = auditEvents.events.find((e) => e.type === "mcp.gateway.rejected");
  expect(rejectedEvent).toBeDefined();
  expect(rejectedEvent?.payload.reason).toBe("non_loopback_peer");
});

test.each(["managed-session-context", "test-proxy"].flatMap((serverId) =>
  ["args", "url", "fallback"].flatMap((source) =>
    ["user", "runtime", "matching"].map((identity) => ({ serverId, source, identity }))
  )
))("binds $serverId context from $source to $identity identity", async ({ serverId, source, identity }) => {
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const handler = vi.fn(async () => ({ allowed: true }));
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: upstreamUrl,
    extraManagedTools: [{
      name: "identity_probe", description: "Identity test", readOnly: true,
      inputSchema: { type: "object" }, handler
    }]
  });
  onTestFinished(async () => { await Promise.all([app.close(), upstream.close()]); });
  const context = await createTestToolContext(toolContexts, {
    sessionId: "shared-session", userId: "current-user", runtimeId: "current-runtime",
    metadata: { runtimePolicy: {
      ...testRuntimePolicy, enabledMcpServers: [serverId], enabledToolIds: ["identity_probe"]
    } }
  });
  const requireContext = vi.spyOn(toolContexts, "require");
  const findContext = vi.spyOn(toolContexts, "findLatestActiveBySession");
  const response = await app.inject({
    method: "POST",
    url: `/mcp/${serverId}${source === "url" ? `?toolContextId=${context.toolContextId}` : ""}`,
    headers: { authorization: `Bearer ${runtimeToken({
      sid: context.sessionId,
      uid: identity === "user" ? "prior-user" : context.userId,
      rid: identity === "runtime" ? "prior-runtime" : context.runtimeId
    })}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "identity_probe",
      arguments: source === "args" ? { toolContextId: context.toolContextId } : {}
    } }
  });
  expect(response.statusCode).toBe(200);
  if (source === "fallback") {
    expect(findContext).toHaveBeenCalledWith("test-tenant", context.sessionId);
    expect(requireContext).not.toHaveBeenCalled();
  } else {
    expect(requireContext).toHaveBeenCalledWith("test-tenant", context.toolContextId);
    expect(findContext).not.toHaveBeenCalled();
  }
  if (identity === "matching") {
    expect(response.json().error).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(serverId === "test-proxy" ? 0 : 1);
    expect(toolCallRequests(upstreamRequests)).toHaveLength(serverId === "test-proxy" ? 1 : 0);
  } else {
    expect(response.json().error.message).toBe("Tool context does not belong to the authenticated runtime session.");
    expect(handler).not.toHaveBeenCalled();
    expect(upstreamRequests).toHaveLength(0);
  }
});

test("rejects a managed tool call whose toolContextId belongs to another user/session", async () => {
  const { app, sessions, messages, toolContexts } = await createTestApp();
  onTestFinished(async () => {
    await app.close();
  });

  // Victim's context: a real session owned by victim-user.
  const victimSession = await sessions.create("test-tenant", "victim-user", "Victim session");
  await messages.create({
    tenantId: "test-tenant",
    sessionId: victimSession.sessionId,
    userId: "victim-user",
    role: "assistant",
    status: "completed",
    content: "Victim assistant message"
  });
  const victimContext = await createTestToolContext(toolContexts, {
    sessionId: victimSession.sessionId,
    userId: "victim-user",
    runtimeId: "runtime-victim"
  });

  // Attacker authenticates with a runtime token for a different user/session but
  // tries to drive the call against the victim's toolContextId.
  const response = await callManagedTool(app, { sid: "attacker-session", uid: "attacker-user" }, "session_context", {
    toolContextId: victimContext.toolContextId,
    recentMessageCount: 1
  });

  expect(response.statusCode).toBe(200);
  const payload = response.json();
  expect(payload.error).toBeTruthy();
  expect(payload.error.message).toMatch(/does not belong to the authenticated runtime session/);
});

test("accepts a managed tool call whose toolContextId matches the runtime token", async () => {
  const { app, sessions, messages, toolContexts } = await createTestApp();
  onTestFinished(async () => {
    await app.close();
  });

  const session = await sessions.create("test-tenant", "owner-user", "Owner session");
  await messages.create({
    tenantId: "test-tenant",
    sessionId: session.sessionId,
    userId: "owner-user",
    role: "assistant",
    status: "completed",
    content: "Owner assistant message"
  });
  const context = await createTestToolContext(toolContexts, {
    sessionId: session.sessionId,
    userId: "owner-user",
    runtimeId: "runtime-owner"
  });

  const response = await callManagedTool(app, { sid: session.sessionId, uid: "owner-user", rid: "runtime-owner" }, "session_context", {
    toolContextId: context.toolContextId,
    recentMessageCount: 1
  });

  expect(response.statusCode).toBe(200);
  const payload = response.json();
  expect(payload.error).toBeUndefined();
  expect(payload.result.isError).toBe(false);
  expect(payload.result.structuredContent.session.sessionId).toBe(session.sessionId);
});

test("rejects a proxy tool call with a substituted toolContextId (no signed identity for the victim)", async () => {
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const victimContext = await createTestToolContext(toolContexts, {
    sessionId: "victim-session",
    userId: "victim-user",
    runtimeId: "runtime-victim",
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"],
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "test-proxy"]
      }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: {
      authorization: `Bearer ${runtimeToken({ sid: "attacker-session", uid: "attacker-user" })}`
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: {
          toolContextId: victimContext.toolContextId,
          query: "exfiltrate"
        }
      }
    }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().error).toBeTruthy();
  // The upstream must never be reached with the victim's signed identity.
  expect(upstreamRequests.length).toBe(0);
});

test("rejects gateway calls without a valid runtime token even when otherwise authenticated", async () => {
  // The toolContextId binding in resolveBoundToolContext relies on runtime
  // token claims. A caller authenticated some other way (user JWT,
  // dev-headers) must be rejected outright — otherwise a same-tenant user
  // could substitute another user's context id and skip the binding check.
  const { app, sessions, toolContexts } = await createTestApp();
  onTestFinished(async () => {
    await app.close();
  });

  const session = await sessions.create("test-tenant", "test-user", "Dev session");
  const context = await createTestToolContext(toolContexts, {
    sessionId: session.sessionId
  });

  // No Authorization header — the dev-headers preHandler authenticates the
  // request, but there is no runtime token.
  const response = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "session_context",
        arguments: {
          toolContextId: context.toolContextId,
          recentMessageCount: 1
        }
      }
    }
  });

  expect(response.statusCode).toBe(401);
  const payload = response.json();
  expect(payload.error.message).toMatch(/runtime token/i);
});

// ---------------------------------------------------------------------------
// proxy-list: proxy-mode tools/list applies the enabledMcpServers policy.
// ---------------------------------------------------------------------------

test("proxy tools/list returns no tools when the runtime policy forbids the server", async () => {
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const sessionId = "session-proxy-forbidden";
  await createTestToolContext(toolContexts, {
    sessionId,
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        // "test-proxy" intentionally absent from enabledMcpServers.
        enabledMcpServers: ["managed-session-context"]
      }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: {
      authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "test-user" })}`
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().result.tools).toEqual([]);
  // Forbidden server must not be probed upstream.
  expect(upstreamRequests.length).toBe(0);
});

test("proxy tools/list forwards to the upstream when the runtime policy allows the server", async () => {
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const sessionId = "session-proxy-allowed";
  const context = await createTestToolContext(toolContexts, {
    sessionId,
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"]
      }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: {
      authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "test-user", rid: context.runtimeId })}`
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    }
  });

  expect(response.statusCode).toBe(200);
  expect(upstreamRequests).toHaveLength(1);
});

test("proxy tools/list does not use another member's active context", async () => {
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const { app, toolContexts } = await createTestApp({ proxyUpstreamUrl: upstreamUrl });
  onTestFinished(async () => { await Promise.all([app.close(), upstream.close()]); });
  const context = await createTestToolContext(toolContexts, { sessionId: "shared-session", userId: "alice",
    metadata: { runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: ["test-proxy"] } } });
  const response = await app.inject({ method: "POST", url: "/mcp/test-proxy",
    headers: { authorization: `Bearer ${runtimeToken({ sid: "shared-session", uid: "bob", rid: context.runtimeId })}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  expect(response.statusCode).toBe(200);
  expect(response.json().result.tools).toEqual([]);
  expect(upstreamRequests).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// ProxyToolMetadataCache populates from tools/list and drives severity
// ---------------------------------------------------------------------------

test("ProxyToolMetadataCache populates from tools/list upstream response and drives readOnly into deriveActionSeverity on subsequent tools/call", async () => {
  const gatedActions: Array<{ toolName: string; severity: string }> = [];
  const policyService = {
    async gateAction(req: { toolName: string; severity: string }) {
      gatedActions.push({ toolName: req.toolName, severity: req.severity });
      return {
        evaluation: { outcome: "allow", matchedRuleId: null, matchedRuleName: null, gating: false, explanation: null },
        enforced: false
      };
    },
    async evaluate() {
      return { outcome: "allow", matchedRuleId: null, matchedRuleName: null, gating: false, explanation: null };
    }
  };

  const upstream = Fastify();
  upstream.post("/", async (request) => {
    const body = request.body as { id?: string | number; method?: string };
    if (body.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: body.id ?? 1,
        result: {
          tools: [
            {
              name: "proxy_read_tool",
              description: "Read only proxy tool",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true }
            },
            {
              name: "proxy_write_tool",
              description: "Mutating proxy tool",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: false }
            }
          ]
        }
      };
    }
    return {
      jsonrpc: "2.0",
      id: body.id ?? 2,
      result: {
        isError: false,
        content: [{ type: "text", text: "done" }]
      }
    };
  });

  const upstreamUrl = await upstream.listen({ port: 0, host: "127.0.0.1" });
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`,
    policyService: policyService as never
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const sessionId = "session-proxy-cache";
  const context = await createTestToolContext(toolContexts, {
    sessionId,
    userId: "cache-user",
    runtimeId: "runtime-cache",
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"],
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "test-proxy"]
      }
    }
  });

  const headers = {
    authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "cache-user", rid: "runtime-cache" })}`
  };

  // 1. tools/list primes the proxyToolMetadataCache
  const listResp = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers,
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" }
  });
  expect(listResp.statusCode).toBe(200);

  // 2. tools/call for proxy_read_tool uses cached readOnlyHint: true -> severity "read_only"
  const readCall = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers,
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "proxy_read_tool",
        arguments: { toolContextId: context.toolContextId }
      }
    }
  });
  expect(readCall.statusCode).toBe(200);

  // 3. tools/call for proxy_write_tool uses cached readOnlyHint: false -> severity "file_change"
  const writeCall = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers,
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "proxy_write_tool",
        arguments: { toolContextId: context.toolContextId }
      }
    }
  });
  expect(writeCall.statusCode).toBe(200);

  // 4. tools/call for uncached tool defaults to severity "file_change"
  const unknownCall = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers,
    payload: {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "proxy_unknown_tool",
        arguments: { toolContextId: context.toolContextId }
      }
    }
  });
  expect(unknownCall.statusCode).toBe(200);

  expect(gatedActions).toEqual([
    { toolName: "proxy_read_tool", severity: "read_only" },
    { toolName: "proxy_write_tool", severity: "file_change" },
    { toolName: "proxy_unknown_tool", severity: "file_change" }
  ]);
});

test("upstream tools/list response with JSON-RPC error does NOT mutate cache and preserves prior state", async () => {
  const gatedActions: Array<{ toolName: string; severity: string }> = [];
  const policyService = {
    async gateAction(req: { toolName: string; severity: string }) {
      gatedActions.push({ toolName: req.toolName, severity: req.severity });
      return {
        evaluation: { outcome: "allow", matchedRuleId: null, matchedRuleName: null, gating: false, explanation: null },
        enforced: false
      };
    },
    async evaluate() {
      return { outcome: "allow", matchedRuleId: null, matchedRuleName: null, gating: false, explanation: null };
    }
  };

  let listCallCount = 0;
  const upstream = Fastify();
  upstream.post("/", async (request) => {
    const body = request.body as { id?: string | number; method?: string };
    if (body.method === "tools/list") {
      listCallCount++;
      if (listCallCount === 1) {
        // Initial success: tool is read-only
        return {
          jsonrpc: "2.0",
          id: body.id ?? 1,
          result: {
            tools: [
              {
                name: "cached_tool",
                description: "Initial read-only tool",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true }
              }
            ]
          }
        };
      }
      // Second call: JSON-RPC error alongside result with tools attempting to claim readOnlyHint: false
      return {
        jsonrpc: "2.0",
        id: body.id ?? 2,
        error: { code: -32000, message: "failed" },
        result: {
          tools: [
            {
              name: "cached_tool",
              description: "Failed attempt to overwrite",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: false }
            }
          ]
        }
      };
    }
    return {
      jsonrpc: "2.0",
      id: body.id ?? 3,
      result: {
        isError: false,
        content: [{ type: "text", text: "done" }]
      }
    };
  });

  const upstreamUrl = await upstream.listen({ port: 0, host: "127.0.0.1" });
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`,
    policyService: policyService as never
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const sessionId = "session-error-cache";
  const context = await createTestToolContext(toolContexts, {
    sessionId,
    userId: "cache-user",
    runtimeId: "runtime-cache",
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"],
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "test-proxy"]
      }
    }
  });

  const headers = {
    authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "cache-user", rid: "runtime-cache" })}`
  };

  // 1. First tools/list succeeds and primes cache: cached_tool -> readOnlyHint: true
  const listResp1 = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers,
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" }
  });
  expect(listResp1.statusCode).toBe(200);

  // Call cached_tool -> severity is read_only
  await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers,
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "cached_tool",
        arguments: { toolContextId: context.toolContextId }
      }
    }
  });
  expect(gatedActions).toEqual([{ toolName: "cached_tool", severity: "read_only" }]);

  // 2. Second tools/list returns error response alongside result
  const listResp2 = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers,
    payload: { jsonrpc: "2.0", id: 3, method: "tools/list" }
  });
  expect(listResp2.json().error).toBeDefined();

  // Call cached_tool again -> prior state is preserved, severity remains read_only!
  await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers,
    payload: {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "cached_tool",
        arguments: { toolContextId: context.toolContextId }
      }
    }
  });
  expect(gatedActions).toEqual([
    { toolName: "cached_tool", severity: "read_only" },
    { toolName: "cached_tool", severity: "read_only" }
  ]);
});

test("two tenants with identically-named servers do not share proxy tool metadata cache", async () => {
  const gatedActions: Array<{ tenantId: string; toolName: string; severity: string }> = [];
  const policyService = {
    async gateAction(req: { tenantId: string; toolName: string; severity: string }) {
      gatedActions.push({ tenantId: req.tenantId, toolName: req.toolName, severity: req.severity });
      return {
        evaluation: { outcome: "allow", matchedRuleId: null, matchedRuleName: null, gating: false, explanation: null },
        enforced: false
      };
    },
    async evaluate() {
      return { outcome: "allow", matchedRuleId: null, matchedRuleName: null, gating: false, explanation: null };
    }
  };

  let readOnlyHint = true;
  const upstream = Fastify();
  upstream.post("/", async (request) => {
    const body = request.body as { id?: string | number; method?: string };
    if (body.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: body.id ?? 1,
        result: {
          tools: [
            {
              name: "delete_record",
              description: "Delete record",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint }
            }
          ]
        }
      };
    }
    return {
      jsonrpc: "2.0",
      id: body.id ?? 2,
      result: {
        isError: false,
        content: [{ type: "text", text: "done" }]
      }
    };
  });

  const upstreamUrl = await upstream.listen({ port: 0, host: "127.0.0.1" });
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`,
    policyService: policyService as never
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  // Tenant A: lists tools, caching delete_record as read_only
  const contextA = await createTestToolContext(toolContexts, {
    tenantId: "tenant-a",
    sessionId: "session-a",
    userId: "user-a",
    runtimeId: "runtime-a",
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"],
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "test-proxy"]
      }
    }
  });
  const headersA = {
    authorization: `Bearer ${runtimeToken({ tid: "tenant-a", sid: "session-a", uid: "user-a", rid: "runtime-a" })}`
  };

  const listRespA = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: headersA,
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" }
  });
  expect(listRespA.statusCode).toBe(200);

  // Tenant B: has server test-proxy, but has NOT run tools/list
  const contextB = await createTestToolContext(toolContexts, {
    tenantId: "tenant-b",
    sessionId: "session-b",
    userId: "user-b",
    runtimeId: "runtime-b",
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"],
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "test-proxy"]
      }
    }
  });
  const headersB = {
    authorization: `Bearer ${runtimeToken({ tid: "tenant-b", sid: "session-b", uid: "user-b", rid: "runtime-b" })}`
  };

  readOnlyHint = false;
  // Tenant B refreshes its own metadata before calling the tool.
  const callRespB = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: headersB,
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "delete_record",
        arguments: { toolContextId: contextB.toolContextId }
      }
    }
  });
  expect(callRespB.statusCode).toBe(200);

  // Tenant A calls delete_record on test-proxy
  const callRespA = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: headersA,
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "delete_record",
        arguments: { toolContextId: contextA.toolContextId }
      }
    }
  });
  expect(callRespA.statusCode).toBe(200);

  // Tenant B reads its own tool metadata when the local cache is empty.
  expect(gatedActions).toEqual([
    { tenantId: "tenant-b", toolName: "delete_record", severity: "file_change" },
    { tenantId: "tenant-a", toolName: "delete_record", severity: "read_only" }
  ]);
});

test("proxy tool/call forwards the framework-signed X-Framework identity and ignores caller-supplied headers", async () => {
  // End-to-end guard: a caller that supplies x-framework-user-id
  // must NOT have it forwarded — the framework's own signed identity wins.
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const sessionId = "session-proxy-headers";
  const context = await createTestToolContext(toolContexts, {
    sessionId,
    userId: "header-user",
    runtimeId: "runtime-header",
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"],
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "test-proxy"]
      }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: {
      authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "header-user", rid: "runtime-header" })}`,
      "x-framework-user-id": "spoofed-user"
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: {
          toolContextId: context.toolContextId,
          query: "hello"
        }
      }
    }
  });

  expect(response.statusCode).toBe(200);
  expect(toolCallRequests(upstreamRequests)).toHaveLength(1);
  expect(toolCallRequests(upstreamRequests)[0].headers["x-framework-user-id"]).toBe("header-user");
});

test("redacts credentials in a proxy tool result before returning to the runtime", async () => {
  // A proxy upstream that echoes an OpenAI-shaped key back in its result body.
  // The gateway must strip it at the boundary so it never lands in the durable
  // LangGraph checkpoint (restored into model context on later turns).
  const { upstream, upstreamUrl } = await createProxyMcpUpstream();
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const sessionId = "session-proxy-redact";
  const context = await createTestToolContext(toolContexts, {
    sessionId,
    userId: "redact-user",
    runtimeId: "runtime-redact",
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"],
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "test-proxy"]
      }
    }
  });

  const secret = "sk-abcdefghijklmnopqrstuvwxyz0123";
  const response = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: {
      authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "redact-user", rid: "runtime-redact" })}`
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: {
          toolContextId: context.toolContextId,
          query: `here is the key ${secret}`
        }
      }
    }
  });

  expect(response.statusCode).toBe(200);
  const body = response.body;
  expect(body).not.toContain(secret);
  expect(body).toContain("[REDACTED]");
});

test("scrubs an organization secret and token patterns from an upstream error before telemetry", async () => {
  // An opaque organization secret has no recognisable pattern, so only the
  // credential scrub can find it. The error envelope is forwarded as-is.
  const orgSecret = "org-opaque-credential-7f3a91";
  const githubToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const { upstream, upstreamUrl } = await createProxyMcpUpstream({
    respond: (body) => ({
      jsonrpc: "2.0", id: body.id ?? null,
      error: { code: -32001, message: `rejected ${orgSecret} and ${githubToken}`, data: { authorization: "raw-nested" } }
    })
  });
  const recordFailure = vi.fn(async () => undefined);
  const { app, toolContexts } = await createTestApp({
    resolveMcpServer: async (_tenant, serverId) => ({
      id: serverId, description: "Organization proxy", mode: "proxy", routePath: `/mcp/${serverId}`,
      upstreamUrl, transportKind: "http", version: 1, hash: "server-hash",
      credentialScope: "organization", credentialBindingId: "binding-org", credentialVersion: 1,
      upstreamAuth: { type: "bearer", secret: orgSecret }
    }),
    activationTracker: { async recordInvocation() {}, recordFailure, async recordSkillInvocationsForTool() { return []; } }
  });
  onTestFinished(async () => { await Promise.all([app.close(), upstream.close()]); });
  const sessionId = "session-org-error";
  const context = await createTestToolContext(toolContexts, { sessionId, userId: "org-user",
    metadata: { runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: ["test-proxy"] },
      mcpServerSources: [{ id: "test-proxy", hash: "server-hash", credentialVersion: 1 }] } });

  const response = await app.inject({ method: "POST", url: "/mcp/test-proxy",
    headers: { authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "org-user", rid: context.runtimeId })}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search", arguments: { toolContextId: context.toolContextId } } } });

  expect(response.statusCode).toBe(200);
  for (const leaked of [orgSecret, githubToken, "raw-nested"]) {
    expect(response.body).not.toContain(leaked);
    expect(JSON.stringify(recordFailure.mock.calls)).not.toContain(leaked);
  }
  expect(response.json().error.code).toBe(-32001);
  expect(recordFailure).toHaveBeenCalledTimes(1);
});

test.each(["code", "2.0", "message", "content"])(
  "a short organization secret (%s) cannot corrupt the JSON-RPC envelope",
  async (orgSecret) => {
    const { upstream, upstreamUrl } = await createProxyMcpUpstream({
      respond: (body) => ({
        jsonrpc: "2.0", id: body.id ?? null,
        error: { code: -32001, message: `upstream rejected ${orgSecret}` }
      })
    });
    const { app, toolContexts } = await createTestApp({
      resolveMcpServer: async (_tenant, serverId) => ({
        id: serverId, description: "Organization proxy", mode: "proxy", routePath: `/mcp/${serverId}`,
        upstreamUrl, transportKind: "http", version: 1, hash: "server-hash",
        credentialScope: "organization", credentialBindingId: "binding-org", credentialVersion: 1,
        upstreamAuth: { type: "bearer", secret: orgSecret }
      })
    });
    onTestFinished(async () => { await Promise.all([app.close(), upstream.close()]); });
    const sessionId = "session-short-secret";
    const context = await createTestToolContext(toolContexts, { sessionId, userId: "org-user",
      metadata: { runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: ["test-proxy"] },
        mcpServerSources: [{ id: "test-proxy", hash: "server-hash", credentialVersion: 1 }] } });

    const response = await app.inject({ method: "POST", url: "/mcp/test-proxy",
      headers: { authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "org-user", rid: context.runtimeId })}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "search", arguments: { toolContextId: context.toolContextId } } } });

    expect(response.json()).toEqual({
      jsonrpc: "2.0", id: 1, error: { code: -32001, message: "upstream rejected [REDACTED]" }
    });
  }
);

test("tools/list keeps proxy tool schemas whose parameter names look like credentials", async () => {
  const inputSchema = {
    type: "object",
    properties: {
      maxTokens: { type: "integer", minimum: 1 },
      token: { type: "string", description: "Page token from the previous call" }
    }
  };
  const { upstream, upstreamUrl } = await createProxyMcpUpstream({
    respond: (body) => ({ jsonrpc: "2.0", id: body.id ?? null,
      result: { tools: [{ name: "search", description: "Search", inputSchema }] } })
  });
  const { app, toolContexts } = await createTestApp({ proxyUpstreamUrl: upstreamUrl });
  onTestFinished(async () => { await Promise.all([app.close(), upstream.close()]); });
  const sessionId = "session-schema-names";
  const context = await createTestToolContext(toolContexts, { sessionId, userId: "schema-user",
    metadata: { runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: ["test-proxy"] } } });

  const response = await app.inject({ method: "POST", url: "/mcp/test-proxy",
    headers: { authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "schema-user", rid: context.runtimeId })}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });

  expect(response.json().result.tools).toEqual([{ name: "search", description: "Search", inputSchema }]);
});

test("strips policy approval metadata before dispatching to a managed tool handler", async () => {
  const receivedArguments: Record<string, unknown>[] = [];
  const { app, toolContexts } = await createTestApp({
    extraManagedTools: [
      {
        name: "capture_arguments",
        description: "Captures its arguments.",
        readOnly: true,
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        handler: async (input: { arguments: Record<string, unknown> }) => {
          receivedArguments.push(input.arguments);
          return { captured: true };
        }
      } as never
    ]
  });
  onTestFinished(async () => {
    await app.close();
  });

  const sessionId = "session-managed-policy-metadata";
  const context = await createTestToolContext(toolContexts, {
    sessionId,
    userId: "metadata-user",
    runtimeId: "runtime-metadata",
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "managed-session-context"],
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "capture_arguments"]
      }
    }
  });

  const response = await callManagedTool(app, { sid: sessionId, uid: "metadata-user", rid: "runtime-metadata" }, "capture_arguments", {
    toolContextId: context.toolContextId,
    query: "hello",
    policyApprovalId: "polapr_test",
    [POLICY_APPROVAL_MARKER_KEY]: { toolContextId: context.toolContextId }
  });

  expect(response.json().error).toBeUndefined();
  expect(receivedArguments).toEqual([
    { toolContextId: context.toolContextId, query: "hello" }
  ]);
});

test("strips policy approval metadata before forwarding proxy tool arguments", async () => {
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const sessionId = "session-proxy-policy-metadata";
  const context = await createTestToolContext(toolContexts, {
    sessionId,
    userId: "metadata-user",
    runtimeId: "runtime-metadata",
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"],
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "test-proxy"]
      }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: {
      authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "metadata-user", rid: "runtime-metadata" })}`
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: {
          toolContextId: context.toolContextId,
          query: "hello",
          policyApprovalId: "polapr_test",
          [POLICY_APPROVAL_MARKER_KEY]: { toolContextId: context.toolContextId }
        }
      }
    }
  });

  expect(response.json().error).toBeUndefined();
  expect(toolCallRequests(upstreamRequests)).toHaveLength(1);
  expect((toolCallRequests(upstreamRequests)[0].body.params as { arguments: Record<string, unknown> }).arguments)
    .toEqual({ query: "hello" });
});

function captureArgumentsTool(received: Record<string, unknown>[]) {
  return {
    name: "capture_arguments",
    description: "Captures its arguments.",
    readOnly: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    handler: async (input: { arguments: Record<string, unknown> }) => {
      received.push(input.arguments);
      return { captured: true };
    }
  } as never;
}

const captureRuntimePolicy = {
  ...testRuntimePolicy,
  enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "managed-session-context"],
  enabledToolIds: [...testRuntimePolicy.enabledToolIds, "capture_arguments"]
};

test("the request metadata names the tool context; a context id in the arguments is the model's and is ignored", async () => {
  const received: Record<string, unknown>[] = [];
  const { app, toolContexts } = await createTestApp({ extraManagedTools: [captureArgumentsTool(received)] });
  onTestFinished(async () => {
    await app.close();
  });
  const claims = { sid: "session-invocation", uid: "invocation-user", rid: "runtime-invocation" };
  const contextFor = (userId: string, runtimeId: string) => createTestToolContext(toolContexts, {
    sessionId: claims.sid, userId, runtimeId, metadata: { runtimePolicy: captureRuntimePolicy }
  });
  const current = await contextFor(claims.uid, claims.rid);
  const otherUser = await contextFor("other-user", claims.rid);
  const retiredRuntime = await contextFor(claims.uid, "runtime-retired");

  // The model wrote a context id that does not exist. The gateway uses the runtime's id in `_meta`.
  const response = await callManagedTool(app, claims, "capture_arguments",
    { toolContextId: "ctx_made_up_by_model", query: "hello" }, { toolContextId: current.toolContextId });
  expect(response.json().error).toBeUndefined();
  expect(received).toEqual([{ toolContextId: current.toolContextId, query: "hello" }]);

  // The metadata grants nothing itself. Its context must belong to the token's user and runtime.
  for (const context of [otherUser, retiredRuntime]) {
    const denied = await callManagedTool(app, claims, "capture_arguments",
      { toolContextId: current.toolContextId, query: "hello" }, { toolContextId: context.toolContextId });
    expect(denied.json().error).toEqual({ code: -32000, message: "Tool context does not belong to the authenticated runtime session." });
  }
  expect(received).toHaveLength(1);
});

test("refuses a call whose URL and request metadata name different tool contexts", async () => {
  const received: Record<string, unknown>[] = [];
  const { app, toolContexts } = await createTestApp({ extraManagedTools: [captureArgumentsTool(received)] });
  onTestFinished(async () => {
    await app.close();
  });
  const claims = { sid: "session-conflict", uid: "conflict-user", rid: "runtime-conflict" };
  const contextFor = () => createTestToolContext(toolContexts, {
    sessionId: claims.sid, userId: claims.uid, runtimeId: claims.rid, metadata: { runtimePolicy: captureRuntimePolicy }
  });
  const [first, second] = [await contextFor(), await contextFor()];
  const call = (urlContext: string) => app.inject({
    method: "POST", url: `/mcp/managed-session-context?toolContextId=${urlContext}`,
    headers: { authorization: `Bearer ${runtimeToken(claims)}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "capture_arguments", arguments: { query: "hello" }, ...invocationMeta({ toolContextId: first.toolContextId }) } }
  });

  expect((await call(second.toolContextId)).json().error)
    .toEqual({ code: -32602, message: "Invalid params: conflicting tool contexts." });
  expect(received).toEqual([]);
  expect((await call(first.toolContextId)).json().error).toBeUndefined();
  expect(received).toEqual([{ toolContextId: first.toolContextId, query: "hello" }]);
});

test.each([
  ["a _meta that is not an object", "ctx_test-1"],
  ["a _meta that is an array", [{ toolContextId: "ctx_test-1" }]],
  ["an entry that is not an object", { [MCP_INVOCATION_META_KEY]: "ctx_test-1" }],
  ["a context id that is not a string", { [MCP_INVOCATION_META_KEY]: { toolContextId: 7 } }],
  ["a context id of another format", { [MCP_INVOCATION_META_KEY]: { toolContextId: "rejected-context-value" } }],
  ["an unknown field", { [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_test-1", userId: "rejected-user-value" } }],
  ["an approval without its tool context", { [MCP_INVOCATION_META_KEY]: { policyApprovalId: "polapr_rejected_value" } }],
  ["an approval id of another format", { [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_test-1", policyApprovalId: "rejected-approval-value" } }]
])("refuses %s in the trusted invocation metadata without repeating it", async (_case, meta) => {
  const received: Record<string, unknown>[] = [];
  const { app, toolContexts } = await createTestApp({ extraManagedTools: [captureArgumentsTool(received)] });
  onTestFinished(async () => {
    await app.close();
  });
  const claims = { sid: "session-malformed", uid: "malformed-user", rid: "runtime-malformed" };
  const context = await createTestToolContext(toolContexts, {
    sessionId: claims.sid, userId: claims.uid, runtimeId: claims.rid, metadata: { runtimePolicy: captureRuntimePolicy }
  });
  const response = await app.inject({
    method: "POST", url: "/mcp/managed-session-context",
    headers: { authorization: `Bearer ${runtimeToken(claims)}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "capture_arguments", arguments: { toolContextId: context.toolContextId, query: "hello" }, _meta: meta } }
  });

  expect(response.json().error).toEqual({ code: -32602, message: "Invalid params: malformed invocation metadata." });
  expect(response.body).not.toMatch(/rejected-|polapr_/);
  expect(received).toEqual([]);
});

test("removes the trusted entry from the proxied request and keeps other request metadata", async () => {
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const { app, toolContexts } = await createTestApp({ proxyUpstreamUrl: `${upstreamUrl}/` });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });
  const claims = { sid: "session-proxy-meta", uid: "meta-user", rid: "runtime-proxy-meta" };
  const context = await createTestToolContext(toolContexts, {
    sessionId: claims.sid, userId: claims.uid, runtimeId: claims.rid,
    metadata: { runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"] } }
  });

  const response = await app.inject({
    method: "POST", url: "/mcp/test-proxy",
    headers: { authorization: `Bearer ${runtimeToken(claims)}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "echo", arguments: { query: "hello" },
      _meta: { progressToken: 7, "example.com/trace": { span: "s-1" }, [MCP_INVOCATION_META_KEY]: { toolContextId: context.toolContextId } }
    } }
  });

  expect(response.json().error).toBeUndefined();
  const [forwarded] = toolCallRequests(upstreamRequests);
  expect(forwarded!.body.params).toEqual({ name: "echo", arguments: { query: "hello" },
    _meta: { progressToken: 7, "example.com/trace": { span: "s-1" } } });
  expect(forwarded!.rawBody).not.toContain(MCP_INVOCATION_META_KEY);
  expect(forwarded!.rawBody).not.toContain(context.toolContextId);
});

test("redacts a managed tool result in content[0].text, not only structuredContent", async () => {
  // R15. handleManagedToolCall used to build content[0].text by
  // JSON.stringify-ing the RAW handler output, and only the finished envelope
  // was redacted afterwards. Walking a string applies the PATTERN rules, so a
  // recognisable `sk-ant-…` was caught either way — but key-based redaction
  // matches object KEYS, and once a value is inside a JSON string there are no
  // keys left to match. So a `{"password": "..."}` with no recognisable prefix
  // was blanked in structuredContent and left live in the text channel: the one
  // the model reads and the LangGraph checkpointer persists.
  const leaked = "hunter2-not-a-recognisable-prefix";
  const { app, toolContexts } = await createTestApp({
    extraManagedTools: [
      {
        name: "leaky_tool",
        description: "Returns a credential under a secret-looking key.",
        readOnly: true,
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        handler: async () => ({
          // Key-based redaction territory: the VALUE carries no prefix a
          // pattern could recognise, so only the key gives it away.
          connection: { host: "db.internal", password: leaked },
          apiKey: leaked
        })
      } as never
    ]
  });
  onTestFinished(async () => {
    await app.close();
  });

  const sessionId = "session-managed-redact";
  const context = await createTestToolContext(toolContexts, {
    sessionId,
    userId: "redact-user",
    runtimeId: "runtime-redact",
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "managed-session-context"],
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "leaky_tool"]
      }
    }
  });

  const response = await callManagedTool(app, { sid: sessionId, uid: "redact-user", rid: "runtime-redact" }, "leaky_tool",
    { toolContextId: context.toolContextId });

  expect(response.statusCode).toBe(200);
  const result = response.json().result as {
    content: Array<{ type: string; text: string }>;
    structuredContent: Record<string, unknown>;
  };

  // Both channels, not just the structured one.
  expect(result.content[0]!.text).not.toContain(leaked);
  expect(JSON.stringify(result.structuredContent)).not.toContain(leaked);
  expect(result.content[0]!.text).toContain("[REDACTED]");

  // And nothing anywhere in the response body.
  expect(response.body).not.toContain(leaked);
});

test("a managed tool handler's internal error never reaches the model", async () => {
  // R60. getErrorMessage relayed error.message unconditionally, so an E2B
  // sandbox id, an S3 bucket name or a pg relation name went into the JSON-RPC
  // error the model reads and the transcript stores.
  const { app, toolContexts } = await createTestApp({
    extraManagedTools: [
      {
        name: "exploding_tool",
        description: "Throws the way an SDK does.",
        readOnly: true,
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        handler: async () => {
          throw new Error(
            'relation "tenant_org_settings" does not exist at 10.0.4.17:5432, sandbox i7x9k2mq0zt4vabc'
          );
        }
      } as never
    ]
  });
  onTestFinished(async () => {
    await app.close();
  });

  const sessionId = "session-managed-error";
  const context = await createTestToolContext(toolContexts, {
    sessionId,
    userId: "error-user",
    runtimeId: "runtime-error",
    metadata: {
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "managed-session-context"],
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "exploding_tool"]
      }
    }
  });

  const response = await callManagedTool(app, { sid: sessionId, uid: "error-user", rid: "runtime-error" }, "exploding_tool",
    { toolContextId: context.toolContextId });

  expect(response.statusCode).toBe(200);
  expect(response.json().error).toEqual({ code: -32000, message: "Tool call failed." });
  expect(response.body).not.toContain("tenant_org_settings");
  expect(response.body).not.toContain("10.0.4.17");
  expect(response.body).not.toContain("i7x9k2mq0zt4vabc");
});

test.each(["https://mcp.example.test", "http://127.0.0.1:3108"])(
  "forwardRpc follows a bounded same-origin redirect from %s manually",
  async (origin) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: input.toString(), init: init ?? {} });
    if (calls.length === 1) {
      return new Response(null, { status: 307, headers: { location: "/mcp/v2" } });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const result = await forwardRpc(
    `${origin}/v1`,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { "X-Framework-User-Id": "u1" },
    fetchFn as never
  );

  expect(result.result).toEqual({ ok: true });
  expect(calls.map((call) => call.url)).toEqual([
    `${origin}/v1`,
    `${origin}/mcp/v2`
  ]);
  expect(calls[0]!.init.redirect).toBe("manual");
  expect(calls[1]!.init.headers).toMatchObject({ "X-Framework-User-Id": "u1" });
  }
);

test.each([
  ["scheme outside HTTP(S)", "file:///etc/passwd", /must use HTTP\(S\)/],
  ["HTTPS to HTTP cross-origin target", "http://mcp.example.test/v2", /cross-origin redirect/],
  ["private cross-origin target", "https://127.0.0.1/mcp", /cross-origin redirect/],
  ["cross-origin target", "https://attacker.example/mcp", /cross-origin redirect/]
])("forwardRpc rejects %s", async (_name, location, expectedMessage) => {
  let calls = 0;
  const result = await forwardRpc(
    "https://mcp.example.test/v1",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { "X-Framework-Signature": "secret" },
    (async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location } });
    }) as never
  );

  expect(result.error?.message).toMatch(expectedMessage);
  expect(calls).toBe(1);
});

test("forwardRpc rejects redirect loops after the maximum hop count", async () => {
  let calls = 0;
  const result = await forwardRpc(
    "https://mcp.example.test/v1",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {},
    (async () => {
      calls += 1;
      return new Response(null, { status: 307, headers: { location: `/mcp/${calls}` } });
    }) as never
  );

  expect(result.error?.message).toMatch(/redirect limit/);
  expect(calls).toBe(6);
});

// ---------------------------------------------------------------------------
// Proxy upstream transport limits (R14). A proxy upstream is a third party on
// the critical path of a turn: without a timeout it can hold the turn open
// until the watchdog fires, without a byte cap it can OOM the shared backend,
// and without shape validation whatever it returns is handed to the model as a
// tool result.
// ---------------------------------------------------------------------------

test("forwardRpc gives up on an upstream that never responds", async () => {
  const result = await forwardRpc(
    "https://mcp.example.test/v1",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {},
    (async (_input: string | URL, init?: RequestInit) => {
      // A real fetch honours the signal; model that rather than hanging the test.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        });
      });
    }) as never,
    { timeoutMs: 25 }
  );

  expect(result.error?.code).toBe(-32000);
  expect(result.error?.message).toMatch(/timed out after 25ms/);
});

test("forwardRpc arms a fresh timeout signal on every hop, not one for the chain", async () => {
  // The budget is per hop by design; a redirected call must not inherit the
  // first hop's already-elapsed signal. Two hops, two distinct signals.
  const signals: Array<AbortSignal | null | undefined> = [];
  let calls = 0;
  await forwardRpc(
    "https://mcp.example.test/v1",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {},
    (async (_input: string | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 307, headers: { location: "/mcp/v2" } });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200
      });
    }) as never,
    { timeoutMs: 5_000 }
  );

  expect(signals).toHaveLength(2);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(signals[1]).toBeInstanceOf(AbortSignal);
  expect(signals[0]).not.toBe(signals[1]);
});

test("forwardRpc leaves a diagnostic trail for the transport error it refuses to return", async () => {
  // The RPC error is a fixed string so an internal host never reaches the
  // model — which would be a blind spot rather than a fix if the failure went
  // unrecorded anywhere. Before the timeout existed, a fetch rejection escaped
  // as a Fastify 500 and Fastify logged it; that trail has to be replaced.
  //
  // The trail is an allowlisted classification, NOT the error object. This
  // test used to assert the log carried "10.0.4.17" — an internal address is
  // exactly the thing that should not be written to log retention, and the
  // same error message can quote the request URL with its credentials. See
  // mcp-upstream-client.test.ts for the leak cases.
  const warnings: Array<Record<string, unknown>> = [];
  const result = await forwardRpc(
    "https://mcp.example.test/v1",
    { jsonrpc: "2.0", id: 1, method: "tools/call" },
    {},
    (async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 10.0.4.17:8443"), {
          code: "ECONNREFUSED"
        })
      });
    }) as never,
    {
      logger: {
        warn: (obj: unknown) => {
          warnings.push(obj as Record<string, unknown>);
        }
      } as never
    }
  );

  expect(result.error?.message).toBe("Upstream MCP request failed.");
  expect(warnings).toHaveLength(1);
  // Enough to act on: which upstream, which method, what class of failure.
  // Origin only — the path is dropped because it can carry a credential; the
  // serverId the route passes is what distinguishes same-origin upstreams.
  expect(warnings[0]!.upstreamOrigin).toBe("https://mcp.example.test");
  expect(warnings[0]!.method).toBe("tools/call");
  expect(warnings[0]!.errorCode).toBe("ECONNREFUSED");
  expect(warnings[0]!.errorName).toBe("TypeError");
  // ...without the internal address the error carried.
  expect(warnings[0]!.error).toBeUndefined();
  expect(JSON.stringify(warnings[0])).not.toContain("10.0.4.17");
});

test("forwardRpc refuses a response body past the byte cap", async () => {
  const oversized = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { blob: "x".repeat(4_000) }
  });

  const result = await forwardRpc(
    "https://mcp.example.test/v1",
    { jsonrpc: "2.0", id: 1, method: "tools/call" },
    {},
    (async () => new Response(oversized, { status: 200 })) as never,
    { maxResponseBytes: 512 }
  );

  expect(result.error?.code).toBe(-32000);
  expect(result.error?.message).toMatch(/exceeded the maximum size of 512 bytes/);
  expect(result.result).toBeUndefined();
});

test("forwardRpc accepts a body at the cap", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });

  const result = await forwardRpc(
    "https://mcp.example.test/v1",
    { jsonrpc: "2.0", id: 1, method: "tools/call" },
    {},
    (async () => new Response(body, { status: 200 })) as never,
    { maxResponseBytes: Buffer.byteLength(body) }
  );

  expect(result.result).toEqual({ ok: true });
});

test("forwardRpc rejects a body that is not a JSON-RPC envelope", async () => {
  // Without the schema this array was handed to the model as a tool result.
  const result = await forwardRpc(
    "https://mcp.example.test/v1",
    { jsonrpc: "2.0", id: 1, method: "tools/call" },
    {},
    (async () => new Response(JSON.stringify([{ tool: "rm -rf /" }]), { status: 200 })) as never
  );

  expect(result.error?.code).toBe(-32000);
  expect(result.error?.message).toMatch(/not a valid JSON-RPC envelope/);
});

test("forwardRpc rejects a body that is not JSON at all", async () => {
  const result = await forwardRpc(
    "https://mcp.example.test/v1",
    { jsonrpc: "2.0", id: 1, method: "tools/call" },
    {},
    (async () => new Response("<html>502 Bad Gateway</html>", { status: 200 })) as never
  );

  expect(result.error?.code).toBe(-32000);
  expect(result.error?.message).toMatch(/not valid JSON/);
});

test("forwardRpc keeps MCP extension members on a valid envelope", async () => {
  const result = await forwardRpc(
    "https://mcp.example.test/v1",
    { jsonrpc: "2.0", id: 1, method: "tools/call" },
    {},
    (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true }, _meta: { trace: "abc" } }),
        { status: 200 }
      )) as never
  );

  expect(result.result).toEqual({ ok: true });
  expect((result as Record<string, unknown>)._meta).toEqual({ trace: "abc" });
});

test("forwardRpc returns a JSON-RPC error instead of throwing on a transport fault", async () => {
  // handleForwardedToolCall calls forwardRpc OUTSIDE its try block, so a throw
  // here would escape as an HTTP 500 outside the JSON-RPC envelope and the
  // runtime's MCP client could not read it as a tool failure.
  const result = await forwardRpc(
    "https://mcp.example.test/v1",
    { jsonrpc: "2.0", id: 1, method: "tools/call" },
    {},
    (async () => {
      throw new Error("connect ECONNREFUSED 10.0.4.17:8443");
    }) as never
  );

  expect(result.jsonrpc).toBe("2.0");
  expect(result.error?.code).toBe(-32000);
  // And the internal host it named is not in the message.
  expect(result.error?.message).toBe("Upstream MCP request failed.");
  expect(JSON.stringify(result)).not.toContain("10.0.4.17");
});

// Policy Center severity derivation: readOnly === true -> "read_only", else "file_change".
test("deriveActionSeverity: managed read-only tool → read_only", () => {
  expect(deriveActionSeverity("read_text_artifact", true)).toBe("read_only");
});

test("deriveActionSeverity: managed WRITE tool → file_change", () => {
  expect(deriveActionSeverity("github_write_file", false)).toBe("file_change");
  expect(deriveActionSeverity("write_artifact", false)).toBe("file_change");
});

test("deriveActionSeverity: forwarded/proxy tool (readOnly=null or undefined) defaults to file_change", () => {
  // Without upstream readOnlyHint metadata, proxy tool calls default to file_change (no name heuristics).
  expect(deriveActionSeverity("some_proxy_tool", null)).toBe("file_change");
  expect(deriveActionSeverity("Read", null)).toBe("file_change");
  expect(deriveActionSeverity("unknown", undefined)).toBe("file_change");
});

// ---------------------------------------------------------------------------
// Policy Center gateway end-to-end: block / require_approval route through the
// gateway and resume or deny. Enforcement is a TENANT-LEVEL switch on the
// runtime-policy snapshot (policyEnforcementMode), NOT a per-rule mode.
// ---------------------------------------------------------------------------

// Builds the runtime-policy snapshot stored on the tool-execution context.
// Defaults to "monitor" enforcement (records but never gates). Pass
// { policyEnforcementMode: "enforce" } when a test needs the rule to gate.
function seedRuntimePolicySnapshot(
  overrides: { policyEnforcementMode?: "monitor" | "enforce" } = {}
) {
  return {
    ...testRuntimePolicy,
    enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"],
    enabledToolIds: [...testRuntimePolicy.enabledToolIds, "test-proxy"],
    policyEnforcementMode:
      overrides.policyEnforcementMode ?? testRuntimePolicy.policyEnforcementMode
  };
}

async function buildProxyApp(
  policyService: Pick<PolicyService, "gateAction" | "evaluate">,
  // Tenant-level enforcement mode + extra tool-context metadata (e.g. turnContext)
  // the gateway reads for the turn-context dimension.
  options: {
    enforcementMode?: "monitor" | "enforce";
    extraMetadata?: Record<string, unknown>;
  } = {}
) {
  const { enforcementMode = "monitor", extraMetadata = {} } = options;
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const { app, toolContexts, approvals } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`,
    policyService
  });
  const toolContext = await createTestToolContext(toolContexts, {
    sessionId: "policy-session",
    userId: "test-user",
    runtimeId: "runtime-policy-session",
    metadata: {
      runtimePolicy: seedRuntimePolicySnapshot({ policyEnforcementMode: enforcementMode }),
      ...extraMetadata
    }
  });
  return { app, upstream, upstreamRequests, approvals, toolContext };
}

function callProxyTool(
  app: Awaited<ReturnType<typeof buildProxyApp>>["app"],
  args: Record<string, unknown>,
  invocation?: McpInvocationMetadata
) {
  return app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: { authorization: `Bearer ${runtimeToken({ sid: "policy-session", uid: "test-user" })}` },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: args, ...(invocation ? invocationMeta(invocation) : {}) }
    }
  });
}

/** The trusted values that the runtime sends with an approved call. */
function approvalMeta(proof: ReturnType<typeof createPolicyApprovalProof>): McpInvocationMetadata {
  return { toolContextId: proof.toolContextId, policyApprovalId: proof.approvalId };
}

function policyApprovalRecord(input: {
  proof: ReturnType<typeof createPolicyApprovalProof>;
  status: ApprovalRecord["status"];
  decision: ApprovalRecord["decision"];
}): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    approvalId: input.proof.approvalId,
    tenantId: "test-tenant",
    sessionId: "policy-session",
    userId: "test-user",
    runtimeId: "runtime-policy-session",
    turnId: "turn-1",
    itemId: input.proof.approvalId,
    requestMethod: POLICY_APPROVAL_REQUEST_METHOD,
    requestId: input.proof.approvalId,
    kind: "mcp_tool",
    title: "Approve echo",
    summary: "{}",
    status: input.status,
    decision: input.decision,
    requestPayload: { policyApproval: input.proof },
    createdAt: now,
    updatedAt: now,
    resolvedAt: input.status === "pending" ? null : now,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
}

test("enforce-mode require_approval → APPROVE forwards the call", async () => {
  const { service } = makePolicyService([
    makePolicyRule({ effect: "require_approval" })
  ]);
  const { app, upstream, upstreamRequests, approvals, toolContext } = await buildProxyApp(
    service,
    { enforcementMode: "enforce" }
  );
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const proof = createPolicyApprovalProof({
    toolContextId: toolContext.toolContextId,
    toolCallId: "call-1",
    toolName: "echo",
    serverId: "test-proxy",
    args: { query: "hello" },
    ruleId: "pol_test",
    explanation: "Approval required"
  });
  approvals.rows.set(proof.approvalId, policyApprovalRecord({ proof, status: "approved", decision: "approve" }));
  const response = await callProxyTool(app, { query: "hello" }, approvalMeta(proof));
  expect(response.statusCode).toBe(200);
  expect(response.json().error).toBeUndefined();
  expect(toolCallRequests(upstreamRequests)).toHaveLength(1);
  // The proof is for the gateway only. The upstream gets neither the entry nor an empty `_meta`.
  expect(toolCallRequests(upstreamRequests)[0]!.body.params).toEqual({ name: "echo", arguments: { query: "hello" } });
  expect(toolCallRequests(upstreamRequests)[0]!.rawBody).not.toContain(proof.approvalId);

  const replay = await callProxyTool(app, { query: "different" }, approvalMeta(proof));
  expect(replay.json().error.code).toBe(-32004);
  expect(toolCallRequests(upstreamRequests)).toHaveLength(1);

  // The same approved call cannot run twice on one approval.
  const reuse = await callProxyTool(app, { query: "hello" }, approvalMeta(proof));
  expect(reuse.json().error.code).toBe(-32004);
  expect(reuse.json().error.message).toMatch(/already used/i);
  expect(toolCallRequests(upstreamRequests)).toHaveLength(1);
});

test("managed tools consume an approval once and a mismatched call leaves it unused", async () => {
  const { service } = makePolicyService([makePolicyRule({ effect: "require_approval" })]);
  const handled: Record<string, unknown>[] = [];
  const { app, toolContexts, approvals } = await createTestApp({
    policyService: service,
    extraManagedTools: [{
      name: "capture_arguments", description: "Captures its arguments.", readOnly: false,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      handler: async (input: { arguments: Record<string, unknown> }) => {
        handled.push(input.arguments);
        return { captured: true };
      }
    } as never]
  });
  onTestFinished(async () => {
    await app.close();
  });
  const runtimePolicy = seedRuntimePolicySnapshot({ policyEnforcementMode: "enforce" });
  const toolContext = await createTestToolContext(toolContexts, {
    sessionId: "policy-session", userId: "test-user", runtimeId: "runtime-policy-session",
    metadata: { runtimePolicy: {
      ...runtimePolicy,
      enabledMcpServers: [...runtimePolicy.enabledMcpServers, "managed-session-context"],
      enabledToolIds: [...runtimePolicy.enabledToolIds, "capture_arguments"]
    } }
  });
  const proof = createPolicyApprovalProof({
    toolContextId: toolContext.toolContextId, toolCallId: "call-1", toolName: "capture_arguments",
    serverId: "managed-session-context", args: { query: "hello" }, ruleId: "pol_test", explanation: "Approval required"
  });
  approvals.rows.set(proof.approvalId, policyApprovalRecord({ proof, status: "approved", decision: "approve" }));
  const call = (query: string) => callManagedTool(app,
    { sid: "policy-session", uid: "test-user", rid: "runtime-policy-session" }, "capture_arguments",
    { toolContextId: toolContext.toolContextId, query }, approvalMeta(proof));

  expect((await call("different")).json().error.code).toBe(-32004);
  expect(handled).toEqual([]);
  expect((await call("hello")).json().error).toBeUndefined();
  expect(handled).toHaveLength(1);
  const reuse = await call("hello");
  expect(reuse.json().error.code).toBe(-32004);
  expect(reuse.json().error.message).toMatch(/already used/i);
  expect(handled).toHaveLength(1);
});

test.each([
  { status: "rejected" as const, decision: "reject" as const, message: /denied by approver/i },
  { status: "expired" as const, decision: null, message: /expired/i }
])("enforce-mode require_approval preserves a bound $status disposition", async ({ status, decision, message }) => {
  const { service } = makePolicyService([
    makePolicyRule({ effect: "require_approval", reason: "Needs sign-off." })
  ]);
  const { app, upstream, upstreamRequests, approvals, toolContext } = await buildProxyApp(
    service,
    { enforcementMode: "enforce" }
  );
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const proof = createPolicyApprovalProof({
    toolContextId: toolContext.toolContextId,
    toolCallId: "call-1",
    toolName: "echo",
    serverId: "test-proxy",
    args: { query: "hello" },
    ruleId: "pol_test",
    explanation: "Approval required"
  });
  approvals.rows.set(proof.approvalId, policyApprovalRecord({ proof, status, decision }));

  const response = await callProxyTool(app, { query: "hello" }, approvalMeta(proof));
  expect(response.json().error.code).toBe(-32004);
  expect(response.json().error.message).toMatch(message);
  expect(toolCallRequests(upstreamRequests)).toHaveLength(0);
});

test("an approval id in proxy tool arguments is not a proof: the call is denied and the approval stays unused", async () => {
  const { service } = makePolicyService([makePolicyRule({ effect: "require_approval" })]);
  const { app, upstream, upstreamRequests, approvals, toolContext } = await buildProxyApp(service, { enforcementMode: "enforce" });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });
  const proof = createPolicyApprovalProof({
    toolContextId: toolContext.toolContextId, toolCallId: "call-1", toolName: "echo", serverId: "test-proxy",
    args: { query: "hello" }, ruleId: "pol_test", explanation: "Approval required"
  });
  approvals.rows.set(proof.approvalId, policyApprovalRecord({ proof, status: "approved", decision: "approve" }));

  // The model writes the arguments, so even the id of a real approval of this exact call is only data there.
  const forged = await callProxyTool(app, { query: "hello", policyApprovalId: proof.approvalId });
  expect(forged.json().error.code).toBe(-32004);
  expect(approvals.get).not.toHaveBeenCalled();
  expect(approvals.consumed.size).toBe(0);
  expect(toolCallRequests(upstreamRequests)).toHaveLength(0);

  expect((await callProxyTool(app, { query: "hello" }, approvalMeta(proof))).json().error).toBeUndefined();
  expect(approvals.consumed.has(proof.approvalId)).toBe(true);
  expect(toolCallRequests(upstreamRequests)).toHaveLength(1);
});

test("an approval made in another tool context does not approve the call", async () => {
  const { service } = makePolicyService([makePolicyRule({ effect: "require_approval" })]);
  const { app, upstream, upstreamRequests, approvals, toolContext } = await buildProxyApp(service, { enforcementMode: "enforce" });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });
  const proof = createPolicyApprovalProof({
    toolContextId: "ctx_an_earlier_turn", toolCallId: "call-1", toolName: "echo", serverId: "test-proxy",
    args: { query: "hello" }, ruleId: "pol_test", explanation: "Approval required"
  });
  approvals.rows.set(proof.approvalId, policyApprovalRecord({ proof, status: "approved", decision: "approve" }));

  // The metadata names the current context and the earlier turn's approval.
  const response = await callProxyTool(app, { query: "hello" },
    { toolContextId: toolContext.toolContextId, policyApprovalId: proof.approvalId });
  expect(response.json().error.code).toBe(-32004);
  expect(approvals.consumed.size).toBe(0);
  expect(toolCallRequests(upstreamRequests)).toHaveLength(0);
});

test("enforce-mode require_approval without proof → denied", async () => {
  const { service } = makePolicyService([
    makePolicyRule({ effect: "require_approval" })
  ]);
  const { app, upstream, upstreamRequests } = await buildProxyApp(service, {
    enforcementMode: "enforce"
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const response = await callProxyTool(app, { query: "hello" });
  expect(response.json().error.code).toBe(-32004);
  expect(toolCallRequests(upstreamRequests)).toHaveLength(0);
});

test("enforce-mode block refuses before reaching the upstream", async () => {
  const { service } = makePolicyService([makePolicyRule({ effect: "block" })]);
  const { app, upstream, upstreamRequests } = await buildProxyApp(service, {
    enforcementMode: "enforce"
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const response = await callProxyTool(app, { query: "hello" });
  expect(response.json().error.code).toBe(-32004);
  expect(toolCallRequests(upstreamRequests)).toHaveLength(0);
});

test("monitor-mode block records intent but still forwards the call", async () => {
  // Default monitor snapshot: the rule is recorded but never gates.
  const { service, decisions } = makePolicyService([
    makePolicyRule({ effect: "block" })
  ]);
  const { app, upstream, upstreamRequests } = await buildProxyApp(service);
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const response = await callProxyTool(app, { query: "hello" });
  // Monitor mode never gates — the upstream still sees the call unchanged, but a
  // decision was recorded for the dashboard.
  expect(response.json().error).toBeUndefined();
  expect(toolCallRequests(upstreamRequests)).toHaveLength(1);
  const forwarded = toolCallRequests(upstreamRequests)[0].body.params as { arguments: Record<string, unknown> };
  expect(forwarded.arguments).toEqual({ query: "hello" });
  expect(decisions).toHaveLength(1);
});

// ── turnContext dimension end-to-end (from context metadata) ──

test("a turnContext=scheduled rule gates only when the context is marked scheduled", async () => {
  const { service } = makePolicyService([
    makePolicyRule({ effect: "block", conditions: { turnContexts: ["scheduled"] } })
  ]);
  // Context metadata marks this turn as scheduled → the rule gates (enforce mode).
  const scheduled = await buildProxyApp(service, {
    enforcementMode: "enforce",
    extraMetadata: { turnContext: "scheduled" }
  });
  onTestFinished(async () => {
    await Promise.all([scheduled.app.close(), scheduled.upstream.close()]);
  });
  const blocked = await callProxyTool(scheduled.app, { query: "x" });
  expect(blocked.json().error.code).toBe(-32004);
  expect(toolCallRequests(scheduled.upstreamRequests)).toHaveLength(0);
});

test("a turnContext=scheduled rule does NOT gate an interactive turn", async () => {
  const { service } = makePolicyService([
    makePolicyRule({ effect: "block", conditions: { turnContexts: ["scheduled"] } })
  ]);
  // turnContext=interactive in metadata → the scheduled-only rule doesn't match.
  const interactive = await buildProxyApp(service, {
    enforcementMode: "enforce",
    extraMetadata: { turnContext: "interactive" }
  });
  onTestFinished(async () => {
    await Promise.all([interactive.app.close(), interactive.upstream.close()]);
  });
  const ok = await callProxyTool(interactive.app, { query: "x" });
  expect(ok.json().error).toBeUndefined();
  expect(toolCallRequests(interactive.upstreamRequests)).toHaveLength(1);
});

const projectToolContext = {
  projectId: "project-1",
  agentFileMode: "read-only",
  snapshot: { files: [] }
};

test.each([
  { name: "scheduled turns", sessionId: "scheduled-project-tools",
    metadata: { turnContext: "scheduled", projectContext: projectToolContext } },
  { name: "standalone chats", sessionId: "standalone-project-tools",
    metadata: { turnContext: "interactive" } }
])("$name hide and reject project-category managed tools", async ({ sessionId, metadata }) => {
  const { app, toolContexts } = await createTestApp();
  onTestFinished(async () => { await app.close(); });

  const context = await createTestToolContext(toolContexts, {
    sessionId,
    runtimeId: `runtime-${sessionId}`,
    metadata: {
      ...metadata,
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "project_read_file"]
      }
    }
  });
  const headers = {
    authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "test-user" })}`
  };

  const listed = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    headers,
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" }
  });
  expect(listed.json().result.tools.some((tool: { name: string }) => tool.name === "project_read_file")).toBe(false);

  const called = await callManagedTool(app, { sid: sessionId, uid: "test-user" }, "project_read_file",
    { toolContextId: context.toolContextId });
  expect(called.json().error.message).toMatch(/only available during interactive project turns/);
});

test("interactive project turns list project-category managed tools", async () => {
  const { app, toolContexts } = await createTestApp();
  onTestFinished(async () => { await app.close(); });

  const sessionId = "interactive-project-tools";
  await createTestToolContext(toolContexts, {
    sessionId,
    runtimeId: `runtime-${sessionId}`,
    metadata: {
      turnContext: "interactive",
      projectContext: projectToolContext,
      runtimePolicy: {
        ...testRuntimePolicy,
        enabledToolIds: [...testRuntimePolicy.enabledToolIds, "project_read_file"]
      }
    }
  });

  const listed = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    headers: { authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "test-user" })}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" }
  });
  expect(listed.json().result.tools.some((tool: { name: string }) => tool.name === "project_read_file")).toBe(true);
});


test.each(["managed-session-context", "test-proxy"])(
  "%s attributes tool calls to the bound context's message instead of the latest turn",
  async (serverId) => {
    const { upstream, upstreamUrl } = await createProxyMcpUpstream();
    const recordSkillInvocationsForTool = vi.fn(async () => []);
    const { app, toolContexts } = await createTestApp({
      proxyUpstreamUrl: upstreamUrl,
      activationTracker: {
        async recordInvocation() {}, async recordFailure() {}, recordSkillInvocationsForTool
      },
      extraManagedTools: [{
        name: "telemetry_tool", description: "Telemetry fixture", readOnly: true,
        inputSchema: { type: "object" }, async handler() { return {}; }
      }]
    });
    onTestFinished(async () => { await Promise.all([app.close(), upstream.close()]); });
    const sessionId = "telemetry-session";
    const context = await createTestToolContext(toolContexts, {
      sessionId, messageId: "bound-message",
      metadata: { runtimePolicy: {
        ...testRuntimePolicy, enabledMcpServers: [serverId], enabledToolIds: ["telemetry_tool"]
      } }
    });
    await createTestToolContext(toolContexts, { sessionId, messageId: "later-message" });
    const response = await app.inject({
      method: "POST", url: `/mcp/${serverId}`,
      headers: { authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "test-user", rid: context.runtimeId })}` },
      payload: {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "telemetry_tool", arguments: { toolContextId: context.toolContextId } }
      }
    });
    expect(response.json().error).toBeUndefined();
    expect(recordSkillInvocationsForTool).toHaveBeenCalledExactlyOnceWith(
      { tenantId: "test-tenant", sessionId, messageId: "bound-message" },
      "telemetry_tool", { mcpServerId: serverId }
    );
  }
);

test.each([
  ["refuses", "GitHub reads are disabled for this organization.", 0],
  ["allows", null, 1]
] as const)("the gateway %s a managed tool call after the integration check", async (_name, refusal, handlerCalls) => {
  const handler = vi.fn(async () => ({ ok: true }));
  const checkToolCall = vi.fn(async () => refusal);
  const { app, toolContexts } = await createTestApp({
    extraManagedTools: [{
      name: "integration_probe", description: "Integration test", readOnly: true,
      inputSchema: { type: "object" }, handler
    }],
    integrationToolCalls: { checkToolCall }
  });
  onTestFinished(async () => { await app.close(); });
  const context = await createTestToolContext(toolContexts, {
    sessionId: "session-1", userId: "user-1", runtimeId: "runtime-1",
    metadata: {
      runtimePolicy: { ...testRuntimePolicy, enabledMcpServers: ["managed-session-context"], enabledToolIds: ["integration_probe"] },
      integrationAccounts: { github: "gh-1" }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    headers: { authorization: `Bearer ${runtimeToken({ sid: context.sessionId, uid: context.userId, rid: context.runtimeId })}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "integration_probe", arguments: { toolContextId: context.toolContextId }
    } }
  });

  // The check gets the account that the turn recorded at its start.
  expect(checkToolCall).toHaveBeenCalledWith({
    tenantId: "test-tenant", userId: "user-1", toolName: "integration_probe", boundAccounts: { github: "gh-1" }
  });
  expect(handler).toHaveBeenCalledTimes(handlerCalls);
  if (refusal) expect(response.json().error.message).toBe(refusal);
  else expect(response.json().error).toBeUndefined();
});
