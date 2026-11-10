// Session deletion → durable runtime-data purge.
//
// The Deep Agents checkpointer tables have no tenant column and no RLS —
// tenant→thread isolation is enforced at the app layer because thread_id is
// the session id and every route resolves the session through the
// tenant-scoped session store first. These tests pin that boundary at the
// route level: a foreign tenant's DELETE 404s BEFORE any adapter purge runs.

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerSessionRoutes, type SessionRouteStores } from "./sessions.js";

const OWNER = { tenantId: "tenant-a", userId: "user-a" };
const SESSION_ID = "0198c0de-0000-7000-8000-000000000001";

function makeFakeSessions(sandboxId: string | null) {
  const rows = new Map([
    [SESSION_ID, { sessionId: SESSION_ID, tenantId: OWNER.tenantId, userId: OWNER.userId, sandboxId }]
  ]);
  return {
    async remove(tenantId: string, sessionId: string, userId: string) {
      const row = rows.get(sessionId);
      if (!row || row.tenantId !== tenantId || row.userId !== userId) return null;
      rows.delete(sessionId);
      return { releasedSandboxId: row.sandboxId };
    }
  };
}

function makeAdapterSpy(id: string) {
  const calls: string[] = [];
  return {
    id,
    calls,
    hasActiveTurn: () => false,
    hasSession: () => false,
    createSession: vi.fn(),
    runMessage: vi.fn(),
    abortSession: vi.fn(async () => { calls.push("abortSession"); }),
    purgeSessionData: vi.fn(async () => {}),
    destroySandbox: vi.fn(async (_input: { tenantId: string; sessionId: string; sandboxId: string }) => {
      calls.push("destroySandbox");
      return "killed" as const;
    })
  };
}

async function makeApp(sandboxId: string | null = "sandbox-one") {
  const app = Fastify();
  const deepAgents = makeAdapterSpy("deep-agents");
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() ?? "anon",
      tenantId: request.headers["x-tenant-id"]?.toString() ?? "anon-tenant",
      isAdmin: false,
      role: "member" as const
    };
  });
  await registerSessionRoutes(app, {
    sessions: makeFakeSessions(sandboxId),
    messages: {},
    runtimeAdapter: deepAgents,
    limits: { consumeRateLimit: async () => null }
  } as unknown as SessionRouteStores);
  return { app, deepAgents };
}

describe("DELETE /sessions/:sessionId recovery", () => {
  it("keeps durable runtime data available during the recovery window", async () => {
    const { app, deepAgents } = await makeApp();
    const response = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}`,
      headers: { "x-tenant-id": OWNER.tenantId, "x-user-id": OWNER.userId }
    });
    expect(response.statusCode).toBe(204);
    expect(deepAgents.purgeSessionData).not.toHaveBeenCalled();
  });

  it("404s a foreign tenant before any purge or abort runs (thread-ownership boundary)", async () => {
    const { app, deepAgents } = await makeApp();
    const response = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}`,
      headers: { "x-tenant-id": "tenant-b", "x-user-id": "user-b" }
    });
    expect(response.statusCode).toBe(404);
    expect(deepAgents.purgeSessionData).not.toHaveBeenCalled();
    expect(deepAgents.abortSession).not.toHaveBeenCalled();
    expect(deepAgents.destroySandbox).not.toHaveBeenCalled();
  });

  it("does not fail the delete when the adapter's abort throws", async () => {
    const { app, deepAgents } = await makeApp();
    deepAgents.abortSession.mockRejectedValueOnce(new Error("runtime down"));
    const response = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}`,
      headers: { "x-tenant-id": OWNER.tenantId, "x-user-id": OWNER.userId }
    });
    expect(response.statusCode).toBe(204);
    expect(deepAgents.abortSession).toHaveBeenCalled();
    expect(deepAgents.destroySandbox).toHaveBeenCalledOnce();
  });
});

// The store took the saved sandbox in the transaction that trashed the session, and
// no runtime can adopt it now. The route stops the local runtime first, so that no
// operation of it meets the killed sandbox, and then kills the sandbox by id.
describe("DELETE /sessions/:sessionId sandbox", () => {
  const owner = { "x-tenant-id": OWNER.tenantId, "x-user-id": OWNER.userId };

  it("kills the sandbox that the delete took from the session, after the local runtime stops", async () => {
    const { app, deepAgents } = await makeApp("sandbox-one");
    const response = await app.inject({ method: "DELETE", url: `/sessions/${SESSION_ID}`, headers: owner });
    expect(response.statusCode).toBe(204);
    expect(deepAgents.destroySandbox).toHaveBeenCalledExactlyOnceWith({
      tenantId: OWNER.tenantId, sessionId: SESSION_ID, sandboxId: "sandbox-one"
    });
    expect(deepAgents.calls).toEqual(["abortSession", "destroySandbox"]);
  });

  it("kills nothing when the session had no saved sandbox", async () => {
    const { app, deepAgents } = await makeApp(null);
    const response = await app.inject({ method: "DELETE", url: `/sessions/${SESSION_ID}`, headers: owner });
    expect(response.statusCode).toBe(204);
    expect(deepAgents.destroySandbox).not.toHaveBeenCalled();
  });

  it("does not fail the committed delete when the kill throws", async () => {
    const { app, deepAgents } = await makeApp("sandbox-one");
    deepAgents.destroySandbox.mockRejectedValueOnce(new Error("provider down"));
    const response = await app.inject({ method: "DELETE", url: `/sessions/${SESSION_ID}`, headers: owner });
    expect(response.statusCode).toBe(204);
    expect(deepAgents.destroySandbox).toHaveBeenCalledOnce();
  });
});
