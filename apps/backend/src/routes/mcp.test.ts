import { test, expect, onTestFinished } from "vitest";

import { phase4RuntimePolicy } from "../test-helpers/phase4-runtime-policy.js";
import { createProxyMcpUpstream } from "../test-helpers/mcp-route-test-support.js";
import { createTestApp, createTestToolContext } from "../test-helpers/routes-test-support.js";
import { generateRuntimeToken } from "../services/auth/runtime-token.js";
import { selectAllowlistedHeaders } from "./mcp.js";

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
