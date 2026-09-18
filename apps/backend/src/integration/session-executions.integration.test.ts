import { describe, expect, test, vi } from "vitest";
import Fastify from "fastify";
import { registerSessionRoutes, type SessionRouteStores } from "../routes/sessions.js";
import { SessionStore } from "../services/session-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { withTenantScope } from "../lib/db.js";
import { ProjectStore } from "../services/project-store.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedMembership, seedRuntimeSession, seedApproval } from "./support/fixtures.js";

async function setup() {
  const tenantId = await seedTenant(), userId = await seedUser(), editorId = await seedUser();
  await seedMembership(tenantId, userId);
  await seedMembership(tenantId, editorId);
  const projects = new ProjectStore(appPool()), members = new ProjectMemberStore(appPool());
  const project = await projects.create(tenantId, userId, "Execution test");
  const owner = { tenantId, userId, projectId: project.projectId };
  await members.setMember(owner, editorId, "editor");
  const sessionId = (await projects.createSession(tenantId, userId, project.projectId, "Shared turn"))!;
  const actor = { tenantId, sessionId, userId: editorId };
  return { tenantId, userId, editorId, projects, members, owner, actor, sessionId,
    sessions: new SessionStore(appPool()), executions: new SessionExecutionStore(appPool()) };
}

describe.skipIf(!adminDatabaseUrl())("durable session execution", () => {
  test("admits an editor to another member's session and excludes concurrent turns across stores", async () => {
    const h = await setup();
    const second = new SessionExecutionStore(appPool());
    expect(await new SessionStore(appPool()).getCapabilitySelection(h.tenantId, h.sessionId, h.editorId)).toBeNull();
    const results = await Promise.allSettled([
      h.executions.acquire(h.actor, 60_000), second.acquire({ ...h.actor, userId: h.userId }, 60_000)
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "session_busy" });
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("Expected one admitted turn");
    expect(await second.isCurrent(winner.value)).toBe(true);
    await second.release(winner.value);
    expect(await h.executions.isCurrent(winner.value)).toBe(false);
    expect(await h.executions.acquire(h.actor, 60_000)).toMatchObject({ userId: h.editorId });
  });

  test("demotion fences the generation and expires approvals even if access is restored", async () => {
    const h = await setup();
    const execution = await h.executions.acquire(h.actor, 60_000);
    const runtimeId = await seedRuntimeSession(h.tenantId, h.editorId, h.sessionId);
    await h.executions.bindRuntime(execution, runtimeId);
    const approvalId = await seedApproval({ ...h.actor, runtimeId });
    expect(await h.executions.isCurrent(execution, runtimeId)).toBe(true);
    expect(await h.executions.isCurrent(execution, "other-runtime")).toBe(false);
    await h.members.setMember(h.owner, h.editorId, "viewer");
    expect(await h.executions.isCurrent(execution)).toBe(false);
    expect(await h.executions.heartbeat(execution, 60_000)).toBe(false);
    expect((await superuserPool().query("SELECT status FROM approvals WHERE approval_id=$1", [approvalId])).rows[0].status)
      .toBe("expired");
    await expect(h.executions.acquire(h.actor, 60_000)).rejects.toMatchObject({ status: 403 });
    await h.members.setMember(h.owner, h.editorId, "editor");
    expect(await h.executions.isCurrent(execution)).toBe(false);
    const next = await h.executions.acquire(h.actor, 60_000);
    await h.executions.release(execution);
    expect(await h.executions.isCurrent(next)).toBe(true);
  });

  test("retains an effective organization editor grant and fences when that grant is reduced", async () => {
    const h = await setup();
    await h.members.setSharing(h.owner, { visibility: "organization", organizationRole: "editor", confirmAudience: true });
    const execution = await h.executions.acquire(h.actor, 60_000);
    await h.members.setMember(h.owner, h.editorId, null, { confirmRetainedRole: "editor" });
    expect(await h.executions.isCurrent(execution)).toBe(true);
    await h.members.setSharing(h.owner, { visibility: "organization", organizationRole: "viewer", confirmAudience: true });
    expect(await h.executions.isCurrent(execution)).toBe(false);
  });

  test("organization departure fences active work and rejoining does not revive it", async () => {
    const h = await setup();
    const execution = await h.executions.acquire(h.actor, 60_000);
    await superuserPool().query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [h.tenantId, h.editorId]);
    await seedMembership(h.tenantId, h.editorId);
    expect(await h.executions.isCurrent(execution)).toBe(false);
    expect(await h.executions.heartbeat(execution, 60_000)).toBe(false);
  });

  test("rejects expired leases and prevents old releases from clearing a replacement", async () => {
    const h = await setup();
    const old = await h.executions.acquire(h.actor, 60_000);
    await superuserPool().query("UPDATE session_executions SET expires_at=NOW()-INTERVAL '1 second' WHERE execution_id=$1",
      [old.executionId]);
    expect(await h.executions.heartbeat(old, 60_000)).toBe(false);
    const next = await h.executions.acquire(h.actor, 60_000);
    await h.executions.release(old);
    expect(await h.executions.isCurrent(next)).toBe(true);
    await expect(h.executions.bindRuntime(old, "old-runtime")).rejects.toMatchObject({ code: "execution_stopped" });
  });

  test("cancellation requires current editor access and fences another participant's turn", async () => {
    const h = await setup();
    const execution = await h.executions.acquire(h.actor, 60_000);
    const viewer = await seedUser();
    await seedMembership(h.tenantId, viewer);
    await h.members.setMember(h.owner, viewer, "viewer");
    expect(await h.executions.stop({ ...h.actor, userId: viewer })).toBe(false);
    expect(await h.executions.isCurrent(execution)).toBe(true);
    expect(await h.executions.stop({ ...h.actor, userId: h.userId })).toBe(true);
    expect(await h.executions.isCurrent(execution)).toBe(false);
  });

  test("tenant RLS hides execution records and forbids forged tenant writes", async () => {
    const h = await setup();
    const execution = await h.executions.acquire(h.actor, 60_000);
    const otherTenant = await seedTenant();
    expect(await h.executions.isCurrent({ ...execution, tenantId: otherTenant })).toBe(false);
    await withTenantScope(appPool(), otherTenant, async (db) => {
      expect((await db.query("SELECT * FROM session_executions WHERE execution_id=$1", [execution.executionId])).rows).toEqual([]);
      await expect(db.query(`INSERT INTO session_executions
        (tenant_id,session_id,execution_id,user_id,status,expires_at) VALUES ($1,$2,'forged',$3,'active',NOW())`,
      [h.tenantId, h.sessionId, h.editorId])).rejects.toMatchObject({ code: "42501" });
    });
  });

  test("project archive rejects active and approval-wait executions without stopping them", async () => {
    const h = await setup();
    const execution = await h.executions.acquire(h.actor, 60_000);
    const runtimeId = await seedRuntimeSession(h.tenantId, h.editorId, h.sessionId);
    await h.executions.bindRuntime(execution, runtimeId);
    const approvalId = await seedApproval({ ...h.actor, runtimeId });
    await expect(h.projects.setArchived(h.tenantId, h.userId, h.owner.projectId, true))
      .rejects.toMatchObject({ code: "project_busy", status: 409 });
    expect(await h.executions.isCurrent(execution)).toBe(true);
    expect((await superuserPool().query("SELECT status FROM approvals WHERE approval_id=$1", [approvalId])).rows[0].status).toBe("pending");
    await h.executions.stop({ ...h.actor, userId: h.userId });
    expect(await h.projects.setArchived(h.tenantId, h.userId, h.owner.projectId, true)).toBe(true);
    await expect(h.executions.acquire(h.actor, 60_000)).rejects.toMatchObject({ code: "project_archived" });
  });

  test("archive and turn admission on separate connections have only one winner", async () => {
    const h = await setup();
    const results = await Promise.allSettled([
      h.executions.acquire(h.actor, 60_000),
      h.projects.setArchived(h.tenantId, h.userId, h.owner.projectId, true)
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.code).toMatch(/^project_(busy|archived)$/);
  });

  test("HTTP cancellation works on a replica without the runtime and attributes the cancelling owner", async () => {
    const h = await setup();
    const execution = await h.executions.acquire(h.actor, 60_000);
    const viewer = await seedUser();
    await seedMembership(h.tenantId, viewer);
    await h.members.setMember(h.owner, viewer, "viewer");
    const app = Fastify();
    let userId = viewer;
    app.addHook("preHandler", async request => { request.auth = { tenantId: h.tenantId, userId, role: "member", isAdmin: false }; });
    const interruptTurn = vi.fn();
    await registerSessionRoutes(app, {
      sessions: new SessionStore(appPool()), executions: new SessionExecutionStore(appPool()),
      runtimeAdapter: { interruptTurn }
    } as unknown as SessionRouteStores);
    try {
      const url = `/sessions/${h.sessionId}/interrupt`;
      expect((await app.inject({ method: "POST", url })).statusCode).toBe(409);
      expect(await h.executions.isCurrent(execution)).toBe(true);
      userId = h.userId;
      expect((await app.inject({ method: "POST", url })).json()).toEqual({ status: "interrupted" });
      expect(await h.executions.isCurrent(execution)).toBe(false);
      expect(interruptTurn).toHaveBeenCalledWith({ tenantId: h.tenantId, sessionId: h.sessionId, userId: h.userId });
      const audit = await superuserPool().query("SELECT user_id, payload FROM audit_events WHERE tenant_id=$1 AND event_type='turn.interrupted'", [h.tenantId]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ user_id: h.userId, payload: { executionId: execution.executionId, initiatorUserId: h.editorId } });
    } finally { await app.close(); }
  });

  test("project session archive and restore retries are idempotent", async () => {
    const h = await setup();
    const archive = await h.sessions.setArchived(h.tenantId, h.sessionId, h.userId, true);
    expect(archive).toMatchObject({ sessionId: h.sessionId, status: "archived", projectId: h.owner.projectId });
    const archiveRetry = await h.sessions.setArchived(h.tenantId, h.sessionId, h.userId, true);
    expect(archiveRetry).toMatchObject({ sessionId: h.sessionId, status: "archived", projectId: h.owner.projectId });
    const restore = await h.sessions.setArchived(h.tenantId, h.sessionId, h.userId, false);
    expect(restore).toMatchObject({ sessionId: h.sessionId, status: "active", projectId: h.owner.projectId });
    const restoreRetry = await h.sessions.setArchived(h.tenantId, h.sessionId, h.userId, false);
    expect(restoreRetry).toMatchObject({ sessionId: h.sessionId, status: "active", projectId: h.owner.projectId });
  });

  test("cancellation and approval expiry roll back when audit persistence fails", async () => {
    const h = await setup();
    const execution = await h.executions.acquire(h.actor, 60_000);
    const runtimeId = await seedRuntimeSession(h.tenantId, h.editorId, h.sessionId);
    await h.executions.bindRuntime(execution, runtimeId);
    const approvalId = await seedApproval({ ...h.actor, runtimeId });
    const failure = vi.spyOn(AuditEventStore, "createInTransaction").mockRejectedValueOnce(new Error("audit unavailable"));
    try {
      await expect(h.executions.stop(h.actor)).rejects.toThrow("audit unavailable");
    } finally { failure.mockRestore(); }
    expect(await h.executions.isCurrent(execution)).toBe(true);
    expect((await superuserPool().query("SELECT status FROM approvals WHERE approval_id=$1", [approvalId])).rows[0].status).toBe("pending");
  });

  test("shared session lifecycle requires current owner/editor access and an active project", async () => {
    const h = await setup();
    const sessions = new SessionStore(appPool());
    const viewer = await seedUser();
    await seedMembership(h.tenantId, viewer);
    await h.members.setMember(h.owner, viewer, "viewer");
    expect((await sessions.getCapabilities(h.tenantId, h.sessionId, viewer)).canEdit).toBe(false);
    await expect(sessions.setCapabilities(h.tenantId, h.sessionId, viewer, { selection: null, version: 0 })).rejects.toMatchObject({ status: 403 });
    expect((await sessions.getCapabilities(h.tenantId, h.sessionId, h.editorId)).canEdit).toBe(true);
    expect(await sessions.setCapabilities(h.tenantId, h.sessionId, h.editorId, { selection: null, version: 0 })).toBe(true);
    await expect(sessions.setArchived(h.tenantId, h.sessionId, viewer, true)).rejects.toMatchObject({ status: 403 });
    await expect(sessions.remove(h.tenantId, h.sessionId, viewer)).rejects.toMatchObject({ status: 403 });
    expect(await sessions.rename(h.tenantId, h.sessionId, viewer, "Forbidden")).toBeNull();
    expect(await sessions.rename(h.tenantId, h.sessionId, h.editorId, "Edited title")).toMatchObject({ sessionName: "Edited title" });
    expect(await sessions.setArchived(h.tenantId, h.sessionId, h.editorId, true)).toMatchObject({ status: "archived", userId: h.userId });
    await h.projects.setArchived(h.tenantId, h.userId, h.owner.projectId, true);
    await expect(sessions.setArchived(h.tenantId, h.sessionId, h.editorId, false)).rejects.toMatchObject({ code: "project_archived" });
    await expect(sessions.remove(h.tenantId, h.sessionId, h.editorId)).rejects.toMatchObject({ code: "project_archived" });
    await h.projects.setArchived(h.tenantId, h.userId, h.owner.projectId, false);
    expect(await sessions.setArchived(h.tenantId, h.sessionId, h.editorId, false)).toMatchObject({ status: "active" });
    expect(await sessions.remove(h.tenantId, h.sessionId, h.editorId)).toBe(true);
  });

  test("an admitted shared turn prevents capability edits before any streaming message exists", async () => {
    const h = await setup();
    const sessions = new SessionStore(appPool());
    const execution = await h.executions.acquire(h.actor, 60_000);
    expect((await sessions.getCapabilities(h.tenantId, h.sessionId, h.editorId)).canEdit).toBe(false);
    await expect(sessions.setCapabilities(h.tenantId, h.sessionId, h.editorId, { selection: null, version: 0 }))
      .rejects.toMatchObject({ code: "session_busy" });
    expect(await h.executions.isCurrent(execution)).toBe(true);
    await h.executions.release(execution);
    expect(await sessions.setCapabilities(h.tenantId, h.sessionId, h.editorId, { selection: null, version: 0 })).toBe(true);
  });

  test.each(["archive", "delete"])("shared session %s cannot interrupt an active execution", async action => {
    const h = await setup();
    const sessions = new SessionStore(appPool());
    const execution = await h.executions.acquire(h.actor, 60_000);
    const mutate = () => action === "archive"
      ? sessions.setArchived(h.tenantId, h.sessionId, h.editorId, true)
      : sessions.remove(h.tenantId, h.sessionId, h.editorId);
    await expect(mutate()).rejects.toMatchObject({ code: "session_busy", statusCode: 409 });
    expect(await h.executions.isCurrent(execution)).toBe(true);
    await h.executions.stop(h.actor);
    expect(await mutate()).toBeTruthy();
  });

  test.each(["archive", "delete"])("shared session %s and admission cannot both succeed", async action => {
    const h = await setup();
    const sessions = new SessionStore(appPool());
    const results = await Promise.allSettled([
      h.executions.acquire(h.actor, 60_000), action === "archive"
        ? sessions.setArchived(h.tenantId, h.sessionId, h.editorId, true)
        : sessions.remove(h.tenantId, h.sessionId, h.editorId)
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
});
