// The scheduler has few slots (SCHEDULER_MAX_CONCURRENT_JOBS per process) for
// the due jobs of all tenants. One member can hold 50 enabled per-minute jobs,
// so the due queue can stay full for hours. A quiet tenant's job must get one
// of the next free slots, and must not wait behind that whole backlog.
//
// These tests run the production listDueJobs and claimJob SQL, and the
// production SchedulerWorker, against real Postgres. Only the runtime is a
// fake: no model or sandbox runs.

import { randomUUID } from "node:crypto";
import { EventType, type BaseEvent } from "@ag-ui/client";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AuditEventStore } from "../services/audit-event-store.js";
import { MessageStore } from "../services/message-store.js";
import {
  SchedulerWorker,
  type SchedulerRuntimeAdapter,
  type SchedulerWorkerDeps
} from "../services/scheduler-worker.js";
import { SessionStore } from "../services/session-store.js";
import { type ScheduledJobRecord, UserSettingsStore } from "../services/user-settings-store.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { adminDatabaseUrl, appPool, maintenancePool, runMaintenanceUrl, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

const MINUTE = 60_000;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE);
// The next run that a test claim stores. An hour ahead, so a job that ran is
// not due again while the test runs.
const nextHour = () => new Date(Date.now() + 60 * MINUTE).toISOString();

// listDueJobs reads the due jobs of all tenants, and the suite database holds
// due jobs of other test files. Each test moves those out of the due window
// and puts them back after. This file's own jobs are turned off after each
// test.
let parkedJobIds: string[] = [];
let testTenantIds: string[] = [];

beforeEach(async () => {
  if (!adminDatabaseUrl()) return;
  const parked = await superuserPool().query<{ job_id: string }>(
    `UPDATE scheduled_jobs SET next_run_at = next_run_at + INTERVAL '1000000 hours'
     WHERE enabled AND next_run_at <= NOW()
     RETURNING job_id`
  );
  parkedJobIds = parked.rows.map((row) => row.job_id);
});

afterEach(async () => {
  if (!adminDatabaseUrl()) return;
  await superuserPool().query(
    "UPDATE scheduled_jobs SET enabled = FALSE, next_run_at = NULL WHERE tenant_id = ANY($1)",
    [testTenantIds]
  );
  await superuserPool().query(
    "UPDATE scheduled_jobs SET next_run_at = next_run_at - INTERVAL '1000000 hours' WHERE job_id = ANY($1)",
    [parkedJobIds]
  );
  testTenantIds = [];
  parkedJobIds = [];
});

async function tenant(): Promise<string> {
  const tenantId = await seedTenant();
  testTenantIds.push(tenantId);
  return tenantId;
}

async function member(tenantId: string): Promise<string> {
  const userId = await seedUser();
  await seedMembership(tenantId, userId);
  return userId;
}

/** A local account of a tenant that signs in locally, at `securityVersion`. */
async function localMember(securityVersion: number): Promise<{ tenantId: string; userId: string }> {
  const tenantId = `tenant_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await superuserPool().query(
    "INSERT INTO tenants (tenant_id, tenant_name, slug, login_type) VALUES ($1, $1, $1, 'local')",
    [tenantId]
  );
  testTenantIds.push(tenantId);
  await superuserPool().query(
    "INSERT INTO users (user_id, email, auth_source) VALUES ($1, $2, 'local')",
    [userId, `${userId}@example.test`]
  );
  await superuserPool().query(
    "INSERT INTO local_identities (tenant_id, user_id, status, security_version) VALUES ($1, $2, 'active', $3)",
    [tenantId, userId, securityVersion]
  );
  await superuserPool().query(
    "INSERT INTO tenant_memberships (tenant_id, user_id, role, user_auth_source) VALUES ($1, $2, 'member', 'local')",
    [tenantId, userId]
  );
  return { tenantId, userId };
}

async function seedJob(input: {
  tenantId: string;
  userId: string;
  nextRunAt: Date;
  lastRunAt: Date | null;
  ownerSecurityVersion?: number | null;
}): Promise<string> {
  const jobId = `job_${randomUUID()}`;
  await superuserPool().query(
    `INSERT INTO scheduled_jobs
       (job_id, tenant_id, user_id, job_name, cron_expression, time_zone, input_json,
        enabled, next_run_at, last_run_at, owner_security_version)
     VALUES ($1, $2, $3, 'fairness job', '* * * * *', 'UTC', '{"prompt":"Check the queue."}',
             TRUE, $4, $5, $6)`,
    [jobId, input.tenantId, input.userId, input.nextRunAt, input.lastRunAt, input.ownerSecurityVersion ?? null]
  );
  return jobId;
}

/**
 * A member's per-minute jobs after the worker fell behind. Each job became due
 * one minute after the claim that last ran it. The claims came every 2.5
 * minutes, the latest `latestClaimMinutesAgo` minutes ago. Oldest due first.
 */
async function seedBacklog(
  tenantId: string,
  userId: string,
  count: number,
  latestClaimMinutesAgo: number
): Promise<string[]> {
  const jobIds: string[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const lastRunAt = minutesAgo(latestClaimMinutesAgo + 2.5 * index);
    jobIds.push(await seedJob({ tenantId, userId, lastRunAt, nextRunAt: new Date(lastRunAt.getTime() + MINUTE) }));
  }
  return jobIds;
}

/** A daily job that ran yesterday and became due a minute ago. */
function seedQuietJob(tenantId: string, userId: string): Promise<string> {
  return seedJob({ tenantId, userId, lastRunAt: minutesAgo(24 * 60), nextRunAt: minutesAgo(1) });
}

function store(schedulerDb: pg.Pool = maintenancePool()): UserSettingsStore {
  return new UserSettingsStore(appPool(), schedulerDb);
}

/** One worker tick on the store alone: list the due jobs for `slots` free slots and claim them. */
async function claimTick(settings: UserSettingsStore, slots = 1): Promise<ScheduledJobRecord[]> {
  const claimed: ScheduledJobRecord[] = [];
  for (const job of await settings.listDueJobs(slots)) {
    const won = await settings.claimJob(job.tenantId, job.jobId, nextHour());
    if (won) claimed.push(won);
  }
  return claimed;
}

/** The owner of each claim, over `ticks` ticks with one free slot each. */
async function claimOwners(ticks: number): Promise<string[]> {
  const owners: string[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    for (const job of await claimTick(store())) owners.push(job.userId);
  }
  return owners;
}

type JobState = { job_id: string; enabled: boolean; next_run_at: Date | null; last_run_at: Date | null; paused_reason: string | null };

async function jobStates(tenantIds: string[]): Promise<JobState[]> {
  const result = await superuserPool().query<JobState>(
    `SELECT job_id, enabled, next_run_at, last_run_at, paused_reason
     FROM scheduled_jobs WHERE tenant_id = ANY($1) ORDER BY job_id`,
    [tenantIds]
  );
  return result.rows;
}

async function runJobIds(tenantIds: string[]): Promise<string[]> {
  const result = await superuserPool().query<{ job_id: string }>(
    "SELECT job_id FROM scheduled_job_runs WHERE tenant_id = ANY($1) ORDER BY created_at, run_id",
    [tenantIds]
  );
  return result.rows.map((row) => row.job_id);
}

/**
 * A worker on the production stores. `hold` runs inside each turn, so a test
 * can keep a run going and its slot taken.
 */
function worker(options: { maxConcurrentJobs: number; schedulerDb?: pg.Pool; hold?: () => Promise<void> }) {
  const settings = store(options.schedulerDb);
  const runtime: SchedulerRuntimeAdapter = {
    id: "deep-agents",
    createSession: async (input) => ({
      sessionId: input.sessionId,
      runtimeId: `rt-${input.sessionId}`,
      runtimePolicy: {
        id: "default-profile", label: "Default", description: null, webSearchMode: "disabled",
        approvalPolicy: "never", approvalReviewer: "user", sandboxMode: "workspace-write",
        sandboxEgressDomains: [], allowCommandExecution: true, autoApproveReadOnlyTools: false,
        policyEnforcementMode: "monitor", developerInstructions: null, enabledToolIds: [],
        enabledMcpServers: [], version: 1, hash: "abc123"
      }
    }),
    runMessageAGUI: (session) => (async function* (): AsyncGenerator<BaseEvent> {
      yield { type: EventType.RUN_STARTED, threadId: session.sessionId, runId: "run" } as BaseEvent;
      await options.hold?.();
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Queue checked." } as BaseEvent;
      yield { type: EventType.RUN_FINISHED, threadId: session.sessionId, runId: "run" } as BaseEvent;
    })(),
    abortSession: async () => {},
    purgeSessionData: async () => {},
    destroySandbox: async () => "killed"
  };
  const deps: SchedulerWorkerDeps = {
    settings: {
      listDueJobs: settings.listDueJobs.bind(settings),
      claimJob: settings.claimJob.bind(settings),
      createJobRun: settings.createJobRun.bind(settings),
      completeJobRun: settings.completeJobRun.bind(settings),
      recordJobRunOutcome: settings.recordJobRunOutcome.bind(settings),
      // The suite database holds pending runs of other test files.
      sweepStaleJobRuns: async () => [],
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
    auditEvents: new AuditEventStore(appPool()),
    logger: createSilentLogger()
  };
  return new SchedulerWorker(deps, { maxConcurrentJobs: options.maxConcurrentJobs, jobTimeoutMs: 60_000 });
}

/** A pool with one connection, so two of them are two database sessions, as two replicas are. */
function replicaPool(name: string): pg.Pool {
  return new pg.Pool({
    connectionString: runMaintenanceUrl(),
    max: 1,
    statement_timeout: 10_000,
    application_name: `cogniplane-integration-${name}`
  });
}

describe.skipIf(!adminDatabaseUrl())("scheduler fairness across tenants and members", () => {
  test("a quiet tenant's due job takes the next free slot ahead of another tenant's older backlog", async () => {
    const busyTenant = await tenant();
    const busyMember = await member(busyTenant);
    await seedBacklog(busyTenant, busyMember, 50, 3);
    const quietTenant = await tenant();
    const quietMember = await member(quietTenant);
    await seedQuietJob(quietTenant, quietMember);

    // One free slot per tick, as when the busy member's long runs hold the
    // others. All 50 backlog jobs became due before the quiet job.
    const owners = await claimOwners(51);
    expect(owners.indexOf(quietMember)).toBe(0);
    expect(owners).toHaveLength(51);
  });

  test("with one free slot per tick, two busy tenants alternate, also when one backlog is older", async () => {
    const olderTenant = await tenant();
    const olderMember = await member(olderTenant);
    await seedBacklog(olderTenant, olderMember, 10, 3);
    // New jobs that never ran, due after every job of the older backlog.
    const newerTenant = await tenant();
    const newerMember = await member(newerTenant);
    for (let index = 0; index < 10; index += 1) {
      await seedJob({ tenantId: newerTenant, userId: newerMember, lastRunAt: null, nextRunAt: minutesAgo(1) });
    }

    const owners = await claimOwners(8);
    // A tenant whose jobs never ran goes first. After that, each claim moves
    // its tenant behind the other one.
    expect(owners).toEqual([
      newerMember, olderMember, newerMember, olderMember,
      newerMember, olderMember, newerMember, olderMember
    ]);
  });

  test("members of one tenant take turns, and the tenant takes turns with other tenants", async () => {
    // Tenant A: a busy member with an old backlog and a member whose two jobs
    // became due later but who has not had a run for a day.
    const tenantA = await tenant();
    const busyA = await member(tenantA);
    await seedBacklog(tenantA, busyA, 10, 3);
    const quietA = await member(tenantA);
    await seedQuietJob(tenantA, quietA);
    await seedQuietJob(tenantA, quietA);
    // Tenant B had a run more recently than tenant A.
    const tenantB = await tenant();
    const busyB = await member(tenantB);
    await seedBacklog(tenantB, busyB, 10, 2);

    expect(await claimOwners(6)).toEqual([quietA, busyB, busyA, busyB, quietA, busyB]);
  });

  test("one listing gives each tenant, then each member, a job before anyone gets a second", async () => {
    const tenantA = await tenant();
    const busyA = await member(tenantA);
    await seedBacklog(tenantA, busyA, 10, 3);
    const quietA = await member(tenantA);
    await seedQuietJob(tenantA, quietA);
    const tenantB = await tenant();
    const quietB = await member(tenantB);
    await seedQuietJob(tenantB, quietB);

    const two = await store().listDueJobs(2);
    expect(two.map((job) => job.tenantId).sort()).toEqual([tenantA, tenantB].sort());
    const three = await store().listDueJobs(3);
    expect(three.map((job) => job.userId).sort()).toEqual([busyA, quietA, quietB].sort());
  });

  test("a member's own jobs keep their order: oldest due first", async () => {
    const tenantId = await tenant();
    const userId = await member(tenantId);
    const backlog = await seedBacklog(tenantId, userId, 5, 3);

    const claimed: string[] = [];
    for (let tick = 0; tick < 5; tick += 1) {
      for (const job of await claimTick(store())) claimed.push(job.jobId);
    }
    expect(claimed).toEqual(backlog);
  });

  test("replicas that race for the same job claim it once and leave every other job as it was", async () => {
    const busyTenant = await tenant();
    const busyMember = await member(busyTenant);
    await seedBacklog(busyTenant, busyMember, 10, 3);
    const quietTenant = await tenant();
    const quietMember = await member(quietTenant);
    const quietJob = await seedQuietJob(quietTenant, quietMember);
    const before = await jobStates([busyTenant, quietTenant]);

    const poolA = replicaPool("fairness-replica-a");
    const poolB = replicaPool("fairness-replica-b");
    try {
      const replicaA = store(poolA);
      const replicaB = store(poolB);
      // Both replicas read the queue before either claims.
      const [listA, listB] = await Promise.all([replicaA.listDueJobs(1), replicaB.listDueJobs(1)]);
      expect(listA.map((job) => job.jobId)).toEqual([quietJob]);
      expect(listB.map((job) => job.jobId)).toEqual([quietJob]);

      const nextRunAt = nextHour();
      const claims = await Promise.all([
        replicaA.claimJob(quietTenant, quietJob, nextRunAt),
        replicaB.claimJob(quietTenant, quietJob, nextRunAt)
      ]);
      expect(claims.filter((claim) => claim !== null).map((claim) => claim?.jobId)).toEqual([quietJob]);

      // Only the claimed job changed.
      const after = await jobStates([busyTenant, quietTenant]);
      expect(after.filter((job) => job.job_id !== quietJob)).toEqual(before.filter((job) => job.job_id !== quietJob));
      const claimedRow = after.find((job) => job.job_id === quietJob);
      expect(claimedRow?.next_run_at?.toISOString()).toBe(nextRunAt);
      expect(claimedRow?.last_run_at?.getTime()).toBeGreaterThan(Date.now() - MINUTE);

      // The next tick of either replica goes on with the busy tenant.
      const [nextA, nextB] = await Promise.all([claimTick(replicaA), claimTick(replicaB)]);
      const nextJobs = [...nextA, ...nextB];
      expect(nextJobs.length).toBeGreaterThanOrEqual(1);
      expect(nextJobs.every((job) => job.userId === busyMember)).toBe(true);
      expect(new Set(nextJobs.map((job) => job.jobId)).size).toBe(nextJobs.length);
    } finally {
      await Promise.all([poolA.end(), poolB.end()]);
    }
  });

  test("a due job whose owner left the tenant gets no turn and stays as it was", async () => {
    const busyTenant = await tenant();
    const busyMember = await member(busyTenant);
    await seedBacklog(busyTenant, busyMember, 3, 3);
    // Never ran, so it would be first if its owner were still a member.
    const formerInBusy = await member(busyTenant);
    const formerJobA = await seedJob({ tenantId: busyTenant, userId: formerInBusy, lastRunAt: null, nextRunAt: minutesAgo(90) });
    const leftTenant = await tenant();
    const formerMember = await member(leftTenant);
    const formerJobB = await seedQuietJob(leftTenant, formerMember);
    await superuserPool().query(
      "DELETE FROM tenant_memberships WHERE (tenant_id, user_id) IN (($1, $2), ($3, $4))",
      [busyTenant, formerInBusy, leftTenant, formerMember]
    );
    const before = await jobStates([busyTenant, leftTenant]);

    const listed = await store().listDueJobs(10);
    expect(listed.map((job) => job.userId)).toEqual([busyMember, busyMember, busyMember]);
    expect(await claimOwners(1)).toEqual([busyMember]);

    const after = await jobStates([busyTenant, leftTenant]);
    for (const jobId of [formerJobA, formerJobB]) {
      expect(after.find((job) => job.job_id === jobId)).toEqual(before.find((job) => job.job_id === jobId));
    }
  });
});

describe.skipIf(!adminDatabaseUrl())("scheduler worker fairness", () => {
  test("a quiet tenant's job takes the slot that a long run frees, ahead of the older backlog", async () => {
    const busyTenant = await tenant();
    const busyMember = await member(busyTenant);
    const backlog = await seedBacklog(busyTenant, busyMember, 10, 3);
    const quietTenant = await tenant();
    const quietMember = await member(quietTenant);
    const quietJob = await seedJob({ tenantId: quietTenant, userId: quietMember, lastRunAt: minutesAgo(24 * 60), nextRunAt: new Date(Date.now() + MINUTE) });

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = worker({ maxConcurrentJobs: 1, hold: () => held });

    // Only the busy tenant has due jobs. Its oldest one takes the only slot
    // and keeps it.
    const firstTick = scheduler.tick();
    await expect.poll(() => runJobIds([busyTenant, quietTenant]), { timeout: 5_000 }).toEqual([backlog[0]]);

    // The quiet job becomes due during that run. No slot is free, so a tick
    // claims nothing and changes no job.
    await superuserPool().query("UPDATE scheduled_jobs SET next_run_at = $2 WHERE job_id = $1", [quietJob, minutesAgo(0.1)]);
    const before = await jobStates([busyTenant, quietTenant]);
    await scheduler.tick();
    expect(await jobStates([busyTenant, quietTenant])).toEqual(before);

    release();
    await firstTick;
    await scheduler.tick();
    expect(await runJobIds([busyTenant, quietTenant])).toEqual([backlog[0], quietJob]);
    await scheduler.tick();
    expect(await runJobIds([busyTenant, quietTenant])).toEqual([backlog[0], quietJob, backlog[1]]);
  });

  test("two workers with one slot each run the quiet tenant's job once", async () => {
    const busyTenant = await tenant();
    const busyMember = await member(busyTenant);
    const backlog = await seedBacklog(busyTenant, busyMember, 10, 3);
    const quietTenant = await tenant();
    const quietMember = await member(quietTenant);
    const quietJob = await seedQuietJob(quietTenant, quietMember);

    const poolA = replicaPool("fairness-worker-a");
    const poolB = replicaPool("fairness-worker-b");
    try {
      const replicaA = worker({ maxConcurrentJobs: 1, schedulerDb: poolA });
      const replicaB = worker({ maxConcurrentJobs: 1, schedulerDb: poolB });
      await Promise.all([replicaA.tick(), replicaB.tick()]);
      await Promise.all([replicaA.tick(), replicaB.tick()]);

      const ran = await runJobIds([busyTenant, quietTenant]);
      expect(ran.filter((jobId) => jobId === quietJob)).toHaveLength(1);
      expect(new Set(ran).size).toBe(ran.length);
      expect(ran.length).toBeGreaterThanOrEqual(2);
      expect(ran.filter((jobId) => jobId !== quietJob).every((jobId) => backlog.includes(jobId))).toBe(true);
    } finally {
      await Promise.all([poolA.end(), poolB.end()]);
    }
  });

  test("a first job refused for a security change of its owner is paused and frees the turn", async () => {
    const busyTenant = await tenant();
    const busyMember = await member(busyTenant);
    const backlog = await seedBacklog(busyTenant, busyMember, 3, 3);
    // Saved at version 1. The owner's account is now at version 2.
    const changed = await localMember(2);
    const changedJob = await seedJob({
      tenantId: changed.tenantId, userId: changed.userId,
      lastRunAt: minutesAgo(24 * 60), nextRunAt: minutesAgo(1), ownerSecurityVersion: 1
    });
    const scheduler = worker({ maxConcurrentJobs: 1 });
    const busyBefore = await jobStates([busyTenant]);

    // The changed owner's job is first in the queue. The claim refuses it, the
    // worker pauses it, and no other job changes.
    expect((await store().listDueJobs(1)).map((job) => job.jobId)).toEqual([changedJob]);
    await scheduler.tick();
    expect(await runJobIds([busyTenant, changed.tenantId])).toEqual([]);
    expect(await jobStates([busyTenant])).toEqual(busyBefore);
    expect((await jobStates([changed.tenantId]))[0]).toMatchObject({
      enabled: false, next_run_at: null, paused_reason: "security_change"
    });

    await scheduler.tick();
    expect(await runJobIds([busyTenant, changed.tenantId])).toEqual([backlog[0]]);
  });
});
