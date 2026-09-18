// Session deletion → durable runtime-data purge (bead im5e.3).
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

function makeFakeSessions() {
  const rows = new Map([
    [SESSION_ID, { sessionId: SESSION_ID, tenantId: OWNER.tenantId, userId: OWNER.userId }]
  ]);
  return {
    async remove(tenantId: string, sessionId: string, userId: string) {
      const row = rows.get(sessionId);
      if (!row || row.tenantId !== tenantId || row.userId !== userId) return false;
      rows.delete(sessionId);
      return true;
    }
  };
}

function makeAdapterSpy(id: string) {
  return {
    id,
    hasActiveTurn: () => false,
    hasSession: () => false,
    createSession: vi.fn(),
    runMessage: vi.fn(),
    abortSession: vi.fn(async () => {}),
    purgeSessionData: vi.fn(async () => {})
  };
}

async function makeApp() {
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
    sessions: makeFakeSessions(),
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
  });

  it("does not fail the delete when the adapter's purge throws", async () => {
    const { app, deepAgents } = await makeApp();
    deepAgents.purgeSessionData.mockRejectedValueOnce(new Error("checkpointer down"));
    const response = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}`,
      headers: { "x-tenant-id": OWNER.tenantId, "x-user-id": OWNER.userId }
    });
    expect(response.statusCode).toBe(204);
    expect(deepAgents.abortSession).toHaveBeenCalled();
  });
});
