import { test, expect, onTestFinished } from "vitest";

import type { PolicyRule } from "@cogniplane/shared-types";

import { phase4RuntimePolicy } from "../test-helpers/phase4-runtime-policy.js";
import { createProxyMcpUpstream } from "../test-helpers/mcp-route-test-support.js";
import { createTestApp, createTestToolContext } from "../test-helpers/routes-test-support.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { generateRuntimeToken } from "../services/auth/runtime-token.js";
import { PolicyService } from "../services/policy/policy-service.js";
import type { PolicyDecisionStore } from "../services/policy/policy-decision-store.js";
import type { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import { deriveActionSeverity, selectAllowlistedHeaders } from "./mcp.js";

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

// The MCP gateway resolves the runtime token with this secret (see
// routes-test-support.ts → registerMcpRoutes runtimeTokenSecret).
const RUNTIME_TOKEN_SECRET = "test-runtime-token-secret";

function runtimeToken(claims: { sid: string; uid: string; rid?: string }): string {
  return generateRuntimeToken(
    {
      sid: claims.sid,
      tid: "test-tenant",
      uid: claims.uid,
      rid: claims.rid ?? `runtime-${claims.sid}`
    },
    RUNTIME_TOKEN_SECRET
  );
}

// ---------------------------------------------------------------------------
// authz-1: arg/URL-supplied toolContextId must be bound to the runtime token's
// sid + uid, preventing same-tenant cross-user/session context substitution.
// ---------------------------------------------------------------------------

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
  const response = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    headers: {
      authorization: `Bearer ${runtimeToken({ sid: "attacker-session", uid: "attacker-user" })}`
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "session_context",
        arguments: {
          toolContextId: victimContext.toolContextId,
          recentMessageCount: 1
        }
      }
    }
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

  const response = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    headers: {
      authorization: `Bearer ${runtimeToken({ sid: session.sessionId, uid: "owner-user" })}`
    },
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
        ...phase4RuntimePolicy,
        enabledMcpServers: [...phase4RuntimePolicy.enabledMcpServers, "test-proxy"],
        enabledToolIds: [...phase4RuntimePolicy.enabledToolIds, "test-proxy"]
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

test("binding is skipped when no runtime token is present (dev-headers callers)", async () => {
  const { app, sessions, messages, toolContexts } = await createTestApp();
  onTestFinished(async () => {
    await app.close();
  });

  const session = await sessions.create("test-tenant", "test-user", "Dev session");
  await messages.create({
    tenantId: "test-tenant",
    sessionId: session.sessionId,
    userId: "test-user",
    role: "assistant",
    status: "completed",
    content: "Dev assistant message"
  });
  const context = await createTestToolContext(toolContexts, {
    sessionId: session.sessionId
  });

  // No Authorization header — the dev-headers preHandler authenticates the
  // request, and there is no runtime token to bind against.
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

  expect(response.statusCode).toBe(200);
  const payload = response.json();
  expect(payload.error).toBeUndefined();
  expect(payload.result.isError).toBe(false);
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
        ...phase4RuntimePolicy,
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
  await createTestToolContext(toolContexts, {
    sessionId,
    metadata: {
      runtimePolicy: {
        ...phase4RuntimePolicy,
        enabledMcpServers: [...phase4RuntimePolicy.enabledMcpServers, "test-proxy"]
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
  expect(upstreamRequests.length).toBe(1);
});

// ---------------------------------------------------------------------------
// headers-deadcfg: the server's headersAllowlist is forwarded to the upstream.
// ---------------------------------------------------------------------------

test("selectAllowlistedHeaders forwards allowlisted incoming headers (case-insensitive)", () => {
  const selected = selectAllowlistedHeaders(
    {
      "x-correlation-id": "abc-123",
      "x-custom-tenant": "acme",
      "x-not-listed": "should-be-dropped"
    },
    ["X-Correlation-Id", "X-Custom-Tenant"]
  );

  expect(selected).toEqual({
    "X-Correlation-Id": "abc-123",
    "X-Custom-Tenant": "acme"
  });
});

test("selectAllowlistedHeaders drops reserved X-Framework-* headers so callers cannot spoof signed identity", () => {
  const selected = selectAllowlistedHeaders(
    {
      "x-framework-user-id": "spoofed-user",
      "x-framework-signature": "forged",
      "x-correlation-id": "ok"
    },
    ["X-Framework-User-Id", "X-Framework-Signature", "X-Correlation-Id"]
  );

  expect(selected).toEqual({ "X-Correlation-Id": "ok" });
});

test("selectAllowlistedHeaders never forwards inbound credential headers even when explicitly allowlisted", () => {
  // The /mcp request carries the gateway runtime token in Authorization and may
  // carry session cookies; reflecting either to a third-party proxy upstream
  // would leak a replayable gateway credential. They must be dropped regardless
  // of the admin-configured allowlist.
  const selected = selectAllowlistedHeaders(
    {
      authorization: "Bearer rt_secret",
      "proxy-authorization": "Basic abc",
      cookie: "cogniplane_refresh=xyz",
      "x-api-key": "rt_key",
      "x-correlation-id": "ok"
    },
    ["Authorization", "Proxy-Authorization", "Cookie", "X-Api-Key", "X-Correlation-Id"]
  );

  expect(selected).toEqual({ "X-Correlation-Id": "ok" });
});

test("selectAllowlistedHeaders uses the first value for array-valued headers and skips missing ones", () => {
  const selected = selectAllowlistedHeaders(
    {
      "x-multi": ["first", "second"]
    },
    ["X-Multi", "X-Absent"]
  );

  expect(selected).toEqual({ "X-Multi": "first" });
});

test("proxy tool/call forwards the allowlisted X-Framework identity but never a caller-spoofed one", async () => {
  // End-to-end guard: the test proxy server's headersAllowlist includes the
  // reserved X-Framework-* names. A caller that supplies x-framework-user-id
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
        ...phase4RuntimePolicy,
        enabledMcpServers: [...phase4RuntimePolicy.enabledMcpServers, "test-proxy"],
        enabledToolIds: [...phase4RuntimePolicy.enabledToolIds, "test-proxy"]
      }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: {
      authorization: `Bearer ${runtimeToken({ sid: sessionId, uid: "header-user" })}`,
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
  expect(upstreamRequests.length).toBe(1);
  expect(upstreamRequests[0].headers["x-framework-user-id"]).toBe("header-user");
});

// Policy Center severity derivation. Managed tools carry an authoritative
// readOnly boolean; only forwarded/proxy tools (readOnly=null) fall back to
// name-based classification. This is the fix for the bug where managed write
// tools were name-classified as command_execution and never matched a
// `file_change` rule.
test("deriveActionSeverity: managed read-only tool → read_only", () => {
  expect(deriveActionSeverity("read_text_artifact", true)).toBe("read_only");
});

test("deriveActionSeverity: managed WRITE tool → file_change (not command_execution)", () => {
  // github_write_file is not a Claude SDK native name; the old code would have
  // name-classified it to command_execution. With readOnly=false it must be
  // file_change so `severities: [\"file_change\"]` rules match managed writes.
  expect(deriveActionSeverity("github_write_file", false)).toBe("file_change");
  expect(deriveActionSeverity("write_artifact", false)).toBe("file_change");
});

test("deriveActionSeverity: forwarded/proxy tool (readOnly=null) falls back to name classification", () => {
  // Unknown proxy tool name → command_execution (the classifier's default).
  expect(deriveActionSeverity("some_proxy_tool", null)).toBe("command_execution");
  // A name the classifier DOES know is still honored on the fallback path.
  expect(deriveActionSeverity("Read", null)).toBe("read_only");
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
    ...phase4RuntimePolicy,
    enabledMcpServers: [...phase4RuntimePolicy.enabledMcpServers, "test-proxy"],
    enabledToolIds: [...phase4RuntimePolicy.enabledToolIds, "test-proxy"],
    policyEnforcementMode:
      overrides.policyEnforcementMode ?? phase4RuntimePolicy.policyEnforcementMode
  };
}

async function buildProxyApp(
  policyService: unknown,
  requestPolicyApproval?: (input: {
    tenantId: string; sessionId: string; userId: string; runtimeId: string | null;
    toolName: string; serverId: string | null;
    severity: "read_only" | "file_change" | "command_execution"; explanation: string;
  }) => Promise<"approve" | "reject" | "expired" | null>,
  // Tenant-level enforcement mode + extra tool-context metadata (e.g. turnContext)
  // the gateway reads for the turn-context dimension.
  options: {
    enforcementMode?: "monitor" | "enforce";
    extraMetadata?: Record<string, unknown>;
  } = {}
) {
  const { enforcementMode = "monitor", extraMetadata = {} } = options;
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`,
    policyService,
    requestPolicyApproval
  });
  await createTestToolContext(toolContexts, {
    sessionId: "policy-session",
    userId: "test-user",
    runtimeId: "runtime-policy-session",
    metadata: {
      runtimePolicy: seedRuntimePolicySnapshot({ policyEnforcementMode: enforcementMode }),
      ...extraMetadata
    }
  });
  return { app, upstream, upstreamRequests };
}

function callProxyTool(app: Awaited<ReturnType<typeof buildProxyApp>>["app"], args: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    headers: { authorization: `Bearer ${runtimeToken({ sid: "policy-session", uid: "test-user" })}` },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: args }
    }
  });
}

test("enforce-mode require_approval → APPROVE forwards the call", async () => {
  const { service } = makePolicyService([
    makePolicyRule({ effect: "require_approval" })
  ]);
  const approvalCalls: unknown[] = [];
  const { app, upstream, upstreamRequests } = await buildProxyApp(
    service,
    async (input) => {
      approvalCalls.push(input);
      return "approve";
    },
    { enforcementMode: "enforce" }
  );
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const response = await callProxyTool(app, { query: "hello" });
  expect(response.statusCode).toBe(200);
  expect(response.json().error).toBeUndefined();
  expect(approvalCalls).toHaveLength(1);
  expect(upstreamRequests.length).toBe(1);
});

test("enforce-mode require_approval → REJECT refuses the call with a -32004 error", async () => {
  const { service } = makePolicyService([
    makePolicyRule({ effect: "require_approval", reason: "Needs sign-off." })
  ]);
  const { app, upstream, upstreamRequests } = await buildProxyApp(
    service,
    async () => "reject",
    { enforcementMode: "enforce" }
  );
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const response = await callProxyTool(app, { query: "hello" });
  expect(response.statusCode).toBe(200); // JSON-RPC errors ride a 200
  expect(response.json().error.code).toBe(-32004);
  // Refused → never forwarded upstream.
  expect(upstreamRequests.length).toBe(0);
});

test("enforce-mode require_approval with no adapter to host it → denied", async () => {
  const { service } = makePolicyService([
    makePolicyRule({ effect: "require_approval" })
  ]);
  // No requestPolicyApproval override → harness default returns null (no turn).
  const { app, upstream, upstreamRequests } = await buildProxyApp(service, undefined, {
    enforcementMode: "enforce"
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const response = await callProxyTool(app, { query: "hello" });
  expect(response.json().error.code).toBe(-32004);
  expect(upstreamRequests.length).toBe(0);
});

test("enforce-mode block refuses before reaching the upstream", async () => {
  const { service } = makePolicyService([makePolicyRule({ effect: "block" })]);
  const { app, upstream, upstreamRequests } = await buildProxyApp(service, undefined, {
    enforcementMode: "enforce"
  });
  onTestFinished(async () => {
    await Promise.all([app.close(), upstream.close()]);
  });

  const response = await callProxyTool(app, { query: "hello" });
  expect(response.json().error.code).toBe(-32004);
  expect(upstreamRequests.length).toBe(0);
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
  expect(upstreamRequests.length).toBe(1);
  const forwarded = upstreamRequests[0].body.params as { arguments: Record<string, unknown> };
  expect(forwarded.arguments).toEqual({ query: "hello" });
  expect(decisions).toHaveLength(1);
});

// ── turnContext dimension end-to-end (from context metadata) ──

test("a turnContext=scheduled rule gates only when the context is marked scheduled", async () => {
  const { service } = makePolicyService([
    makePolicyRule({ effect: "block", conditions: { turnContexts: ["scheduled"] } })
  ]);
  // Context metadata marks this turn as scheduled → the rule gates (enforce mode).
  const scheduled = await buildProxyApp(service, undefined, {
    enforcementMode: "enforce",
    extraMetadata: { turnContext: "scheduled" }
  });
  onTestFinished(async () => {
    await Promise.all([scheduled.app.close(), scheduled.upstream.close()]);
  });
  const blocked = await callProxyTool(scheduled.app, { query: "x" });
  expect(blocked.json().error.code).toBe(-32004);
  expect(scheduled.upstreamRequests.length).toBe(0);
});

test("a turnContext=scheduled rule does NOT gate an interactive turn", async () => {
  const { service } = makePolicyService([
    makePolicyRule({ effect: "block", conditions: { turnContexts: ["scheduled"] } })
  ]);
  // turnContext=interactive in metadata → the scheduled-only rule doesn't match.
  const interactive = await buildProxyApp(service, undefined, {
    enforcementMode: "enforce",
    extraMetadata: { turnContext: "interactive" }
  });
  onTestFinished(async () => {
    await Promise.all([interactive.app.close(), interactive.upstream.close()]);
  });
  const ok = await callProxyTool(interactive.app, { query: "x" });
  expect(ok.json().error).toBeUndefined();
  expect(interactive.upstreamRequests.length).toBe(1);
});
