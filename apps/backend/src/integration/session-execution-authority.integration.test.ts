import { describe, expect, test } from "vitest";

import { SessionExecutionStore } from "../services/session-execution-store.js";
import { SessionStore } from "../services/session-store.js";
import { MessageStore } from "../services/message-store.js";
import { ProjectStore } from "../services/project-store.js";
import { RuntimeSessionStore, type RuntimeSessionUpsertInput } from "../services/runtime/runtime-session-store.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedApproval, seedMembership, seedRuntimeSession, seedSession, seedStreamingMessage, seedTenant, seedUser } from "./support/fixtures.js";

// The lease (session_executions) is the only authority for "a turn runs in this
// session". Each store here is a separate replica on one database.

async function personalSession() {
  const tenantId = await seedTenant(), userId = await seedUser();
  await seedMembership(tenantId, userId);
  const sessionId = await seedSession(tenantId, userId);
  return { tenantId, userId, sessionId, actor: { tenantId, sessionId, userId } };
}

const lease = async (executionId: string) => (await superuserPool().query(
  "SELECT status, stop_reason FROM session_executions WHERE execution_id=$1", [executionId])).rows[0];
const messageStatus = async (messageId: string) => (await superuserPool().query(
  "SELECT status FROM messages WHERE message_id=$1", [messageId])).rows[0]?.status;

describe.skipIf(!adminDatabaseUrl())("session execution authority", () => {
  test("after a stop on another replica, the session stays busy until the owner releases the lease", async () => {
    const h = await personalSession();
    const owner = new SessionExecutionStore(appPool(), "replica-a");
    const other = new SessionExecutionStore(appPool(), "replica-b");
    const sessions = new SessionStore(appPool());
    const turn = await owner.acquire(h.actor, 30_000);

    expect(await other.stopAndGetOwner(h.actor)).toEqual({ executionId: turn.executionId, ownerId: "replica-a" });
    expect(await lease(turn.executionId)).toEqual({ status: "stopping", stop_reason: "cancelled" });
    // The stopped turn has no authority, but its owner finds its own stop and acts on the signal.
    expect(await owner.isCurrent(turn)).toBe(false);
    expect(await owner.heartbeat(turn, 30_000)).toBe(false);
    expect(await owner.isStopped(turn)).toBe(true);
    // No new turn on any replica while the old one unwinds, and the session shows as running.
    await expect(other.acquire(h.actor, 30_000)).rejects.toMatchObject({ code: "session_busy", statusCode: 409 });
    await expect(owner.acquire(h.actor, 30_000)).rejects.toMatchObject({ code: "session_busy" });
    expect(await other.currentOwner(h.tenantId, h.sessionId)).toEqual({ executionId: turn.executionId, ownerId: "replica-a" });
    expect((await sessions.listPage(h.tenantId, h.userId, { ids: [h.sessionId] })).sessions[0]?.isRunning).toBe(true);
    // A second stop finds no running turn.
    expect(await other.stopAndGetOwner(h.actor)).toBeNull();
    // Another replica cannot release it for the owner.
    await other.release({ ...turn, ownerId: "replica-b" });
    await expect(other.acquire(h.actor, 30_000)).rejects.toMatchObject({ code: "session_busy" });

    await owner.release(turn);
    expect(await lease(turn.executionId)).toEqual({ status: "stopped", stop_reason: "cancelled" });
    expect(await owner.isStopped(turn)).toBe(true);
    expect((await sessions.listPage(h.tenantId, h.userId, { ids: [h.sessionId] })).sessions[0]?.isRunning).toBe(false);
    const next = await other.acquire(h.actor, 30_000);
    expect(next.executionId).not.toBe(turn.executionId);
  });

  test("a stopping lease counts toward the running-turn caps until its owner releases it", async () => {
    const h = await personalSession();
    const otherSession = await seedSession(h.tenantId, h.userId);
    const owner = new SessionExecutionStore(appPool(), "replica-a");
    const other = new SessionExecutionStore(appPool(), "replica-b");
    const caps = { perUser: 1, perTenant: 5 };
    const turn = await owner.acquire(h.actor, 30_000, caps);
    await other.stop(h.actor);
    await expect(other.acquire({ ...h.actor, sessionId: otherSession }, 30_000, caps))
      .rejects.toMatchObject({ code: "running_turn_limit" });
    await owner.release(turn);
    await other.acquire({ ...h.actor, sessionId: otherSession }, 30_000, caps);
  });

  test("a stopping lease whose owner is gone frees the session at its expiry and keeps its stop reason", async () => {
    const h = await personalSession();
    const dead = new SessionExecutionStore(appPool(), "dead-replica");
    const other = new SessionExecutionStore(appPool(), "replica-b");
    const turn = await dead.acquire(h.actor, 30_000);
    const reply = await seedStreamingMessage(h.tenantId, h.userId, h.sessionId, 2_000);
    await other.stop(h.actor);
    await expect(other.acquire(h.actor, 30_000)).rejects.toMatchObject({ code: "session_busy" });

    await superuserPool().query(
      "UPDATE session_executions SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE execution_id=$1",
      [turn.executionId]);
    expect(await new SessionExecutionStore(maintenancePool()).sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(await lease(turn.executionId)).toEqual({ status: "stopped", stop_reason: "cancelled" });
    expect(await messageStatus(reply)).toBe("interrupted");
    await other.acquire(h.actor, 30_000);
  });

  test("admission replaces an expired stopping lease with its stop reason kept", async () => {
    const h = await personalSession();
    const dead = new SessionExecutionStore(appPool(), "dead-replica");
    const other = new SessionExecutionStore(appPool(), "replica-b");
    const turn = await dead.acquire(h.actor, 30_000);
    await other.stop(h.actor);
    await superuserPool().query(
      "UPDATE session_executions SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE execution_id=$1",
      [turn.executionId]);
    const next = await other.acquire(h.actor, 30_000);
    expect(await other.isCurrent(next)).toBe(true);
    // The old owner's late release does not touch the new turn.
    await dead.release(turn);
    expect(await other.isCurrent(next)).toBe(true);
  });

  test("a personal session with a lease cannot be archived from any replica", async () => {
    const h = await personalSession();
    const owner = new SessionExecutionStore(appPool(), "replica-a");
    const turn = await owner.acquire(h.actor, 30_000);
    // Two SessionStore instances: neither has the turn in memory.
    for (const sessions of [new SessionStore(appPool()), new SessionStore(appPool())]) {
      await expect(sessions.setArchived(h.tenantId, h.sessionId, h.userId, true))
        .rejects.toMatchObject({ code: "session_busy", statusCode: 409 });
    }
    expect(await owner.isCurrent(turn)).toBe(true);
    await owner.stop(h.actor);
    await expect(new SessionStore(appPool()).setArchived(h.tenantId, h.sessionId, h.userId, true))
      .rejects.toMatchObject({ code: "session_busy" });
    await owner.release(turn);
    expect((await new SessionStore(appPool()).setArchived(h.tenantId, h.sessionId, h.userId, true))?.session.status)
      .toBe("archived");
  });

  test("a personal session waiting on an approval cannot be archived; an expired approval does not block", async () => {
    const h = await personalSession();
    const sessions = new SessionStore(appPool());
    const runtimeId = await seedRuntimeSession(h.tenantId, h.userId, h.sessionId);
    const pending = await seedApproval({ ...h.actor, runtimeId });
    await expect(sessions.setArchived(h.tenantId, h.sessionId, h.userId, true))
      .rejects.toMatchObject({ code: "session_busy" });
    await superuserPool().query("UPDATE approvals SET expires_at=NOW()-INTERVAL '1 minute' WHERE approval_id=$1", [pending]);
    expect((await sessions.setArchived(h.tenantId, h.sessionId, h.userId, true))?.session.status).toBe("archived");
  });

  test("the busy rule is the lease and unexpired approvals, not the reply status", async () => {
    const h = await personalSession();
    const sessions = new SessionStore(appPool());
    const canEdit = async () => (await sessions.getCapabilities(h.tenantId, h.sessionId, h.userId)).canEdit;
    const version = async () => (await sessions.getCapabilities(h.tenantId, h.sessionId, h.userId)).version;

    // A reply left streaming by a turn that ended does not block a capability edit.
    await seedStreamingMessage(h.tenantId, h.userId, h.sessionId, 1_000);
    expect(await canEdit()).toBe(true);
    expect(await sessions.setCapabilities(h.tenantId, h.sessionId, h.userId, { selection: null, version: await version() }))
      .toBe(true);

    // An expired approval that the sweep has not reached does not block either.
    const runtimeId = await seedRuntimeSession(h.tenantId, h.userId, h.sessionId);
    await seedApproval({ ...h.actor, runtimeId, expired: true });
    expect(await canEdit()).toBe(true);

    // A lease blocks, also while it is stopping.
    const owner = new SessionExecutionStore(appPool(), "replica-a");
    const turn = await owner.acquire(h.actor, 30_000);
    expect(await canEdit()).toBe(false);
    await owner.stop(h.actor);
    expect(await canEdit()).toBe(false);
    expect(await sessions.setCapabilities(h.tenantId, h.sessionId, h.userId, { selection: null, version: await version() }))
      .toBe(false);
    await owner.release(turn);
    expect(await canEdit()).toBe(true);
  });

  test("project capability edits wait for a stopping lease of any project session", async () => {
    const tenantId = await seedTenant(), userId = await seedUser();
    await seedMembership(tenantId, userId);
    const projects = new ProjectStore(appPool());
    const project = await projects.create(tenantId, userId, "Busy rule");
    const sessionId = (await projects.createSession(tenantId, userId, project.projectId, "Turn"))!;
    const owner = new SessionExecutionStore(appPool(), "replica-a");
    const canEdit = async () => (await projects.getCapabilities(tenantId, userId, project.projectId)).canEdit;
    expect(await canEdit()).toBe(true);
    const turn = await owner.acquire({ tenantId, sessionId, userId }, 30_000);
    await owner.stop({ tenantId, sessionId, userId });
    expect(await canEdit()).toBe(false);
    await owner.release(turn);
    expect(await canEdit()).toBe(true);
  });

  test("a reply with no write for one lease period in a session with no work is closed, and only that one", async () => {
    const h = await personalSession();
    const sweeper = new SessionExecutionStore(maintenancePool());
    const messages = new MessageStore(appPool());
    const leaseMs = 30_000;

    const orphan = await seedStreamingMessage(h.tenantId, h.userId, h.sessionId, leaseMs + 5_000);
    const pendingOrphan = await seedStreamingMessage(h.tenantId, h.userId, h.sessionId, leaseMs + 5_000);
    await superuserPool().query("UPDATE messages SET status='pending' WHERE message_id=$1", [pendingOrphan]);
    const recent = await seedStreamingMessage(h.tenantId, h.userId, h.sessionId, 1_000);

    const live = await personalSession();
    const liveTurn = await new SessionExecutionStore(appPool(), "replica-a").acquire(live.actor, leaseMs);
    const underLease = await seedStreamingMessage(live.tenantId, live.userId, live.sessionId, leaseMs + 5_000);

    const waiting = await personalSession();
    const runtimeId = await seedRuntimeSession(waiting.tenantId, waiting.userId, waiting.sessionId);
    await seedApproval({ ...waiting.actor, runtimeId });
    const underApproval = await seedStreamingMessage(waiting.tenantId, waiting.userId, waiting.sessionId, leaseMs + 5_000);

    expect(await sweeper.sweepOrphanedReplies(leaseMs)).toBeGreaterThanOrEqual(2);
    expect(await messageStatus(orphan)).toBe("interrupted");
    expect(await messageStatus(pendingOrphan)).toBe("interrupted");
    expect(await messageStatus(recent)).toBe("streaming");
    expect(await messageStatus(underLease)).toBe("streaming");
    expect(await messageStatus(underApproval)).toBe("streaming");

    // A late checkpoint of the old turn cannot make the closed reply active again.
    expect(await messages.updateContent(h.tenantId, orphan, h.userId, "streaming", "late")).toBeNull();
    expect(await messageStatus(orphan)).toBe("interrupted");

    // After the release, the reply of the live turn is an orphan too.
    await new SessionExecutionStore(appPool(), "replica-a").release(liveTurn);
    await sweeper.sweepOrphanedReplies(leaseMs);
    expect(await messageStatus(underLease)).toBe("interrupted");
  });
});

describe.skipIf(!adminDatabaseUrl())("runtime rows of a gone process", () => {
  async function runtimeRow(owner: string, tenantId: string, userId: string, sessionId: string) {
    const runtimeId = `deepagents-${owner}-${sessionId}`;
    const input: RuntimeSessionUpsertInput = {
      tenantId, sessionId, userId, runtimeId, runtimeProvider: "deep-agents", workspacePath: "/workspace",
      runtimeVersion: "test", runtimeSchemaVersion: "1", manifestPath: "",
      manifestMetadata: {} as RuntimeSessionUpsertInput["manifestMetadata"], healthStatus: "healthy",
      lastActiveAt: null, startedAt: null, terminatedAt: null, lifecycleMetadata: {}, status: "active"
    };
    await new RuntimeSessionStore(appPool(), owner).upsert(input);
    return runtimeId;
  }
  const row = async (runtimeId: string) => (await superuserPool().query(
    "SELECT status, owner_id, terminated_at FROM runtime_sessions WHERE runtime_id=$1", [runtimeId])).rows[0];

  test("the sweep terminates rows whose owner stopped renewing them, and keeps live ones", async () => {
    const h = await personalSession();
    const liveSession = await seedSession(h.tenantId, h.userId);
    const leasedSession = await seedSession(h.tenantId, h.userId);
    const legacySession = await seedSession(h.tenantId, h.userId);
    const recentLegacySession = await seedSession(h.tenantId, h.userId);

    const dead = await runtimeRow("process-dead", h.tenantId, h.userId, h.sessionId);
    const live = await runtimeRow("process-live", h.tenantId, h.userId, liveSession);
    const leased = await runtimeRow("process-dead", h.tenantId, h.userId, leasedSession);
    const legacy = await seedRuntimeSession(h.tenantId, h.userId, legacySession);
    const recentLegacy = await seedRuntimeSession(h.tenantId, h.userId, recentLegacySession);
    expect((await row(dead)).owner_id).toBe("process-dead");
    await superuserPool().query("UPDATE runtime_sessions SET status='active' WHERE runtime_id = ANY($1)", [[legacy, recentLegacy]]);
    await superuserPool().query(`UPDATE runtime_sessions SET owner_heartbeat_at=NOW()-INTERVAL '10 minutes'
      WHERE runtime_id = ANY($1)`, [[dead, live, leased]]);
    await superuserPool().query("UPDATE runtime_sessions SET updated_at=NOW()-INTERVAL '2 days' WHERE runtime_id=$1", [legacy]);
    // A turn of the dead owner's runtime still holds its lease.
    const turn = await new SessionExecutionStore(appPool(), "process-dead")
      .acquire({ tenantId: h.tenantId, sessionId: leasedSession, userId: h.userId }, 30_000);
    await new SessionExecutionStore(appPool(), "process-dead").bindRuntime(turn, leased);

    const liveOwner = new RuntimeSessionStore(maintenancePool(), "process-live");
    await liveOwner.heartbeatOwner();
    expect(await liveOwner.sweepOrphaned()).toBeGreaterThanOrEqual(2);

    expect(await row(dead)).toMatchObject({ status: "terminated", terminated_at: expect.any(Date) });
    expect(await row(legacy)).toMatchObject({ status: "terminated", terminated_at: expect.any(Date) });
    expect((await row(live)).status).toBe("active");
    expect((await row(leased)).status).toBe("active");
    expect((await row(recentLegacy)).status).toBe("active");
  });

  test("setStatus records the time a runtime terminated", async () => {
    const h = await personalSession();
    const runtimeId = await runtimeRow("process-a", h.tenantId, h.userId, h.sessionId);
    const store = new RuntimeSessionStore(appPool(), "process-a");
    const terminated = await store.setStatus(h.tenantId, h.sessionId, h.userId, "terminated", runtimeId);
    expect(terminated?.terminatedAt).toEqual(expect.any(String));
    expect((await row(runtimeId)).terminated_at).toBeInstanceOf(Date);
  });
});
