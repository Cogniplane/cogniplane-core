// Each scheduled slot runs at most once, a job never has two runs at the same
// time, each run gets one outcome and at most one terminal audit event, and a
// job that reaches the failure limit runs no further slot.
//
// These tests run the production store SQL (and, for the replica race, the
// production SchedulerWorker) against real Postgres. Only the runtime and the
// tool context are fakes.

import { randomUUID } from "node:crypto";
import { EventType, type BaseEvent } from "@ag-ui/client";
import pg from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AuditEventStore } from "../services/audit-event-store.js";
import { MessageStore } from "../services/message-store.js";
import { SchedulerWorker, type SchedulerRuntimeAdapter } from "../services/scheduler-worker.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { SessionStore } from "../services/session-store.js";
import { SKIPPED_RUN_MESSAGE, UserSettingsStore } from "../services/user-settings-store.js";
import type { RuntimeSessionRef } from "../runtime-contracts.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { adminDatabaseUrl, appPool, maintenancePool, runAppUserUrl, superuserPool } from "./support/database.js";
import { seedScheduledJob, seedTenantGraph } from "./support/fixtures.js";

const ORPHAN_ERROR = "Run orphaned by a scheduler crash or restart";

function store(): UserSettingsStore {
  return new UserSettingsStore(appPool(), maintenancePool());
}

type RunRow = {
  run_id: string;
  status: string;
  scheduled_for: Date | null;
  completed_at: Date | null;
  error_message: string | null;
};

async function runsOf(jobId: string): Promise<RunRow[]> {
  return (await superuserPool().query<RunRow>(
    `SELECT run_id, status, scheduled_for, completed_at, error_message
     FROM scheduled_job_runs WHERE job_id = $1 ORDER BY created_at, status`,
    [jobId]
  )).rows;
}

type JobRow = {
  next_run_at: Date | null;
  last_run_at: Date | null;
  consecutive_failures: number;
  revision: number;
  enabled: boolean;
  paused_reason: string | null;
};

async function jobRow(jobId: string): Promise<JobRow> {
  return (await superuserPool().query<JobRow>(
    `SELECT next_run_at, last_run_at, consecutive_failures, revision, enabled, paused_reason
     FROM scheduled_jobs WHERE job_id = $1`,
    [jobId]
  )).rows[0]!;
}

async function dbNow(): Promise<Date> {
  return (await superuserPool().query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
}

/**
 * Puts the job's next slot back to the slot of `runId`, as a writer with a late
 * clock could. Copied in SQL: a JavaScript Date drops the microseconds.
 */
async function putSlotBack(jobId: string, runId: string): Promise<void> {
  await superuserPool().query(
    `UPDATE scheduled_jobs
     SET next_run_at = (SELECT scheduled_for FROM scheduled_job_runs WHERE run_id = $2)
     WHERE job_id = $1`,
    [jobId, runId]
  );
}

/** Makes the job due again at a new slot, `secondsAgo` seconds in the past. */
async function dueAgain(jobId: string, secondsAgo: number): Promise<Date> {
  return (await superuserPool().query<{ next_run_at: Date }>(
    `UPDATE scheduled_jobs SET next_run_at = NOW() - ($2::int * INTERVAL '1 second')
     WHERE job_id = $1 RETURNING next_run_at`,
    [jobId, secondsAgo]
  )).rows[0]!.next_run_at;
}

/** Ages a run past the stale-run cutoffs used below. */
async function ageRun(runId: string): Promise<void> {
  await superuserPool().query(
    "UPDATE scheduled_job_runs SET started_at = NOW() - INTERVAL '2 hours' WHERE run_id = $1", [runId]
  );
}

const finishInput = (
  tenantId: string, jobId: string, runId: string, revision: number, status: "completed" | "failed",
  disableAtFailures = 0
) => ({
  tenantId, jobId, runId, revision, status, durationMs: 10, inputTokens: 1, outputTokens: 2,
  errorMessage: status === "failed" ? "provider timeout" : null, summary: null, counts: true, disableAtFailures
});

/** The terminal audit events of one run. */
async function runEvents(tenantId: string, runId: string): Promise<string[]> {
  return (await superuserPool().query<{ event_type: string }>(
    `SELECT event_type FROM audit_events
     WHERE tenant_id = $1 AND event_type LIKE 'scheduler.job.run.%' AND payload->>'runId' = $2 ORDER BY id`,
    [tenantId, runId]
  )).rows.map((row) => row.event_type);
}

async function backendPid(client: { query: pg.Pool["query"] }): Promise<number> {
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
}

/** Waits until `waiterPid` waits for a lock that `holderPid` holds. */
async function waitUntilBlocked(waiterPid: number, holderPid: number): Promise<void> {
  await expect.poll(async () => (await superuserPool().query<{ blocked: boolean }>(
    "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [holderPid, waiterPid]
  )).rows[0]!.blocked, { timeout: 5_000, interval: 10 }).toBe(true);
}

describe.skipIf(!adminDatabaseUrl())("scheduled job slots", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a claim takes the next slot from the database clock, also when the worker clock is late", async () => {
    const tenant = await seedTenantGraph();
    const jobId = await seedScheduledJob(tenant);
    await superuserPool().query("UPDATE scheduled_jobs SET cron_expression = '* * * * *' WHERE job_id = $1", [jobId]);
    const slot = (await jobRow(jobId)).next_run_at!;
    const before = await dbNow();
    // The worker process runs ten minutes behind the database. Only Date is
    // faked, so the database driver's timers still run.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() - 10 * 60_000));

    const first = await store().claimJob(tenant.tenantId, jobId, randomUUID());
    const second = await store().claimJob(tenant.tenantId, jobId, randomUUID());

    expect(first).toMatchObject({ status: "claimed", job: { scheduledFor: slot.toISOString() } });
    expect(second).toEqual({ status: "not_claimed" });
    const next = (await jobRow(jobId)).next_run_at!;
    // The minute after the database clock. The worker clock would give a
    // minute about nine minutes in the past, and the job would be due again.
    expect(next.getTime()).toBeGreaterThan(before.getTime());
    expect(next.getTime()).toBeLessThanOrEqual(before.getTime() + 2 * 60_000);
    expect(next.getUTCSeconds()).toBe(0);
    expect(await runsOf(jobId)).toEqual([expect.objectContaining({ status: "pending", scheduled_for: slot })]);
  });

  test("a slot that already has a run is not run again; the job moves to its next slot", async () => {
    const tenant = await seedTenantGraph();
    const jobId = await seedScheduledJob(tenant);
    const slot = (await jobRow(jobId)).next_run_at!;
    const firstRun = randomUUID();
    const first = await store().claimJob(tenant.tenantId, jobId, firstRun);
    expect(first.status).toBe("claimed");
    const lastRun = (await jobRow(jobId)).last_run_at;

    // A writer with a late clock puts the claimed slot back.
    await putSlotBack(jobId, firstRun);
    expect(await store().claimJob(tenant.tenantId, jobId, randomUUID()))
      .toEqual({ status: "slot_taken", scheduledFor: slot.toISOString() });

    expect(await runsOf(jobId)).toEqual([expect.objectContaining({ status: "pending", scheduled_for: slot })]);
    const after = await jobRow(jobId);
    expect(after.next_run_at!.getTime()).toBeGreaterThan(Date.now());
    // No run started, so the turn order record stays.
    expect(after.last_run_at).toEqual(lastRun);
  });

  test("the database refuses a second run row for one slot", async () => {
    const tenant = await seedTenantGraph();
    const jobId = await seedScheduledJob(tenant);
    const runId = randomUUID();
    expect((await store().claimJob(tenant.tenantId, jobId, runId)).status).toBe("claimed");

    await expect(superuserPool().query(
      `INSERT INTO scheduled_job_runs (run_id, tenant_id, job_id, user_id, status, scheduled_for)
       SELECT $1, tenant_id, job_id, user_id, 'completed', scheduled_for FROM scheduled_job_runs WHERE run_id = $2`,
      [randomUUID(), runId]
    )).rejects.toMatchObject({ code: "23505" });
  });

  test("a slot that comes due while the previous run is pending gets a skipped run", async () => {
    const tenant = await seedTenantGraph();
    const jobId = await seedScheduledJob(tenant);
    const firstRun = randomUUID();
    expect((await store().claimJob(tenant.tenantId, jobId, firstRun)).status).toBe("claimed");
    const lastRun = (await jobRow(jobId)).last_run_at;

    const skippedSlot = await dueAgain(jobId, 30);
    const skippedRun = randomUUID();
    expect(await store().claimJob(tenant.tenantId, jobId, skippedRun))
      .toEqual({ status: "skipped", runId: skippedRun, scheduledFor: skippedSlot.toISOString() });

    expect(await runsOf(jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ run_id: firstRun, status: "pending" }),
      expect.objectContaining({
        run_id: skippedRun, status: "skipped", scheduled_for: skippedSlot,
        completed_at: expect.any(Date), error_message: SKIPPED_RUN_MESSAGE
      })
    ]));
    expect(await superuserPool().query("SELECT 1 FROM scheduled_job_runs WHERE job_id = $1 AND status = 'pending'", [jobId]))
      .toMatchObject({ rowCount: 1 });
    const afterSkip = await jobRow(jobId);
    expect(afterSkip.next_run_at!.getTime()).toBeGreaterThan(Date.now());
    expect(afterSkip.last_run_at).toEqual(lastRun);

    // Once the first run finishes, the next slot runs.
    expect(await store().finishJobRun(finishInput(tenant.tenantId, jobId, firstRun, 0, "completed")))
      .toMatchObject({ status: "finished" });
    await dueAgain(jobId, 10);
    expect((await store().claimJob(tenant.tenantId, jobId, randomUUID())).status).toBe("claimed");
  });

  test("the overlap check sees a pending run that committed while the claim waited for the job lock", async () => {
    const tenant = await seedTenantGraph();
    const jobId = await seedScheduledJob(tenant);
    const blocker = await superuserPool().connect();
    const claimPool = new pg.Pool({
      connectionString: runAppUserUrl(), max: 1, lock_timeout: 10_000, statement_timeout: 15_000,
      application_name: "cogniplane-integration-slot-claim"
    });
    let claim: ReturnType<UserSettingsStore["claimJob"]> | undefined;
    try {
      // Another claim holds the job lock and writes its pending run, and the
      // job stays due (as after an owner edit to a past time).
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM scheduled_jobs WHERE job_id = $1 FOR UPDATE", [jobId]);
      await blocker.query(
        `INSERT INTO scheduled_job_runs (run_id, tenant_id, job_id, user_id, status, scheduled_for)
         VALUES ($1, $2, $3, $4, 'pending', NOW() - INTERVAL '5 minutes')`,
        [randomUUID(), tenant.tenantId, jobId, tenant.userId]
      );
      const { rows: [{ pid: blockerPid }] } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const connection = await claimPool.connect();
      const { rows: [{ pid: claimPid }] } = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      connection.release();

      claim = new UserSettingsStore(claimPool, maintenancePool()).claimJob(tenant.tenantId, jobId, randomUUID());
      await expect.poll(async () => (await superuserPool().query<{ blocked: boolean }>(
        "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [blockerPid, claimPid]
      )).rows[0]!.blocked, { timeout: 5_000, interval: 10 }).toBe(true);
      await blocker.query("COMMIT");

      expect(await claim).toMatchObject({ status: "skipped" });
      expect((await runsOf(jobId)).map((run) => run.status).sort()).toEqual(["pending", "skipped"]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await claim?.catch(() => {});
      await claimPool.end();
    }
  });

  test("overlapping claims on many due jobs give one claim per job and one run per slot", async () => {
    const tenant = await seedTenantGraph();
    const jobIds = await Promise.all(Array.from({ length: 8 }, () => seedScheduledJob(tenant)));
    const pools = [0, 1, 2].map((index) => new pg.Pool({
      connectionString: runAppUserUrl(), max: 2, statement_timeout: 15_000,
      application_name: `cogniplane-integration-slot-replica-${index}`
    }));
    try {
      const replicas = pools.map((pool) => new UserSettingsStore(pool, maintenancePool()));
      const results = await Promise.all(jobIds.flatMap((jobId) =>
        replicas.map((replica) => replica.claimJob(tenant.tenantId, jobId, randomUUID()).then((result) => ({ jobId, result })))
      ));
      for (const jobId of jobIds) {
        const statuses = results.filter((entry) => entry.jobId === jobId).map((entry) => entry.result.status).sort();
        expect(statuses).toEqual(["claimed", "not_claimed", "not_claimed"]);
        expect((await runsOf(jobId)).map((run) => run.status)).toEqual(["pending"]);
      }
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });

  test("after a crash right after the claim, the sweep fails the run and the next slot runs", async () => {
    const tenant = await seedTenantGraph();
    const jobId = await seedScheduledJob(tenant);
    const crashedRun = randomUUID();
    const slot = (await jobRow(jobId)).next_run_at!;
    expect((await store().claimJob(tenant.tenantId, jobId, crashedRun)).status).toBe("claimed");
    // The worker dies here. The claimed slot has its run row.
    expect(await runsOf(jobId)).toEqual([expect.objectContaining({ run_id: crashedRun, status: "pending", scheduled_for: slot })]);
    await ageRun(crashedRun);

    // Other test files leave pending runs one hour old; this cutoff skips them.
    const swept = await store().sweepStaleJobRuns(90 * 60_000);
    expect(swept.map((run) => run.runId)).toContain(crashedRun);

    await dueAgain(jobId, 10);
    expect((await store().claimJob(tenant.tenantId, jobId, randomUUID())).status).toBe("claimed");
  });

  test("a late writer cannot change a run that the sweep failed", async () => {
    const tenant = await seedTenantGraph();
    const jobId = await seedScheduledJob({ ...tenant, consecutiveFailures: 2 });
    const runId = randomUUID();
    expect((await store().claimJob(tenant.tenantId, jobId, runId)).status).toBe("claimed");
    await ageRun(runId);
    await store().sweepStaleJobRuns(90 * 60_000);

    expect(await store().attachJobRunSession({ tenantId: tenant.tenantId, runId, sessionId: tenant.sessionId })).toBe(false);
    expect(await store().finishJobRun(finishInput(tenant.tenantId, jobId, runId, 0, "completed")))
      .toEqual({ status: "already_finished" });

    expect(await runsOf(jobId)).toEqual([expect.objectContaining({ status: "failed", error_message: ORPHAN_ERROR })]);
    expect((await jobRow(jobId)).consecutive_failures).toBe(2);
    // A second finish is refused too.
    expect(await store().finishJobRun(finishInput(tenant.tenantId, jobId, runId, 0, "failed", 1)))
      .toEqual({ status: "already_finished" });
  });

  test("a finish takes the job row before the run row, so a job delete during it does not deadlock", async () => {
    const tenant = await seedTenantGraph();
    const jobId = await seedScheduledJob(tenant);
    const runId = randomUUID();
    expect((await store().claimJob(tenant.tenantId, jobId, runId)).status).toBe("claimed");
    const deleter = await superuserPool().connect();
    const finishPool = new pg.Pool({
      connectionString: runAppUserUrl(), max: 1, lock_timeout: 10_000, statement_timeout: 15_000,
      application_name: "cogniplane-integration-slot-finish"
    });
    let finish: ReturnType<UserSettingsStore["finishJobRun"]> | undefined;
    try {
      // The owner's delete holds the job row, as DELETE takes it before the
      // cascade takes the run rows.
      await deleter.query("BEGIN");
      await deleter.query("SET LOCAL lock_timeout = '5s'");
      await deleter.query("SELECT 1 FROM scheduled_jobs WHERE job_id = $1 FOR UPDATE", [jobId]);
      const deleterPid = await backendPid(deleter);
      const connection = await finishPool.connect();
      const finishPid = await backendPid(connection);
      connection.release();

      finish = new UserSettingsStore(finishPool, maintenancePool())
        .finishJobRun(finishInput(tenant.tenantId, jobId, runId, 0, "failed", 1));
      await waitUntilBlocked(finishPid, deleterPid);
      // The waiting finish holds no run row, so the cascade does not wait for
      // it. A finish that took the run row first would deadlock with this
      // DELETE, and PostgreSQL would abort one of them.
      await deleter.query("DELETE FROM scheduled_jobs WHERE job_id = $1", [jobId]);
      await deleter.query("COMMIT");

      expect(await finish).toEqual({ status: "missing" });
      expect(await runsOf(jobId)).toEqual([]);
    } finally {
      await deleter.query("ROLLBACK").catch(() => {});
      deleter.release();
      await finish?.catch(() => {});
      await finishPool.end();
    }
  });

  test("the failure that reaches the limit disables the job in its finish, so the next slot is not claimed", async () => {
    const tenant = await seedTenantGraph();
    const jobId = await seedScheduledJob({ ...tenant, consecutiveFailures: 1 });
    const runId = randomUUID();
    expect((await store().claimJob(tenant.tenantId, jobId, runId)).status).toBe("claimed");

    expect(await store().finishJobRun(finishInput(tenant.tenantId, jobId, runId, 0, "failed", 2)))
      .toMatchObject({ status: "finished", consecutiveFailures: 2, disabled: true });
    expect(await jobRow(jobId)).toMatchObject({ enabled: false, next_run_at: null, consecutive_failures: 2 });

    // A slot due at the limit, for example after a delayed audit write, does not run.
    await dueAgain(jobId, 5);
    expect(await store().claimJob(tenant.tenantId, jobId, randomUUID())).toEqual({ status: "not_claimed" });
    expect((await runsOf(jobId)).map((run) => run.status)).toEqual(["failed"]);
  });

  test("an owner edit resets the counter, and a run of the older revision cannot count or disable", async () => {
    const tenant = await seedTenantGraph();
    const jobId = await seedScheduledJob({ ...tenant, consecutiveFailures: 4 });
    const runId = randomUUID();
    const claim = await store().claimJob(tenant.tenantId, jobId, runId);
    if (claim.status !== "claimed") throw new Error("claimJob did not claim the job");
    expect(claim.job.revision).toBe(0);

    const edited = await store().updateScheduledJob({
      tenantId: tenant.tenantId, jobId, userId: tenant.userId, jobName: "fixed prompt", description: null,
      cronExpression: "0 0 1 1 *", timeZone: "UTC", targetType: "prompt", targetRef: null,
      input: { prompt: "A better prompt." }, settingsSnapshot: {}, enabled: true,
      nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(), ownerSecurityVersion: null
    }, { maxActive: 0 });
    expect(edited).toMatchObject({ status: "updated", job: { consecutiveFailures: 0 } });
    expect(await jobRow(jobId)).toMatchObject({ consecutive_failures: 0, revision: 1 });

    // The run of the older definition fails: it is recorded, but does not
    // count against the edited job and cannot disable it, also at a limit of 1.
    expect(await store().finishJobRun(finishInput(tenant.tenantId, jobId, runId, claim.job.revision, "failed", 1)))
      .toMatchObject({ status: "finished", consecutiveFailures: null, disabled: false, run: { status: "failed" } });
    expect(await store().disableJob(tenant.tenantId, jobId, claim.job.revision)).toBe(false);
    expect(await jobRow(jobId)).toMatchObject({ consecutive_failures: 0, enabled: true });

    // The current revision counts and can disable.
    expect(await store().disableJob(tenant.tenantId, jobId, 1)).toBe(true);
    expect((await jobRow(jobId)).enabled).toBe(false);
  });

  test("a failure disable keeps the security pause of a job paused during the run", async () => {
    const tenant = await seedTenantGraph();
    const jobId = await seedScheduledJob(tenant);
    const runId = randomUUID();
    expect((await store().claimJob(tenant.tenantId, jobId, runId)).status).toBe("claimed");
    // A security change pauses the job while its run is in flight.
    await superuserPool().query(
      "UPDATE scheduled_jobs SET enabled = FALSE, next_run_at = NULL, paused_reason = 'security_change' WHERE job_id = $1",
      [jobId]
    );

    expect(await store().finishJobRun(finishInput(tenant.tenantId, jobId, runId, 0, "failed", 1)))
      .toMatchObject({ status: "finished", consecutiveFailures: 1, disabled: false });
    expect(await store().disableJob(tenant.tenantId, jobId, 0)).toBe(false);
    expect(await jobRow(jobId)).toMatchObject({ enabled: false, paused_reason: "security_change" });
  });
});

function sessionRef(sessionId: string): RuntimeSessionRef {
  return {
    sessionId,
    runtimeId: `rt-${sessionId}`,
    runtimePolicy: {
      id: "default-profile", label: "Default", description: null, webSearchMode: "disabled",
      approvalPolicy: "never", approvalReviewer: "user", sandboxMode: "workspace-write",
      sandboxEgressDomains: [], allowCommandExecution: true, autoApproveReadOnlyTools: false,
      policyEnforcementMode: "monitor", developerInstructions: null, enabledToolIds: [],
      enabledMcpServers: [], version: 1, hash: "abc123"
    }
  };
}

type ReplicaOptions = {
  /** Runs inside the turn, before it ends. */
  duringTurn?: () => Promise<void>;
  /** The turn succeeds. Default: the provider fails it. */
  succeed?: boolean;
  /** Runs before each audit write of the worker. */
  beforeAudit?: (event: { type: string }) => Promise<void>;
};

/** A replica's worker, limited to one tenant's due jobs. */
function replicaWorker(tenantId: string, replica: string, options: ReplicaOptions = {}): SchedulerWorker {
  const runtime: SchedulerRuntimeAdapter = {
    id: "deep-agents",
    createSession: async (input) => sessionRef(input.sessionId),
    runMessageAGUI: (session) => (async function* (): AsyncGenerator<BaseEvent> {
      yield { type: EventType.RUN_STARTED, threadId: session.sessionId, runId: "run" } as BaseEvent;
      await options.duringTurn?.();
      if (options.succeed) {
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Done." } as BaseEvent;
        yield { type: EventType.RUN_FINISHED, threadId: session.sessionId, runId: "run" } as BaseEvent;
      } else {
        yield { type: EventType.RUN_ERROR, message: "provider failed" } as BaseEvent;
      }
    })(),
    abortSession: async () => {},
    purgeSessionData: async () => {},
    destroySandbox: async () => "killed"
  };
  const settings = new UserSettingsStore(appPool(), maintenancePool());
  const audits = new AuditEventStore(appPool());
  return new SchedulerWorker({
    settings: {
      listDueJobs: async (limit) => (await settings.listDueJobs(10_000)).filter((job) => job.tenantId === tenantId).slice(0, limit),
      claimJob: settings.claimJob.bind(settings),
      parkJob: settings.parkJob.bind(settings),
      attachJobRunSession: settings.attachJobRunSession.bind(settings),
      finishJobRun: settings.finishJobRun.bind(settings),
      // Other test files leave pending runs one hour old; sweep only older ones.
      sweepStaleJobRuns: (_olderThanMs, limit, audit) => settings.sweepStaleJobRuns(90 * 60_000, limit, audit),
      pauseJobForSecurityChange: settings.pauseJobForSecurityChange.bind(settings),
      getOwnerSecurityVersion: settings.getOwnerSecurityVersion.bind(settings)
    },
    sessions: new SessionStore(appPool()),
    messages: new MessageStore(appPool()),
    toolContexts: {
      create: async (input) => ({
        toolContextId: randomUUID(), tenantId: input.tenantId, sessionId: input.sessionId, userId: input.userId,
        runtimeId: input.runtimeId, runtimePolicyId: input.runtimePolicyId, messageId: input.messageId,
        credentialEnvelope: {}, metadata: input.metadata ?? {},
        expiresAt: new Date(Date.now() + input.ttlMs).toISOString(), createdAt: new Date().toISOString()
      })
    },
    runtimeAdapter: runtime,
    resolveRuntime: async () => ({ kind: "ok", adapter: runtime, modelId: null }),
    turnAdmission: {
      executions: new SessionExecutionStore(appPool(), replica),
      limits: { consumeTurnQuota: async () => null },
      leaseMs: 30_000,
      heartbeatMs: 5_000,
      caps: { perUser: 5, perTenant: 50 }
    },
    auditEvents: {
      create: async (event) => {
        await options.beforeAudit?.(event);
        return audits.create(event);
      }
    },
    disableJob: (input) => settings.disableJob(input.tenantId, input.jobId, input.revision, input.audit),
    logger: createSilentLogger()
  }, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000, maxConsecutiveFailures: 1 });
}

describe.skipIf(!adminDatabaseUrl())("scheduled job slots across replicas", () => {
  test("a run that another replica swept keeps one outcome and one terminal audit event", async () => {
    const tenant = await seedTenantGraph();
    const replicaB = replicaWorker(tenant.tenantId, "replica-b");
    // Replica A's turn outlives the stale-run cutoff (aged here), and replica
    // B sweeps the run as orphaned while A still runs it.
    const replicaA = replicaWorker(tenant.tenantId, "replica-a", {
      duringTurn: async () => {
        const [run] = await runsOf(tenant.jobId);
        await ageRun(run!.run_id);
        await replicaB.tick();
      }
    });

    await replicaA.tick();

    const runs = await runsOf(tenant.jobId);
    expect(runs).toEqual([expect.objectContaining({ status: "failed", error_message: ORPHAN_ERROR })]);
    const audits = (await superuserPool().query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM audit_events
       WHERE tenant_id = $1 AND event_type LIKE 'scheduler.job.%' ORDER BY id`,
      [tenant.tenantId]
    )).rows;
    expect(audits).toEqual([{
      event_type: "scheduler.job.run.failed",
      payload: { jobId: tenant.jobId, runId: runs[0]!.run_id, reason: "orphaned_on_sweep" }
    }]);
    // A's late failure did not count, so the limit of 1 did not disable the job.
    expect(await jobRow(tenant.jobId)).toMatchObject({ consecutive_failures: 0, enabled: true });
  });

  test("a slot that comes due during a long run is skipped on another replica", async () => {
    const tenant = await seedTenantGraph();
    const replicaB = replicaWorker(tenant.tenantId, "replica-b");
    let skippedSlot: Date | null = null;
    const replicaA = replicaWorker(tenant.tenantId, "replica-a", {
      duringTurn: async () => {
        skippedSlot = await dueAgain(tenant.jobId, 5);
        await replicaB.tick();
      }
    });

    await replicaA.tick();

    const runs = await runsOf(tenant.jobId);
    expect(runs.map((run) => run.status).sort()).toEqual(["failed", "skipped"]);
    expect(runs.find((run) => run.status === "skipped")?.scheduled_for).toEqual(skippedSlot);
    // One session: replica B started no turn.
    expect((await superuserPool().query(
      "SELECT 1 FROM sessions WHERE tenant_id = $1 AND purpose = 'scheduled'", [tenant.tenantId]
    )).rowCount).toBe(1);
  });

  test("a run that is swept and then deleted with its job gets no second terminal audit event", async () => {
    const tenant = await seedTenantGraph();
    const replicaB = replicaWorker(tenant.tenantId, "replica-b");
    let runId = "";
    // Replica B sweeps A's run as orphaned and writes its event. Then the
    // owner deletes the job, and the run row goes with it. Then A's turn ends.
    const replicaA = replicaWorker(tenant.tenantId, "replica-a", {
      duringTurn: async () => {
        const [run] = await runsOf(tenant.jobId);
        runId = run!.run_id;
        await ageRun(runId);
        await replicaB.tick();
        expect(await store().deleteScheduledJob(tenant.tenantId, tenant.jobId, tenant.userId)).toBe(true);
      }
    });

    await replicaA.tick();

    expect(await runsOf(tenant.jobId)).toEqual([]);
    expect(await runEvents(tenant.tenantId, runId)).toEqual(["scheduler.job.run.failed"]);
  });

  test("a failure at the limit is disabled before its audit writes, so no replica runs the next slot", async () => {
    const tenant = await seedTenantGraph();
    const replicaB = replicaWorker(tenant.tenantId, "replica-b", { succeed: true });
    const replicaA = replicaWorker(tenant.tenantId, "replica-a", {
      // A's run event waits while the next slot comes due and replica B
      // ticks, as a slow audit write at a cron boundary could.
      beforeAudit: async (event) => {
        if (event.type !== "scheduler.job.run.failed") return;
        await dueAgain(tenant.jobId, 5);
        await replicaB.tick();
      }
    });

    await replicaA.tick();

    // The first failure reached the limit of 1. B did not claim the next slot,
    // so no later success can be followed by a delayed disable.
    expect((await runsOf(tenant.jobId)).map((run) => run.status)).toEqual(["failed"]);
    expect((await superuserPool().query(
      "SELECT 1 FROM sessions WHERE tenant_id = $1 AND purpose = 'scheduled'", [tenant.tenantId]
    )).rowCount).toBe(1);
    expect(await jobRow(tenant.jobId)).toMatchObject({ enabled: false, consecutive_failures: 1 });
    const audits = (await superuserPool().query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM audit_events
       WHERE tenant_id = $1 AND event_type LIKE 'scheduler.job.%' ORDER BY id`,
      [tenant.tenantId]
    )).rows;
    expect(audits.map((row) => row.event_type)).toEqual(["scheduler.job.run.failed", "scheduler.job.disabled"]);
    expect(audits[1]!.payload).toMatchObject({ reason: "repeated_failures", consecutiveFailures: 1, threshold: 1, disabled: true });
  });
});
