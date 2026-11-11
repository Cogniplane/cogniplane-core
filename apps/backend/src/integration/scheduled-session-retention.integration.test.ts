import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, test, vi } from "vitest";

import { withTenantScope } from "../lib/db.js";
import { SchedulerWorker, type SchedulerWorkerDeps } from "../services/scheduler-worker.js";
import { SessionStore } from "../services/session-store.js";
import { adminDatabaseUrl, appPool, maintenancePool, runMaintenanceUrl, superuserPool } from "./support/database.js";
import {
  seedApproval,
  seedArtifact,
  seedMessage,
  seedRuntimeSession,
  seedScheduledJob,
  seedSession,
  seedTenant,
  seedUser,
} from "./support/fixtures.js";

// Each scheduled run creates a `purpose = 'scheduled'` session and its
// messages. Retention deletes such a session when its last activity is older
// than the retention window, and keeps the run row with a NULL session link.

const RETENTION_DAYS = 30;
const OLD = 40;
const RECENT = 1;

type SessionShape = {
  ageDays: number;
  purpose?: string;
  status?: "active" | "archived" | "deleted";
  projectId?: string;
  sandboxId?: string;
};

async function session(tenantId: string, userId: string, shape: SessionShape): Promise<string> {
  const sessionId = await seedSession(tenantId, userId);
  await superuserPool().query(
    `UPDATE sessions
     SET purpose=$2, status=$3, project_id=$4, sandbox_id=$5,
         created_at=NOW() - ($6::int * INTERVAL '1 day'),
         updated_at=NOW() - ($6::int * INTERVAL '1 day'),
         archived_at=CASE WHEN $3='archived' THEN NOW() - ($6::int * INTERVAL '1 day') END,
         deleted_at=CASE WHEN $3='deleted' THEN NOW() - INTERVAL '1 day' END
     WHERE session_id=$1`,
    [sessionId, shape.purpose ?? "scheduled", shape.status ?? "active", shape.projectId ?? null,
      shape.sandboxId ?? null, shape.ageDays],
  );
  return sessionId;
}

async function message(tenantId: string, userId: string, sessionId: string, ageDays: number): Promise<string> {
  const messageId = await seedMessage(tenantId, userId, sessionId);
  await superuserPool().query(
    `UPDATE messages SET created_at=NOW() - ($2::int * INTERVAL '1 day'),
       updated_at=NOW() - ($2::int * INTERVAL '1 day') WHERE message_id=$1`,
    [messageId, ageDays],
  );
  return messageId;
}

async function run(input: {
  tenantId: string; userId: string; jobId: string; sessionId: string;
  status: "pending" | "completed" | "failed"; ageDays: number;
}): Promise<string> {
  const runId = `run_${randomUUID()}`;
  await superuserPool().query(
    `INSERT INTO scheduled_job_runs
       (run_id, tenant_id, job_id, user_id, session_id, status, started_at, completed_at, duration_ms, summary)
     VALUES ($1, $2, $3, $4, $5, $6,
       NOW() - ($7::int * INTERVAL '1 day') - INTERVAL '1 minute',
       CASE WHEN $6 = 'pending' THEN NULL ELSE NOW() - ($7::int * INTERVAL '1 day') END,
       60000, 'Run summary')`,
    [runId, input.tenantId, input.jobId, input.userId, input.sessionId, input.status, input.ageDays],
  );
  return runId;
}

async function lease(tenantId: string, userId: string, sessionId: string, status: "active" | "finished", expiresInMinutes: number) {
  await superuserPool().query(
    `INSERT INTO session_executions (tenant_id, session_id, execution_id, user_id, status, expires_at, owner_id, heartbeat_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6::int * INTERVAL '1 minute'), 'retention-test', NOW())`,
    [tenantId, sessionId, `execution_${randomUUID()}`, userId, status, expiresInMinutes],
  );
}

async function sessionExists(sessionId: string): Promise<boolean> {
  return ((await superuserPool().query("SELECT 1 FROM sessions WHERE session_id=$1", [sessionId])).rowCount ?? 0) > 0;
}

async function messageCount(sessionId: string): Promise<number> {
  const result = await superuserPool().query<{ count: number }>(
    "SELECT count(*)::int AS count FROM messages WHERE session_id=$1", [sessionId]);
  return result.rows[0]!.count;
}

async function runRow(runId: string) {
  const result = await superuserPool().query<{
    tenant_id: string; session_id: string | null; status: string; summary: string | null;
  }>("SELECT tenant_id, session_id, status, summary FROM scheduled_job_runs WHERE run_id=$1", [runId]);
  return result.rows[0];
}

// One owner, one job and an expired scheduled run: the shape that each run of
// a job leaves after the run ends.
async function expiredRun(tenantId: string, userId: string, jobId: string) {
  const sessionId = await session(tenantId, userId, { ageDays: OLD });
  await message(tenantId, userId, sessionId, OLD);
  await message(tenantId, userId, sessionId, OLD);
  const runId = await run({ tenantId, userId, jobId, sessionId, status: "completed", ageDays: OLD });
  return { sessionId, runId };
}

function retentionOnlyWorker(store: SessionStore, storage: { delete: (key: string) => Promise<void> }) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const notUsed = () => { throw new Error("A retention-only tick does not run a turn"); };
  const purgeSessionData = vi.fn(async () => undefined);
  const deps = {
    settings: {},
    sessions: store,
    messages: {},
    toolContexts: {},
    runtimeAdapter: {
      id: "retention-test", createSession: notUsed, runMessageAGUI: notUsed, abortSession: notUsed,
      purgeSessionData, destroySandbox: vi.fn(async () => "killed"),
    },
    resolveRuntime: notUsed,
    auditEvents: { create: vi.fn(async () => undefined) },
    sessionTrash: store,
    sessionStorage: storage,
    scheduledSessions: store,
    logger,
  } as unknown as SchedulerWorkerDeps;
  const worker = new SchedulerWorker(deps, {
    schedulingEnabled: false,
    maxConcurrentJobs: 1,
    jobTimeoutMs: 60_000,
    scheduledSessionRetentionDays: RETENTION_DAYS,
  });
  return { worker, logger, purgeSessionData };
}

describe.skipIf(!adminDatabaseUrl())("scheduled session retention", () => {
  test("the scheduler worker deletes expired scheduled sessions and keeps their run history", async () => {
    const tenant = await seedTenant();
    const user = await seedUser();
    const job = await seedScheduledJob({ tenantId: tenant, userId: user, due: false });
    const runs = [
      await expiredRun(tenant, user, job),
      await expiredRun(tenant, user, job),
      await expiredRun(tenant, user, job),
    ];
    const store = new SessionStore(appPool(), maintenancePool());
    const { worker, logger, purgeSessionData } = retentionOnlyWorker(store, { delete: async () => undefined });

    await worker.tick();
    expect(await worker.drain(20_000)).toBe(true);

    expect(logger.error).not.toHaveBeenCalled();
    for (const { sessionId, runId } of runs) {
      expect(await sessionExists(sessionId)).toBe(false);
      expect(await messageCount(sessionId)).toBe(0);
      expect(await runRow(runId)).toEqual({ tenant_id: tenant, session_id: null, status: "completed", summary: "Run summary" });
      expect(purgeSessionData).toHaveBeenCalledWith({ tenantId: tenant, sessionId, userId: user });
    }
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ deletedSessions: expect.any(Number) }),
      "Expired scheduled sessions cleaned up",
    );
  });

  test("deletes only scheduled chats whose last activity is older than the window and that are idle", async () => {
    const tenant = await seedTenant();
    const user = await seedUser();
    const job = await seedScheduledJob({ tenantId: tenant, userId: user, due: false });
    const projectId = `project_${randomUUID()}`;
    await superuserPool().query(
      "INSERT INTO projects (project_id, tenant_id, user_id, name) VALUES ($1, $2, $3, 'Retention')",
      [projectId, tenant, user]);

    // Deleted: the run ended before the window, and nothing happened since.
    const completed = await expiredRun(tenant, user, job);
    const failedSession = await session(tenant, user, { ageDays: OLD });
    const failedRun = await run({ tenantId: tenant, userId: user, jobId: job, sessionId: failedSession, status: "failed", ageDays: OLD });
    // A session with no run row: its job was deleted, or the run row was never written.
    const orphan = await session(tenant, user, { ageDays: OLD });
    await message(tenant, user, orphan, OLD);
    const auditSession = await session(tenant, user, { ageDays: OLD });
    await run({ tenantId: tenant, userId: user, jobId: job, sessionId: auditSession, status: "completed", ageDays: OLD });
    const audit = await superuserPool().query<{ id: string }>(
      `INSERT INTO audit_events (tenant_id, session_id, user_id, event_type, payload)
       VALUES ($1, $2, $3, 'scheduler.job.run.completed', '{}'::jsonb) RETURNING id`,
      [tenant, auditSession, user]);

    // Kept: recent activity.
    const recentOrphan = await session(tenant, user, { ageDays: RECENT });
    const recentRunSession = await session(tenant, user, { ageDays: RECENT });
    const recentRun = await run({ tenantId: tenant, userId: user, jobId: job, sessionId: recentRunSession, status: "completed", ageDays: RECENT });
    const followUp = await expiredRun(tenant, user, job);
    await message(tenant, user, followUp.sessionId, RECENT);
    const renamed = await expiredRun(tenant, user, job);
    await superuserPool().query("UPDATE sessions SET updated_at=NOW() WHERE session_id=$1", [renamed.sessionId]);
    // Kept: live work, even when old.
    const pendingSession = await session(tenant, user, { ageDays: OLD });
    const pendingRun = await run({ tenantId: tenant, userId: user, jobId: job, sessionId: pendingSession, status: "pending", ageDays: OLD });
    const leased = await expiredRun(tenant, user, job);
    await lease(tenant, user, leased.sessionId, "active", 10);
    // The lease sweeper has not stopped this lease yet, so the turn can still write.
    const pastLease = await expiredRun(tenant, user, job);
    await lease(tenant, user, pastLease.sessionId, "active", -10);
    const approval = await expiredRun(tenant, user, job);
    await seedApproval({
      tenantId: tenant, userId: user, sessionId: approval.sessionId,
      runtimeId: await seedRuntimeSession(tenant, user, approval.sessionId), expired: true,
    });
    // Kept: not an active scheduled chat.
    const archived = await session(tenant, user, { ageDays: OLD, status: "archived" });
    const trashed = await session(tenant, user, { ageDays: OLD, status: "deleted" });
    const normal = await session(tenant, user, { ageDays: OLD, purpose: "normal" });
    const projectChat = await session(tenant, user, { ageDays: OLD, purpose: "normal", projectId });
    const scheduledInProject = await session(tenant, user, { ageDays: OLD, projectId });
    const improver = await session(tenant, user, { ageDays: OLD, purpose: "skill_improvement" });

    const store = new SessionStore(appPool(), maintenancePool());
    const result = await store.cleanupExpiredScheduled({ delete: async () => undefined },
      { retentionDays: RETENTION_DAYS, purgeRuntime: async () => undefined });

    expect(result.deletedSessions).toBeGreaterThanOrEqual(4);
    for (const deleted of [completed.sessionId, failedSession, orphan, auditSession]) {
      expect(await sessionExists(deleted)).toBe(false);
      expect(await messageCount(deleted)).toBe(0);
    }
    expect((await runRow(completed.runId))?.session_id).toBeNull();
    expect(await runRow(failedRun)).toEqual({ tenant_id: tenant, session_id: null, status: "failed", summary: "Run summary" });
    // Audit evidence outlives the session.
    const auditRow = await superuserPool().query("SELECT session_id FROM audit_events WHERE id=$1", [audit.rows[0]!.id]);
    expect(auditRow.rows).toEqual([{ session_id: null }]);

    for (const kept of [
      recentOrphan, recentRunSession, followUp.sessionId, renamed.sessionId, pendingSession,
      leased.sessionId, pastLease.sessionId, approval.sessionId,
      archived, trashed, normal, projectChat, scheduledInProject, improver,
    ]) {
      expect(await sessionExists(kept)).toBe(true);
    }
    expect(await messageCount(followUp.sessionId)).toBe(3);
    expect((await runRow(recentRun))?.session_id).toBe(recentRunSession);
    expect((await runRow(pendingRun))?.session_id).toBe(pendingSession);
    expect((await runRow(leased.runId))?.session_id).toBe(leased.sessionId);
    // Trash keeps its own window: the owner can still restore the scheduled chat.
    expect((await store.restoreDeleted(tenant, trashed, user))?.status).toBe("active");
  });

  test("queues objects, checkpoints and the sandbox, and retries a failed external delete", async () => {
    const tenant = await seedTenant();
    const otherTenant = await seedTenant();
    const user = await seedUser();
    const otherUser = await seedUser();
    const job = await seedScheduledJob({ tenantId: tenant, userId: user, due: false });
    const sandboxId = `sandbox_${randomUUID()}`;
    const sessionId = await session(tenant, user, { ageDays: OLD, sandboxId });
    await message(tenant, user, sessionId, OLD);
    const runId = await run({ tenantId: tenant, userId: user, jobId: job, sessionId, status: "completed", ageDays: OLD });
    const runtimeId = await seedRuntimeSession(tenant, user, sessionId);
    const ownKey = `${tenant}/${randomUUID()}/report.txt`;
    const sharedKey = `${tenant}/${randomUUID()}/shared.txt`;
    const ownArtifact = await seedArtifact(tenant, user, sessionId);
    const sharedArtifact = await seedArtifact(tenant, user, sessionId);
    const otherSession = await seedSession(otherTenant, otherUser);
    const otherArtifact = await seedArtifact(otherTenant, otherUser, otherSession);
    await superuserPool().query("UPDATE artifacts SET storage_key=$1 WHERE artifact_id=$2", [ownKey, ownArtifact]);
    await superuserPool().query("UPDATE artifacts SET storage_key=$1 WHERE artifact_id IN ($2, $3)",
      [sharedKey, sharedArtifact, otherArtifact]);

    const store = new SessionStore(appPool(), maintenancePool());
    let bucketDown = true;
    const storageDelete = vi.fn(async (key: string) => {
      if (key === ownKey && bucketDown) {
        bucketDown = false;
        throw new Error("bucket unavailable");
      }
    });
    const purgeRuntime = vi.fn(async (_input: { tenantId: string; sessionId: string; userId: string }) => undefined)
      .mockRejectedValueOnce(new Error("checkpointer unavailable"));
    const destroySandbox = vi.fn(async (_input: { tenantId: string; sessionId: string; sandboxId: string }) => undefined);

    await store.cleanupExpiredScheduled({ delete: storageDelete },
      { retentionDays: RETENTION_DAYS, purgeRuntime, destroySandbox });

    // The rows are gone at once; the external work waits in the GC queues.
    expect(await sessionExists(sessionId)).toBe(false);
    expect((await superuserPool().query("SELECT 1 FROM runtime_sessions WHERE runtime_id=$1", [runtimeId])).rowCount).toBe(0);
    expect((await superuserPool().query("SELECT 1 FROM artifacts WHERE artifact_id IN ($1, $2)", [ownArtifact, sharedArtifact])).rowCount).toBe(0);
    expect((await runRow(runId))?.session_id).toBeNull();
    expect(destroySandbox).toHaveBeenCalledWith({ tenantId: tenant, sessionId, sandboxId });
    expect(storageDelete).toHaveBeenCalledWith(ownKey);
    // Another tenant's artifact still names the shared object.
    expect(storageDelete).not.toHaveBeenCalledWith(sharedKey);
    expect(purgeRuntime).toHaveBeenCalledWith({ tenantId: tenant, sessionId, userId: user });
    const storageGc = await superuserPool().query(
      "SELECT tenant_id, storage_key, attempts, last_error, next_attempt_at > NOW() AS deferred FROM session_storage_gc WHERE session_id=$1",
      [sessionId]);
    expect(storageGc.rows).toEqual([{ tenant_id: tenant, storage_key: ownKey, attempts: 1, last_error: "bucket unavailable", deferred: true }]);
    const runtimeGc = await superuserPool().query(
      "SELECT tenant_id, user_id, last_error, next_attempt_at > NOW() AS deferred FROM session_runtime_gc WHERE session_id=$1",
      [sessionId]);
    expect(runtimeGc.rows).toEqual([{ tenant_id: tenant, user_id: user, last_error: "checkpointer unavailable", deferred: true }]);

    // A later pass retries the external work once it is due again.
    await superuserPool().query("UPDATE session_storage_gc SET next_attempt_at=NOW() WHERE session_id=$1", [sessionId]);
    await superuserPool().query("UPDATE session_runtime_gc SET next_attempt_at=NOW() WHERE session_id=$1", [sessionId]);
    const retried = await store.cleanupExpiredScheduled({ delete: storageDelete },
      { retentionDays: RETENTION_DAYS, purgeRuntime, destroySandbox });

    expect(retried.deletedObjects).toBeGreaterThanOrEqual(1);
    expect(storageDelete.mock.calls.filter(([key]) => key === ownKey)).toHaveLength(2);
    expect(purgeRuntime.mock.calls.filter(([input]) => input.sessionId === sessionId)).toHaveLength(2);
    expect(destroySandbox.mock.calls.filter(([input]) => input.sessionId === sessionId)).toHaveLength(1);
    expect((await superuserPool().query("SELECT 1 FROM session_storage_gc WHERE session_id=$1", [sessionId])).rowCount).toBe(0);
    expect((await superuserPool().query("SELECT 1 FROM session_runtime_gc WHERE session_id=$1", [sessionId])).rowCount).toBe(0);
    expect((await superuserPool().query("SELECT 1 FROM artifacts WHERE artifact_id=$1 AND storage_key=$2", [otherArtifact, sharedKey])).rowCount).toBe(1);
  });

  test("sweeps every tenant and keeps each run and cleanup row in its own tenant", async () => {
    const tenants = await Promise.all([seedTenant(), seedTenant()]);
    const fixtures = await Promise.all(tenants.map(async (tenantId) => {
      const userId = await seedUser();
      const jobId = await seedScheduledJob({ tenantId, userId, due: false });
      const expired = await expiredRun(tenantId, userId, jobId);
      const recentSession = await session(tenantId, userId, { ageDays: RECENT });
      return { tenantId, userId, expired, recentSession };
    }));

    // No runtime purge: the queued rows stay, so the test can read their tenant.
    await new SessionStore(appPool(), maintenancePool())
      .cleanupExpiredScheduled({ delete: async () => undefined }, { retentionDays: RETENTION_DAYS });

    for (const { tenantId, userId, expired, recentSession } of fixtures) {
      expect(await sessionExists(expired.sessionId)).toBe(false);
      expect(await sessionExists(recentSession)).toBe(true);
      expect(await runRow(expired.runId)).toMatchObject({ tenant_id: tenantId, session_id: null });
      const queued = await superuserPool().query(
        "SELECT tenant_id, user_id FROM session_runtime_gc WHERE session_id=$1", [expired.sessionId]);
      expect(queued.rows).toEqual([{ tenant_id: tenantId, user_id: userId }]);
    }
    const [first, second] = fixtures;
    const visible = await withTenantScope(appPool(), first!.tenantId, (db) => db.query(
      "SELECT run_id FROM scheduled_job_runs WHERE run_id = ANY($1::text[])",
      [[first!.expired.runId, second!.expired.runId]]));
    expect(visible.rows).toEqual([{ run_id: first!.expired.runId }]);

    for (const { expired } of fixtures) {
      await superuserPool().query("DELETE FROM session_runtime_gc WHERE session_id=$1", [expired.sessionId]);
    }
  });

  test("deletes at most one batch per pass, oldest first", async () => {
    const tenant = await seedTenant();
    const user = await seedUser();
    const job = await seedScheduledJob({ tenantId: tenant, userId: user, due: false });
    const sessions: string[] = [];
    for (const ageDays of [OLD + 3, OLD + 2, OLD + 1]) {
      const sessionId = await session(tenant, user, { ageDays });
      await run({ tenantId: tenant, userId: user, jobId: job, sessionId, status: "completed", ageDays });
      sessions.push(sessionId);
    }
    const store = new SessionStore(appPool(), maintenancePool());

    const first = await store.cleanupExpiredScheduled({ delete: async () => undefined },
      { retentionDays: RETENTION_DAYS, batchSize: 2, purgeRuntime: async () => undefined });
    expect(first.deletedSessions).toBe(2);
    expect(await Promise.all(sessions.map(sessionExists))).toEqual([false, false, true]);

    await store.cleanupExpiredScheduled({ delete: async () => undefined },
      { retentionDays: RETENTION_DAYS, batchSize: 2, purgeRuntime: async () => undefined });
    expect(await sessionExists(sessions[2]!)).toBe(false);
  });

  test("refuses a retention window shorter than one day", async () => {
    const store = new SessionStore(appPool(), maintenancePool());
    await expect(store.cleanupExpiredScheduled({ delete: async () => undefined }, { retentionDays: 0 }))
      .rejects.toThrow(/at least 1 day/);
  });

  test("two workers split the expired sessions and purge each one once", async () => {
    const tenant = await seedTenant();
    const user = await seedUser();
    const job = await seedScheduledJob({ tenantId: tenant, userId: user, due: false });
    const expired = await Promise.all(Array.from({ length: 6 }, () => expiredRun(tenant, user, job)));
    const ids = new Set(expired.map(({ sessionId }) => sessionId));
    const purged: string[] = [];
    const purgeRuntime = async (input: { sessionId: string }) => { if (ids.has(input.sessionId)) purged.push(input.sessionId); };

    const replicas = [new SessionStore(appPool(), maintenancePool()), new SessionStore(appPool(), maintenancePool())];
    const results = await Promise.all(replicas.map((store) => store.cleanupExpiredScheduled(
      { delete: async () => undefined }, { retentionDays: RETENTION_DAYS, batchSize: 3, purgeRuntime })));

    expect(results.every((result) => result.deletedSessions <= 3)).toBe(true);
    // A replica that started after the other committed takes what is left on its next pass.
    await replicas[0]!.cleanupExpiredScheduled({ delete: async () => undefined },
      { retentionDays: RETENTION_DAYS, batchSize: 6, purgeRuntime });
    for (const sessionId of ids) expect(await sessionExists(sessionId)).toBe(false);
    expect(purged.sort()).toEqual([...ids].sort());
  });

  test("skips a session that a turn admission has locked, and keeps it once the turn holds a lease", async () => {
    const tenant = await seedTenant();
    const user = await seedUser();
    const job = await seedScheduledJob({ tenantId: tenant, userId: user, due: false });
    const target = await expiredRun(tenant, user, job);
    const store = new SessionStore(appPool(), maintenancePool());
    const sweep = () => store.cleanupExpiredScheduled({ delete: async () => undefined },
      { retentionDays: RETENTION_DAYS, purgeRuntime: async () => undefined });

    // SessionExecutionStore.acquire locks the session row before it writes the lease.
    const admission = await superuserPool().connect();
    try {
      await admission.query("BEGIN");
      await admission.query("SELECT 1 FROM sessions WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE", [tenant, target.sessionId]);
      // SKIP LOCKED: the sweep finishes and does not wait for the admission.
      await sweep();
      expect(await sessionExists(target.sessionId)).toBe(true);
      await admission.query(
        `INSERT INTO session_executions (tenant_id, session_id, execution_id, user_id, status, expires_at, owner_id, heartbeat_at)
         VALUES ($1, $2, $3, $4, 'active', NOW() + INTERVAL '10 minutes', 'retention-test', NOW())`,
        [tenant, target.sessionId, `execution_${randomUUID()}`, user]);
      await admission.query("COMMIT");
    } catch (error) {
      await admission.query("ROLLBACK");
      throw error;
    } finally {
      admission.release();
    }

    await sweep();
    expect(await sessionExists(target.sessionId)).toBe(true);

    // The turn ends; the next pass deletes the session.
    await superuserPool().query("UPDATE session_executions SET status='finished' WHERE session_id=$1", [target.sessionId]);
    await sweep();
    expect(await sessionExists(target.sessionId)).toBe(false);
  });

  test("checks the session again after it takes the row lock", async () => {
    // A lease row that an earlier turn left `finished`. A new admission
    // updates that row, and the update needs no lock on the session row. The
    // sweep must see it in a statement that starts after its own lock.
    const tenant = await seedTenant();
    const user = await seedUser();
    const job = await seedScheduledJob({ tenantId: tenant, userId: user, due: false });
    const target = await expiredRun(tenant, user, job);
    await lease(tenant, user, target.sessionId, "finished", -60);

    const pool = new pg.Pool({ connectionString: runMaintenanceUrl(), max: 1 });
    try {
      const connect = pool.connect.bind(pool) as (callback?: unknown) => Promise<pg.PoolClient> | void;
      let reactivated = false;
      // withTransaction calls connect() for its client. pool.query calls
      // connect(callback); that path stays as it is.
      (pool as unknown as { connect: (callback?: unknown) => unknown }).connect = (callback) => {
        if (callback) return connect(callback);
        return (connect() as Promise<pg.PoolClient>).then(patchClient);
      };
      const patchClient = (client: pg.PoolClient) => {
        const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
        const patched = client as unknown as {
          query?: typeof query;
          release: (error?: Error | boolean) => void;
        };
        // The pool hands this client to pool.query later, which calls query with
        // a callback. Put the real methods back when the transaction releases it.
        const release = patched.release;
        patched.release = (error) => {
          delete patched.query;
          patched.release = release;
          release(error);
        };
        patched.query = async (text, values) => {
          const result = await query(text, values);
          if (!reactivated && /FROM sessions[\s\S]*FOR UPDATE[\s\S]*SKIP LOCKED/.test(text)
            && result.rows.some((row: { session_id?: string }) => row.session_id === target.sessionId)) {
            reactivated = true;
            await superuserPool().query(
              `UPDATE session_executions SET status='active', expires_at=NOW() + INTERVAL '10 minutes'
               WHERE tenant_id=$1 AND session_id=$2`, [tenant, target.sessionId]);
          }
          return result;
        };
        return client;
      };

      await new SessionStore(appPool(), pool).cleanupExpiredScheduled({ delete: async () => undefined },
        { retentionDays: RETENTION_DAYS, purgeRuntime: async () => undefined });

      expect(reactivated).toBe(true);
      expect(await sessionExists(target.sessionId)).toBe(true);
      expect(await messageCount(target.sessionId)).toBe(2);
    } finally {
      await pool.end();
      await superuserPool().query("UPDATE session_executions SET status='finished' WHERE session_id=$1", [target.sessionId]);
    }
  });
});
