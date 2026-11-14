import { expect, it, vi } from "vitest";
import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import type { AuditEventInput } from "../services/audit-event-store.js";
import type { SessionLifecycleAudit, SessionRecord } from "../services/session-store.js";
import { sessionRoutesApp } from "../test-helpers/session-routes-app.js";

const sessionId = "0198c0de-0000-7000-8000-000000000001";

// The fake store writes the lifecycle event as SessionStore does, in the
// transaction of the change: `events` holds the committed events, and when
// `failEvent` is set the event fails and the change rolls back.
async function setup(status: SessionRecord["status"] = "active") {
  const session: SessionRecord = { sessionId, projectId: null, userId: "user", sessionName: "Research", status,
    createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z", transcriptFormat: "current" };
  const activeTurns = new ActiveTurnsRegistry();
  const events: AuditEventInput[] = [];
  const store = { failEvent: false };
  const commitEvent = (audit: SessionLifecycleAudit | undefined, previousStatus: SessionRecord["status"], next: SessionRecord) => {
    if (!audit) return;
    const event = audit({ previousStatus, status: next.status, purpose: next.purpose ?? "normal" });
    if (store.failEvent) throw new Error("audit unavailable");
    events.push(event);
  };
  const setArchived = vi.fn(async (_tenant: string, _id: string, _user: string, archived: boolean,
    audit?: SessionLifecycleAudit): Promise<{ session: SessionRecord; releasedSandboxId: string | null } | null> => {
    const next: SessionRecord = { ...session, status: archived ? "archived" : "active" };
    commitEvent(audit, session.status, next);
    return { session: next, releasedSandboxId: null };
  });
  // By default nothing is in the trash: restore falls through to the archive path.
  const restoreDeleted = vi.fn(async (_tenant: string, _id: string, _user: string,
    _audit?: SessionLifecycleAudit): Promise<SessionRecord | null> => null);
  const restoreFromTrash = async (_tenant: string, _id: string, _user: string, audit?: SessionLifecycleAudit) => {
    const next: SessionRecord = { ...session, status: "active" };
    commitEvent(audit, session.status, next);
    return next;
  };
  const getReadable = vi.fn(async () => session as SessionRecord | null);
  const auditEvents = { create: vi.fn(async () => {}) };
  const adapter = { hasActiveTurn: vi.fn(() => false), abortSession: vi.fn(), purgeSessionData: vi.fn(),
    destroySandbox: vi.fn(async (_input: { tenantId: string; sessionId: string; sandboxId: string }) => "killed" as const) };
  const app = await sessionRoutesApp({ sessions: { getReadable, setArchived, restoreDeleted }, activeTurns, runtimeAdapter: adapter, auditEvents });
  return { app, setArchived, getReadable, restoreDeleted, restoreFromTrash, activeTurns, adapter, auditEvents, events, store, commitEvent };
}

it.each(["archive", "restore"])("%s changes metadata without aborting or purging runtime data", async (action) => {
  const h = await setup(action === "archive" ? "active" : "archived");
  const response = await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/${action}` });
  expect(response.statusCode).toBe(200);
  expect(response.json().session.status).toBe(action === "archive" ? "archived" : "active");
  expect(h.setArchived).toHaveBeenCalledWith("tenant", sessionId, "user", action === "archive", expect.any(Function));
  expect(h.activeTurns.isBusy(sessionId)).toBe(false);
  expect(h.events).toEqual([{
    tenantId: "tenant", sessionId, userId: "user",
    type: action === "archive" ? "session.archived" : "session.restored",
    payload: { previousStatus: action === "archive" ? "active" : "archived", status: action === "archive" ? "archived" : "active", purpose: "normal" }
  }]);
  // The route writes no standalone event after the commit.
  expect(h.auditEvents.create).not.toHaveBeenCalled();
  expect(h.adapter.abortSession).not.toHaveBeenCalled();
  expect(h.adapter.purgeSessionData).not.toHaveBeenCalled();
  expect(h.adapter.destroySandbox).not.toHaveBeenCalled();
});

it.each(["registry", "adapter"])("rejects an active turn reported by the %s", async (source) => {
  const h = await setup();
  if (source === "registry") h.activeTurns.mark(sessionId);
  else h.adapter.hasActiveTurn.mockReturnValue(true);
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/archive` })).statusCode).toBe(409);
  expect(h.setArchived).not.toHaveBeenCalled();
  expect(h.events).toEqual([]);
  expect(h.auditEvents.create).not.toHaveBeenCalled();
  if (source === "registry") expect(h.activeTurns.snapshot().has(sessionId)).toBe(true);
});

it.each(["archive", "restore"])("rejects inaccessible or deleted sessions for %s", async (action) => {
  const h = await setup("deleted");
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/${action}` })).statusCode).toBe(404);
  h.getReadable.mockResolvedValue(null);
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/${action}` })).statusCode).toBe(404);
  expect(h.setArchived).not.toHaveBeenCalled();
  expect(h.events).toEqual([]);
  expect(h.auditEvents.create).not.toHaveBeenCalled();
});

it("holds the turn reservation through the archive write and releases it on conflict or failure", async () => {
  const h = await setup();
  h.setArchived.mockImplementationOnce(async () => {
    expect(h.activeTurns.isBusy(sessionId)).toBe(true);
    expect(h.activeTurns.snapshot().has(sessionId)).toBe(false);
    return null;
  });
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/archive` })).statusCode).toBe(409);
  expect(h.activeTurns.isBusy(sessionId)).toBe(false);
  h.setArchived.mockRejectedValueOnce(new Error("database unavailable"));
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/archive` })).statusCode).toBe(500);
  expect(h.activeTurns.isBusy(sessionId)).toBe(false);
  expect(h.events).toEqual([]);
  expect(h.auditEvents.create).not.toHaveBeenCalled();
});


it.each(["archive", "restore"])("does not audit a no-op %s retry", async (action) => {
  const h = await setup(action === "archive" ? "archived" : "active");
  expect((await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/${action}` })).statusCode).toBe(200);
  expect(h.setArchived).not.toHaveBeenCalled();
  expect(h.events).toEqual([]);
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
    updatedAt: "2026-09-13T12:00:00Z",
    transcriptFormat: "current"
  });
  h.setArchived.mockResolvedValue({
    session: {
      sessionId,
      userId: "user",
      sessionName: "Research",
      status: action === "archive" ? "archived" : "active",
      projectId: "project",
      createdAt: "2026-09-13T12:00:00Z",
      updatedAt: "2026-09-13T12:00:00Z",
      transcriptFormat: "current"
    },
    releasedSandboxId: null
  });
  const response = await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/${action}` });
  expect(response.statusCode).toBe(200);
  expect(response.json().session.status).toBe(action === "archive" ? "archived" : "active");
  expect(h.setArchived).toHaveBeenCalledWith("tenant", sessionId, "user", action === "archive", expect.any(Function));
  // The store changed nothing, so it called no audit builder.
  expect(h.events).toEqual([]);
  expect(h.auditEvents.create).not.toHaveBeenCalled();
});

// The event is in the transaction of the change: when it fails, the archive rolls
// back, so the route kills no sandbox and reports the failure.
it("fails the archive, kills nothing and releases the reservation when its audit event fails", async () => {
  const h = await setup();
  h.store.failEvent = true;
  h.setArchived.mockImplementationOnce(async (_tenant, _id, _user, _archived, audit) => {
    expect(h.activeTurns.isBusy(sessionId)).toBe(true);
    const session: SessionRecord = { sessionId, projectId: null, userId: "user", sessionName: "Research", status: "archived",
      createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z", transcriptFormat: "current" };
    // The store throws before it returns the sandbox that the rolled-back archive did not take.
    h.commitEvent(audit, "active", session);
    return { session, releasedSandboxId: "sandbox-one" };
  });
  const response = await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/archive` });
  expect(response.statusCode).toBe(500);
  expect(h.events).toEqual([]);
  expect(h.adapter.destroySandbox).not.toHaveBeenCalled();
  expect(h.activeTurns.isBusy(sessionId)).toBe(false);
});

it("restores a session from the trash with its event in the restore transaction", async () => {
  const h = await setup("deleted");
  h.restoreDeleted.mockImplementation(h.restoreFromTrash);
  const response = await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/restore` });
  expect(response.statusCode).toBe(200);
  expect(response.json().session.status).toBe("active");
  expect(h.restoreDeleted).toHaveBeenCalledWith("tenant", sessionId, "user", expect.any(Function));
  expect(h.events).toEqual([{
    tenantId: "tenant", sessionId, userId: "user", type: "session.restored",
    payload: { previousStatus: "deleted", status: "active", fromTrash: true }
  }]);
  expect(h.auditEvents.create).not.toHaveBeenCalled();
});

it("fails a restore from the trash when its audit event fails", async () => {
  const h = await setup("deleted");
  h.restoreDeleted.mockImplementation(h.restoreFromTrash);
  h.store.failEvent = true;
  const response = await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/restore` });
  expect(response.statusCode).toBe(500);
  expect(h.events).toEqual([]);
  expect(h.setArchived).not.toHaveBeenCalled();
});

// The store took the saved sandbox in the transaction that archived the session. The
// route kills it while it still holds the turn reservation, and keeps the warm
// runtime: no turn runs (the route refused a running one), and the next turn after a
// restore finds no saved sandbox, so the runtime starts a new one.
it("kills the sandbox that the archive took from the session, and keeps the warm runtime", async () => {
  const h = await setup();
  h.setArchived.mockResolvedValueOnce({
    session: { sessionId, projectId: null, userId: "user", sessionName: "Research", status: "archived",
      createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z", transcriptFormat: "current" },
    releasedSandboxId: "sandbox-one"
  });
  h.adapter.destroySandbox.mockImplementationOnce(async () => {
    expect(h.activeTurns.isBusy(sessionId)).toBe(true);
    return "killed";
  });
  const response = await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/archive` });
  expect(response.statusCode).toBe(200);
  expect(response.json().session).not.toHaveProperty("releasedSandboxId");
  expect(h.adapter.destroySandbox).toHaveBeenCalledExactlyOnceWith({ tenantId: "tenant", sessionId, sandboxId: "sandbox-one" });
  expect(h.adapter.abortSession).not.toHaveBeenCalled();
  expect(h.activeTurns.isBusy(sessionId)).toBe(false);
});

it("keeps a committed archive successful when the kill throws", async () => {
  const h = await setup();
  h.setArchived.mockImplementationOnce(async (_tenant, _id, _user, _archived, audit) => {
    const session: SessionRecord = { sessionId, projectId: null, userId: "user", sessionName: "Research", status: "archived",
      createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z", transcriptFormat: "current" };
    h.commitEvent(audit, "active", session);
    return { session, releasedSandboxId: "sandbox-one" };
  });
  h.adapter.destroySandbox.mockRejectedValueOnce(new Error("provider down"));
  const response = await h.app.inject({ method: "POST", url: `/sessions/${sessionId}/archive` });
  expect(response.statusCode).toBe(200);
  expect(response.json().session.status).toBe("archived");
  expect(h.events).toHaveLength(1);
  expect(h.activeTurns.isBusy(sessionId)).toBe(false);
});
