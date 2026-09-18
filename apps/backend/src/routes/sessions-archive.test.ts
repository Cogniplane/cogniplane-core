import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerSessionRoutes, type SessionRouteStores } from "./sessions.js";
import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import type { SessionRecord } from "../services/session-store.js";

const sessionId = "0198c0de-0000-7000-8000-000000000001";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function setup(status: SessionRecord["status"] = "active") {
  const app = Fastify();
  apps.push(app);
  const session: SessionRecord = { sessionId, userId: "user", sessionName: "Research", status,
    createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z" };
  const activeTurns = new ActiveTurnsRegistry();
  const setArchived = vi.fn(async (_tenant: string, _id: string, _user: string, archived: boolean): Promise<SessionRecord | null> => ({ ...session, status: archived ? "archived" : "active" }));
  const restoreDeleted = vi.fn(async () => null);
  const getReadable = vi.fn(async () => session as SessionRecord | null);
  const auditEvents = { create: vi.fn(async () => {}) };
  const adapter = { hasActiveTurn: vi.fn(() => false), abortSession: vi.fn(), purgeSessionData: vi.fn() };
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, { sessions: { getReadable, setArchived, restoreDeleted }, activeTurns, runtimeAdapter: adapter, auditEvents } as unknown as SessionRouteStores);
  return { app, setArchived, getReadable, restoreDeleted, activeTurns, adapter, auditEvents };
}

it.each(["archive", "restore"])("%s changes metadata without aborting or purging runtime data", async (action) => {
  const h = await setup(action === "archive" ? "active" : "archived");
  const response = await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/${action}` });
  expect(response.statusCode).toBe(200);
  expect(response.json().session.status).toBe(action === "archive" ? "archived" : "active");
  expect(h.setArchived).toHaveBeenCalledWith("tenant", sessionId, "user", action === "archive");
  expect(h.activeTurns.snapshot().has(sessionId)).toBe(false);
  expect(h.auditEvents.create).toHaveBeenCalledExactlyOnceWith({
    tenantId: "tenant", sessionId, userId: "user",
    type: action === "archive" ? "session.archived" : "session.restored",
    payload: { previousStatus: action === "archive" ? "active" : "archived", status: action === "archive" ? "archived" : "active", purpose: "normal" }
  });
  expect(h.adapter.abortSession).not.toHaveBeenCalled();
  expect(h.adapter.purgeSessionData).not.toHaveBeenCalled();
});

it.each(["registry", "adapter"])("rejects an active turn reported by the %s", async (source) => {
  const h = await setup();
  if (source === "registry") h.activeTurns.mark(sessionId);
  else h.adapter.hasActiveTurn.mockReturnValue(true);
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/archive` })).statusCode).toBe(409);
  expect(h.setArchived).not.toHaveBeenCalled();
  expect(h.auditEvents.create).not.toHaveBeenCalled();
  if (source === "registry") expect(h.activeTurns.snapshot().has(sessionId)).toBe(true);
});

it.each(["archive", "restore"])("rejects inaccessible or deleted sessions for %s", async (action) => {
  const h = await setup("deleted");
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/${action}` })).statusCode).toBe(404);
  h.getReadable.mockResolvedValue(null);
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/${action}` })).statusCode).toBe(404);
  expect(h.setArchived).not.toHaveBeenCalled();
  expect(h.auditEvents.create).not.toHaveBeenCalled();
});

it("holds the turn reservation through the archive write and releases it on conflict or failure", async () => {
  const h = await setup();
  h.setArchived.mockImplementationOnce(async () => {
    expect(h.activeTurns.snapshot().has(sessionId)).toBe(true);
    return null;
  });
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/archive` })).statusCode).toBe(409);
  expect(h.activeTurns.snapshot().has(sessionId)).toBe(false);
  h.setArchived.mockRejectedValueOnce(new Error("database unavailable"));
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/archive` })).statusCode).toBe(500);
  expect(h.activeTurns.snapshot().has(sessionId)).toBe(false);
  expect(h.auditEvents.create).not.toHaveBeenCalled();
});


it.each(["archive", "restore"])("does not audit a no-op %s retry", async (action) => {
  const h = await setup(action === "archive" ? "archived" : "active");
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/${action}` })).statusCode).toBe(200);
  expect(h.setArchived).not.toHaveBeenCalled();
  expect(h.auditEvents.create).not.toHaveBeenCalled();
});

it.each(["archive", "restore"])("keeps a project %s retry idempotent", async (action) => {
  const h = await setup(action === "archive" ? "archived" : "active");
  h.getReadable.mockResolvedValue({
    sessionId,
    userId: "user",
    sessionName: "Research",
    status: action === "archive" ? "archived" : "active",
    projectId: "project",
    createdAt: "2026-09-13T12:00:00Z",
    updatedAt: "2026-09-13T12:00:00Z"
  });
  h.setArchived.mockResolvedValue({
    sessionId,
    userId: "user",
    sessionName: "Research",
    status: action === "archive" ? "archived" : "active",
    projectId: "project",
    createdAt: "2026-09-13T12:00:00Z",
    updatedAt: "2026-09-13T12:00:00Z"
  });
  const response = await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/${action}` });
  expect(response.statusCode).toBe(200);
  expect(response.json().session.status).toBe(action === "archive" ? "archived" : "active");
  expect(h.setArchived).toHaveBeenCalledWith("tenant", sessionId, "user", action === "archive");
});

it("keeps a completed transition successful and releases the reservation when audit writing fails", async () => {
  const h = await setup();
  h.auditEvents.create.mockRejectedValueOnce(new Error("audit unavailable"));
  const response = await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/archive` });
  expect(response.statusCode).toBe(200);
  expect(response.json().session.status).toBe("archived");
  expect(h.activeTurns.snapshot().has(sessionId)).toBe(false);
});
