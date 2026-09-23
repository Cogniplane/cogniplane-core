import { describe, expect, test, vi } from "vitest";
import Fastify from "fastify";
import { registerSessionRoutes, type SessionRouteStores } from "../routes/sessions.js";
import { SessionStore } from "../services/session-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { withTenantScope } from "../lib/db.js";
import { ProjectStore } from "../services/project-store.js";
import { ProjectMemberStore } from "../services/project-member-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { ApprovalStore } from "../services/auth/approval-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedMembership, seedSession, seedRuntimeSession, seedApproval } from "./support/fixtures.js";

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
  test("a later replica reconnects to the session sandbox and stale owners cannot replace it", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    await seedMembership(tenantId, userId);
    const sessionId = await seedSession(tenantId, userId);
    const actor = { tenantId, sessionId, userId };
    const first = new SessionExecutionStore(appPool(), "replica-a");
    const second = new SessionExecutionStore(appPool(), "replica-b");
    const firstTurn = await first.acquire(actor, 30_000);
    expect(await first.sandboxId(firstTurn)).toBeNull();
    await first.bindSandboxId(firstTurn, null, "sandbox-one");
    await first.release(firstTurn);
    const secondTurn = await second.acquire(actor, 30_000);
    expect(await second.sandboxId(secondTurn)).toBe("sandbox-one");
    await expect(first.bindSandboxId(firstTurn, "sandbox-one", "stale-sandbox"))
      .rejects.toMatchObject({ code: "execution_stopped" });
    await second.bindSandboxId(secondTurn, "sandbox-one", "sandbox-two");
    expect(await second.sandboxId(secondTurn)).toBe("sandbox-two");
  });
  test("standalone admission, owner lookup, and limits work across replicas", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    await seedMembership(tenantId, userId);
    const sessionId = await seedSession(tenantId, userId);
    const otherSession = await seedSession(tenantId, userId);
    const first = new SessionExecutionStore(appPool(), "replica-a");
    const second = new SessionExecutionStore(appPool(), "replica-b");
    const actor = { tenantId, sessionId, userId };
    const results = await Promise.allSettled([
      first.acquire(actor, 30_000, { perUser: 1, perTenant: 1 }),
      second.acquire(actor, 30_000, { perUser: 1, perTenant: 1 })
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const winner = results.find(result => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("Expected one admitted turn");
    expect(await second.currentOwner(tenantId, sessionId)).toEqual({
      executionId: winner.value.executionId, ownerId: winner.value.ownerId
    });
    const sessions = new SessionStore(appPool());
    const page = await sessions.listPage(tenantId, userId, { ids: [sessionId] });
    expect(page.sessions[0]).toMatchObject({ isRunning: true });
    expect(page.sessions[0]?.activeTurnStartedAt).toBeTruthy();
    await expect(second.acquire({ ...actor, sessionId: otherSession }, 30_000,
      { perUser: 1, perTenant: 1 })).rejects.toMatchObject({ code: "running_turn_limit" });
    await second.release(winner.value);
    expect(await first.currentOwner(tenantId, sessionId)).toBeNull();
    expect((await sessions.listPage(tenantId, userId, { ids: [sessionId] })).sessions[0]?.isRunning).toBe(false);
    const thirdSession = await seedSession(tenantId, userId);
    const capped = await Promise.allSettled([
      first.acquire({ ...actor, sessionId: otherSession }, 30_000, { perUser: 1, perTenant: 1 }),
      second.acquire({ ...actor, sessionId: thirdSession }, 30_000, { perUser: 1, perTenant: 1 })
    ]);
    expect(capped.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(capped.find(result => result.status === "rejected")).toMatchObject({
      reason: { code: "running_turn_limit" }
    });
  });

  test("an expired standalone owner is swept with its unfinished reply", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    await seedMembership(tenantId, userId);
    const sessionId = await seedSession(tenantId, userId);
    const owner = new SessionExecutionStore(appPool(), "dead-replica");
    const execution = await owner.acquire({ tenantId, sessionId, userId }, 30_000);
    const runtimeId = await seedRuntimeSession(tenantId, userId, sessionId);
    await owner.bindRuntime(execution, runtimeId);
    const approvalId = await seedApproval({ tenantId, sessionId, userId, runtimeId });
    await superuserPool().query(`INSERT INTO messages
      (message_id, tenant_id, session_id, user_id, role, status, content_text)
      VALUES ($1,$2,$3,$4,'assistant','streaming','partial')`,
    [`reply-${execution.executionId}`, tenantId, sessionId, userId]);
    await superuserPool().query("UPDATE messages SET created_at=NOW()-INTERVAL '2 seconds' WHERE message_id=$1",
      [`reply-${execution.executionId}`]);
    await superuserPool().query(`UPDATE session_executions
      SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE execution_id=$1`, [execution.executionId]);
    const sweeper = new SessionExecutionStore(superuserPool());
    expect(await sweeper.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(await owner.currentOwner(tenantId, sessionId)).toBeNull();
    const reply = await superuserPool().query("SELECT status FROM messages WHERE message_id=$1", [`reply-${execution.executionId}`]);
    expect(reply.rows[0].status).toBe("interrupted");
    const approval = await superuserPool().query("SELECT status FROM approvals WHERE approval_id=$1", [approvalId]);
    expect(approval.rows[0].status).toBe("expired");
    expect(await owner.heartbeat(execution, 30_000)).toBe(false);
  });

  test("admission cleans an expired reply and tool before replacing its execution", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    await seedMembership(tenantId, userId);
    const sessionId = await seedSession(tenantId, userId);
    const actor = { tenantId, sessionId, userId };
    const first = new SessionExecutionStore(appPool(), "dead-replica");
    const old = await first.acquire(actor, 30_000);
    const runtimeId = await seedRuntimeSession(tenantId, userId, sessionId);
    await first.bindRuntime(old, runtimeId);
    const approvalId = await seedApproval({ ...actor, runtimeId });
    const messageId = `reply-${old.executionId}`;
    const toolResultId = `tool-${old.executionId}`;
    await superuserPool().query(`INSERT INTO messages
      (message_id, tenant_id, session_id, user_id, role, status, content_text, created_at)
      VALUES ($1,$2,$3,$4,'assistant','streaming','partial',NOW()-INTERVAL '2 seconds')`,
    [messageId, tenantId, sessionId, userId]);
    await superuserPool().query(`INSERT INTO message_tool_results
      (tool_result_id, tenant_id, message_id, session_id, user_id, kind, title, status)
      VALUES ($1,$2,$3,$4,$5,'shell','Running','in_progress')`,
    [toolResultId, tenantId, messageId, sessionId, userId]);
    await superuserPool().query(`UPDATE session_executions
      SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE execution_id=$1`, [old.executionId]);
    const next = await new SessionExecutionStore(appPool(), "new-replica").acquire(actor, 30_000);
    expect(next.executionId).not.toBe(old.executionId);
    expect((await superuserPool().query("SELECT status FROM messages WHERE message_id=$1", [messageId])).rows[0].status)
      .toBe("interrupted");
    expect((await superuserPool().query("SELECT status FROM message_tool_results WHERE tool_result_id=$1", [toolResultId])).rows[0].status)
      .toBe("failed");
    expect((await superuserPool().query("SELECT status FROM approvals WHERE approval_id=$1", [approvalId])).rows[0].status)
      .toBe("expired");
    await new SessionExecutionStore(superuserPool()).sweepExpired();
    expect(await first.isCurrent(next)).toBe(true);
  });

  test("a remote approval keeps the turn preference and rejects an expired standalone lease", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    await seedMembership(tenantId, userId);
    const sessionId = await seedSession(tenantId, userId);
    const executions = new SessionExecutionStore(appPool(), "owner");
    const execution = await executions.acquire({ tenantId, sessionId, userId }, 30_000);
    const runtimeId = await seedRuntimeSession(tenantId, userId, sessionId);
    await executions.bindRuntime(execution, runtimeId);
    const firstId = await seedApproval({ tenantId, sessionId, userId, runtimeId });
    const secondId = await seedApproval({ tenantId, sessionId, userId, runtimeId });
    const approvals = new ApprovalStore(appPool());
    expect(await approvals.resolve(tenantId, firstId, userId, "approve", true)).toMatchObject({
      status: "approved", rememberForTurn: true
    });
    expect(await approvals.get(tenantId, firstId, userId)).toMatchObject({ rememberForTurn: true });
    await superuserPool().query("UPDATE session_executions SET expires_at=NOW()-INTERVAL '1 second' WHERE execution_id=$1",
      [execution.executionId]);
    expect(await approvals.resolve(tenantId, secondId, userId, "approve", true)).toBeNull();
  });

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
    expect(await h.executions.isStopped(execution)).toBe(true);
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
      expect(interruptTurn).not.toHaveBeenCalled();
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
