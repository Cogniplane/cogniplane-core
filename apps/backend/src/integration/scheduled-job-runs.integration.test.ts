// Every claimed scheduled job must leave a row in its run history. The claim
// and the pending run commit in one transaction, so a worker that fails, stops
// or crashes after the claim still leaves a row: the worker completes it, or
// the stale-run sweep does after a crash.
//
// These tests run the production store SQL and SchedulerWorker against real
// Postgres. Only the runtime and the tool context are fakes: no model or
// sandbox runs.

import { randomUUID } from "node:crypto";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { beforeAll, describe, expect, test } from "vitest";

import { AuditEventStore } from "../services/audit-event-store.js";
import { MessageStore } from "../services/message-store.js";
import {
  SCHEDULER_STOPPED_RUN_ERROR,
  SchedulerWorker,
  type SchedulerRuntimeAdapter,
  type SchedulerWorkerDeps
} from "../services/scheduler-worker.js";
import { SessionStore } from "../services/session-store.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { GENERIC_TURN_FAILURE } from "../services/turn-transcript.js";
import { UserSettingsStore } from "../services/user-settings-store.js";
import type { RuntimeSessionRef } from "../runtime-contracts.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedScheduledJob, seedScheduledJobRun, seedTenantGraph, type TenantFixture } from "./support/fixtures.js";
import { buildMessageApp } from "./support/message-app.js";

function store(): UserSettingsStore {
  return new UserSettingsStore(appPool(), maintenancePool());
}

type RunRow = {
  run_id: string;
  tenant_id: string;
  session_id: string | null;
  status: string;
  error_message: string | null;
  completed_at: Date | null;
};

async function runsOf(jobId: string): Promise<RunRow[]> {
  return (await superuserPool().query<RunRow>(
    `SELECT run_id, tenant_id, session_id, status, error_message, completed_at
     FROM scheduled_job_runs WHERE job_id = $1 ORDER BY created_at`,
    [jobId]
  )).rows;
}

async function jobState(jobId: string) {
  return (await superuserPool().query<{ last_run_at: Date | null; next_run_at: Date | null; consecutive_failures: number }>(
    "SELECT last_run_at, next_run_at, consecutive_failures FROM scheduled_jobs WHERE job_id = $1",
    [jobId]
  )).rows[0];
}

async function scheduledSessions(tenantId: string): Promise<string[]> {
  return (await superuserPool().query<{ session_id: string }>(
    "SELECT session_id FROM sessions WHERE tenant_id = $1 AND session_name LIKE '[Scheduled]%'",
    [tenantId]
  )).rows.map((row) => row.session_id);
}

async function runAudits(tenantId: string) {
  return (await superuserPool().query<{ event_type: string; payload: Record<string, unknown> }>(
    `SELECT event_type, payload FROM audit_events
     WHERE tenant_id = $1 AND event_type LIKE 'scheduler.job.run.%' ORDER BY id`,
    [tenantId]
  )).rows;
}

describe.skipIf(!adminDatabaseUrl())("scheduled job claim and run history", () => {
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    tenantA = await seedTenantGraph();
    tenantB = await seedTenantGraph();
  });

  test("a claim commits the job and its pending run together", async () => {
    const jobId = await seedScheduledJob(tenantA);
    const runId = randomUUID();

    const claimed = await store().claimJob(tenantA.tenantId, jobId, runId);

    expect(claimed).toMatchObject({ status: "claimed", job: { jobId, runId, tenantId: tenantA.tenantId } });
    expect(await runsOf(jobId)).toEqual([
      { run_id: runId, tenant_id: tenantA.tenantId, session_id: null, status: "pending", error_message: null, completed_at: null }
    ]);
    const job = await jobState(jobId);
    expect(job?.last_run_at).toBeInstanceOf(Date);
    expect(job?.next_run_at?.getTime()).toBeGreaterThan(Date.now());
  });

  test("a run insert that fails rolls the claim back", async () => {
    const jobId = await seedScheduledJob(tenantA);
    // A run id that is already taken makes the insert fail after the UPDATE.
    const takenRunId = await seedScheduledJobRun({ ...tenantA, jobId, ageMs: 0 });
    await superuserPool().query("UPDATE scheduled_job_runs SET status = 'completed' WHERE run_id = $1", [takenRunId]);
    const before = await jobState(jobId);

    await expect(store().claimJob(tenantA.tenantId, jobId, takenRunId)).rejects.toMatchObject({ code: "23505" });

    // Still due, with no claim time and no new run: the next tick claims it.
    expect(await jobState(jobId)).toEqual(before);
    expect((await runsOf(jobId)).map((run) => run.run_id)).toEqual([takenRunId]);
    const retry = randomUUID();
    expect(await store().claimJob(tenantA.tenantId, jobId, retry)).toMatchObject({ status: "claimed", job: { jobId, runId: retry } });
  });

  test("a claim with another tenant's id changes no job and writes no run", async () => {
    const jobId = await seedScheduledJob(tenantA);
    const before = await jobState(jobId);
    const runId = randomUUID();

    expect(await store().claimJob(tenantB.tenantId, jobId, runId)).toEqual({ status: "not_claimed" });

    expect(await jobState(jobId)).toEqual(before);
    expect(await runsOf(jobId)).toEqual([]);
    expect((await superuserPool().query("SELECT 1 FROM scheduled_job_runs WHERE run_id = $1", [runId])).rowCount).toBe(0);

    // Positive control: the owner's tenant claims it, so the refusal above was
    // the tenant boundary and not a broken fixture.
    expect(await store().claimJob(tenantA.tenantId, jobId, runId)).toMatchObject({ status: "claimed", job: { jobId, runId } });
    expect((await runsOf(jobId)).map((run) => run.tenant_id)).toEqual([tenantA.tenantId]);
  });

  test("the run gets its session, then its outcome", async () => {
    const jobId = await seedScheduledJob(tenantA);
    const runId = randomUUID();
    await store().claimJob(tenantA.tenantId, jobId, runId);

    expect(await store().attachJobRunSession({ tenantId: tenantB.tenantId, runId, sessionId: tenantB.sessionId })).toBe(false);
    expect(await store().attachJobRunSession({ tenantId: tenantA.tenantId, runId, sessionId: tenantA.sessionId })).toBe(true);
    const completed = await store().finishJobRun({
      tenantId: tenantA.tenantId, jobId, runId, revision: 0, status: "completed", durationMs: 1200,
      inputTokens: 10, outputTokens: 20, errorMessage: null, summary: "done", counts: true, disableAtFailures: 0
    });

    expect(completed).toMatchObject({
      status: "finished", run: { runId, sessionId: tenantA.sessionId, status: "completed", summary: "done" }
    });
    expect(await runsOf(jobId)).toEqual([expect.objectContaining({
      run_id: runId, session_id: tenantA.sessionId, status: "completed", completed_at: expect.any(Date)
    })]);
  });

  test("finishing a run that has no row reports it missing", async () => {
    const finish = (jobId: string) => store().finishJobRun({
      tenantId: tenantA.tenantId, jobId, runId: randomUUID(), revision: 0, status: "failed", durationMs: 1,
      inputTokens: 0, outputTokens: 0, errorMessage: GENERIC_TURN_FAILURE, summary: null, counts: true,
      disableAtFailures: 0
    });
    // The job is gone, or the job has no such run.
    expect(await finish(randomUUID())).toEqual({ status: "missing" });
    expect(await finish(await seedScheduledJob(tenantA))).toEqual({ status: "missing" });
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

/**
 * The production store, limited to one tenant's due jobs: the suite database
 * holds due jobs of other test files too. `afterClaim` runs when a claim
 * returns, before the worker starts the job.
 */
class TenantSettings extends UserSettingsStore {
  constructor(
    private readonly scopeTenantId: string,
    private readonly afterClaim?: () => void
  ) {
    super(appPool(), maintenancePool());
  }

  override async listDueJobs(limit: number) {
    return (await super.listDueJobs(10_000)).filter((job) => job.tenantId === this.scopeTenantId).slice(0, limit);
  }

  override async claimJob(...args: Parameters<UserSettingsStore["claimJob"]>) {
    const claimed = await super.claimJob(...args);
    if (claimed.status === "claimed") this.afterClaim?.();
    return claimed;
  }
}

function scopedWorker(tenantId: string, options: {
  sessions?: SchedulerWorkerDeps["sessions"];
  afterClaim?: (worker: SchedulerWorker) => void;
  jobTimeoutMs?: number;
  abortSettleGraceMs?: number;
  /** The lease store of the worker's replica. */
  executions?: SessionExecutionStore;
  /** Runs inside the turn, after RUN_STARTED. */
  duringTurn?: () => Promise<void>;
} = {}) {
  const runtimeSessions: string[] = [];
  const runtime: SchedulerRuntimeAdapter = {
    id: "deep-agents",
    createSession: async (input) => {
      runtimeSessions.push(input.sessionId);
      return sessionRef(input.sessionId);
    },
    runMessageAGUI: (session) => (async function* (): AsyncGenerator<BaseEvent> {
      yield { type: EventType.RUN_STARTED, threadId: session.sessionId, runId: "run" } as BaseEvent;
      await options.duringTurn?.();
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Digest ready." } as BaseEvent;
      yield { type: EventType.RUN_FINISHED, threadId: session.sessionId, runId: "run" } as BaseEvent;
    })(),
    abortSession: async () => {},
    purgeSessionData: async () => {},
    destroySandbox: async () => "killed"
  };
  // The callback runs only during a tick, after `worker` exists.
  const settings = new TenantSettings(tenantId, () => options.afterClaim?.(worker));
  const worker = new SchedulerWorker({
    settings,
    sessions: options.sessions ?? new SessionStore(appPool()),
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
      executions: options.executions ?? new SessionExecutionStore(appPool()),
      limits: { consumeTurnQuota: async () => null },
      leaseMs: 30_000,
      heartbeatMs: 5_000,
      caps: { perUser: 5, perTenant: 50 }
    },
    auditEvents: new AuditEventStore(appPool()),
    disableJob: ({ tenantId: jobTenantId, jobId, revision, audit }) => settings.disableJob(jobTenantId, jobId, revision, audit),
    logger: createSilentLogger()
  }, {
    maxConcurrentJobs: 5,
    jobTimeoutMs: options.jobTimeoutMs ?? 60_000,
    abortSettleGraceMs: options.abortSettleGraceMs,
    maxConsecutiveFailures: 3
  });
  return { worker, runtimeSessions };
}

describe.skipIf(!adminDatabaseUrl())("scheduler worker run history", () => {
  test("a run that completes keeps one row with its session", async () => {
    const tenant = await seedTenantGraph();
    const { worker } = scopedWorker(tenant.tenantId);

    await worker.tick();

    const sessions = await scheduledSessions(tenant.tenantId);
    expect(sessions).toHaveLength(1);
    expect(await runsOf(tenant.jobId)).toEqual([expect.objectContaining({
      tenant_id: tenant.tenantId, session_id: sessions[0], status: "completed", error_message: null
    })]);
    expect((await jobState(tenant.jobId))?.consecutive_failures).toBe(0);
  });

  test("a session that cannot be created fails the claimed run with a safe message", async () => {
    const tenant = await seedTenantGraph();
    const { worker, runtimeSessions } = scopedWorker(tenant.tenantId, {
      sessions: {
        create: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.7:5432 user=app_user password=hunter2");
        }
      }
    });

    await worker.tick();

    const runs = await runsOf(tenant.jobId);
    expect(runs).toEqual([expect.objectContaining({
      tenant_id: tenant.tenantId, session_id: null, status: "failed",
      error_message: GENERIC_TURN_FAILURE, completed_at: expect.any(Date)
    })]);
    expect(runtimeSessions).toEqual([]);
    // The failure counts toward the auto-disable, as every job failure does.
    expect((await jobState(tenant.jobId))?.consecutive_failures).toBe(1);
    expect(await runAudits(tenant.tenantId)).toEqual([{
      event_type: "scheduler.job.run.failed",
      payload: expect.objectContaining({ jobId: tenant.jobId, runId: runs[0]?.run_id, errorMessage: GENERIC_TURN_FAILURE })
    }]);
    expect(JSON.stringify(await runAudits(tenant.tenantId))).not.toContain("hunter2");
  });

  test("a shutdown after the claim fails the run before a session exists", async () => {
    const tenant = await seedTenantGraph();
    const { worker, runtimeSessions } = scopedWorker(tenant.tenantId, {
      afterClaim: (claimingWorker) => claimingWorker.refuseNewTurns()
    });

    await worker.tick();
    await expect(worker.drain(5_000)).resolves.toBe(true);

    expect(await scheduledSessions(tenant.tenantId)).toEqual([]);
    expect(runtimeSessions).toEqual([]);
    expect(await runsOf(tenant.jobId)).toEqual([expect.objectContaining({
      session_id: null, status: "failed", error_message: SCHEDULER_STOPPED_RUN_ERROR, completed_at: expect.any(Date)
    })]);
  });

  test("a run whose session creation outlives the timeout is pending, then failed", async () => {
    const tenant = await seedTenantGraph();
    const sessionStore = new SessionStore(appPool());
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const { worker, runtimeSessions } = scopedWorker(tenant.tenantId, {
      jobTimeoutMs: 50,
      abortSettleGraceMs: 50,
      sessions: {
        create: async (...args: Parameters<SessionStore["create"]>) => {
          await createGate;
          return sessionStore.create(...args);
        }
      }
    });

    // The tick returns after the timeout and the abort grace, while the
    // session is still being created.
    await worker.tick();
    expect(await runsOf(tenant.jobId)).toEqual([expect.objectContaining({ session_id: null, status: "pending" })]);

    releaseCreate();
    await expect(worker.drain(5_000)).resolves.toBe(true);

    const sessions = await scheduledSessions(tenant.tenantId);
    expect(sessions).toHaveLength(1);
    expect(runtimeSessions).toEqual([]);
    expect(await runsOf(tenant.jobId)).toEqual([expect.objectContaining({
      session_id: sessions[0], status: "failed", error_message: "Scheduled job timed out after 50ms"
    })]);
  });

  test("a run that a crash left after the claim is failed by the stale-run sweep", async () => {
    const tenant = await seedTenantGraph();
    const runId = randomUUID();
    expect(await store().claimJob(tenant.tenantId, tenant.jobId, runId)).toMatchObject({ status: "claimed" });
    // The worker dies here: no session, no turn, no completion. Age the row
    // past the sweep cutoff (job timeout + abort grace + buffer).
    await superuserPool().query(
      "UPDATE scheduled_job_runs SET started_at = NOW() - INTERVAL '1 hour' WHERE run_id = $1", [runId]
    );

    const { worker } = scopedWorker(tenant.tenantId, { jobTimeoutMs: 1_000, abortSettleGraceMs: 1_000 });
    await worker.tick();

    expect(await runsOf(tenant.jobId)).toEqual([expect.objectContaining({
      run_id: runId, session_id: null, status: "failed",
      error_message: "Run orphaned by a scheduler crash or restart", completed_at: expect.any(Date)
    })]);
    expect(await runAudits(tenant.tenantId)).toEqual([{
      event_type: "scheduler.job.run.failed",
      payload: { jobId: tenant.jobId, runId, reason: "orphaned_on_sweep" }
    }]);
    // A crash is not the job's fault: the failure counter does not move.
    expect((await jobState(tenant.jobId))?.consecutive_failures).toBe(0);
  });

  // Two replicas on one database: A runs the scheduled turn, B serves the owner.
  test("a scheduled turn holds the session lease on every replica until its cleanup ends", async () => {
    const tenant = await seedTenantGraph();
    const replicaB = await buildMessageApp({ tenantId: tenant.tenantId, auth: { userId: tenant.userId } });
    const sessionStore = new SessionStore(appPool());
    const listed = async (sessionId: string) =>
      (await sessionStore.listPage(tenant.tenantId, tenant.userId, { ids: [sessionId], purposes: "all" })).sessions[0];
    let seen: { busyAcquire: unknown; busyMessage: { statusCode: number; body: unknown }; running: unknown } | null = null;
    const { worker } = scopedWorker(tenant.tenantId, {
      executions: new SessionExecutionStore(appPool(), "replica-a"),
      duringTurn: async () => {
        const [sessionId] = await scheduledSessions(tenant.tenantId);
        const busyAcquire = await new SessionExecutionStore(appPool(), "replica-b")
          .acquire({ tenantId: tenant.tenantId, sessionId: sessionId!, userId: tenant.userId }, 30_000)
          .then(() => "admitted", (error: unknown) => error);
        const response = await replicaB.send(sessionId!, "Continue the digest");
        seen = {
          busyAcquire,
          busyMessage: { statusCode: response.statusCode, body: response.json() },
          running: (await listed(sessionId!))?.isRunning
        };
      }
    });

    await worker.tick();

    const [sessionId] = await scheduledSessions(tenant.tenantId);
    expect(seen).toEqual({
      busyAcquire: expect.objectContaining({ code: "session_busy" }),
      busyMessage: { statusCode: 409, body: expect.objectContaining({ error: "session_busy" }) },
      running: true
    });
    // The rejected message saved nothing and spent no quota.
    expect(replicaB.quota).not.toHaveBeenCalled();
    expect(await runsOf(tenant.jobId)).toEqual([expect.objectContaining({ session_id: sessionId, status: "completed" })]);
    expect((await listed(sessionId!))?.isRunning).toBe(false);
    const lease = await superuserPool().query<{ status: string; owner_id: string }>(
      "SELECT status, owner_id FROM session_executions WHERE tenant_id=$1 AND session_id=$2", [tenant.tenantId, sessionId]);
    expect(lease.rows).toEqual([{ status: "finished", owner_id: "replica-a" }]);
  });
});
