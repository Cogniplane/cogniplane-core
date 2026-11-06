// A scheduled job runs as its owner, with the owner's tools and credentials.
// A job that a stolen access token saved must stop when the owner changes the
// password or signs out everywhere (bead q4w0.9).
// The job keeps the security version of the session that saved it (migration
// 080). The claim refuses a job whose owner's version changed, the worker
// pauses it with a stored reason and an audit event, and the worker checks
// again before the turn starts, so a run that was already claimed is refused
// too. The owner's edit from a current session stores the new version.
//
// These tests run the production store SQL, LocalAccountService and
// SchedulerWorker against real Postgres. Only the runtime and the tool
// context are fakes: no model or sandbox runs.

import { randomUUID } from "node:crypto";
import { EventType, type BaseEvent } from "@ag-ui/client";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";

import { PasswordHasher } from "../lib/password-hash.js";
import { registerTenantRoutes } from "../routes/tenant.js";
import { bootstrapLocalTenant } from "../scripts/local-auth-commands-lib.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { LocalAccountService, type RequestMeta } from "../services/auth/local-account-service.js";
import { type AfterSecurityChange, stopActiveWork } from "../services/auth/security-change.js";
import { interruptedResult } from "../services/deep-agents/agui-events.js";
import type { TurnStopReason } from "@cogniplane/shared-types";
import { MessageStore } from "../services/message-store.js";
import {
  OWNER_SECURITY_CHANGED_RUN_ERROR,
  SchedulerWorker,
  type SchedulerRuntimeAdapter,
  type SchedulerWorkerDeps
} from "../services/scheduler-worker.js";
import { SessionStore } from "../services/session-store.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { UserSettingsStore } from "../services/user-settings-store.js";
import type { RuntimeSessionRef } from "../runtime-contracts.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedMembership, seedScheduledJobRun, seedTenant, seedUser } from "./support/fixtures.js";
import { withStagedDatabase } from "./support/staged-migrations.js";
import { IGNORE_SECURITY_CHANGE } from "../test-helpers/security-change.js";
import { devDataRoutes } from "../test-helpers/data-routes.js";

const META: RequestMeta = { ipAddress: "203.0.113.9", userAgent: "integration" };
const ORIGIN = "https://app.test";
const PASSWORD = "purple elephants dance quietly";
const PAST = () => new Date(Date.now() - 60_000).toISOString();

function accounts(afterSecurityChange: AfterSecurityChange = IGNORE_SECURITY_CHANGE) {
  return new LocalAccountService({ afterSecurityChange, db: appPool(), lookupDb: maintenancePool(), hasher: new PasswordHasher(4), frontendOrigin: ORIGIN });
}

function store() {
  return new UserSettingsStore(appPool(), maintenancePool());
}

/** An active local owner, signed in at security version 1. */
async function activeLocalOwner(): Promise<{ tenantId: string; userId: string; securityVersion: number }> {
  const boot = await bootstrapLocalTenant(superuserPool(), ORIGIN, {
    tenantName: "Scheduled jobs", ownerEmail: `${randomUUID()}@example.test`, ownerName: "Owner"
  });
  const session = await accounts().redeemLink("account_setup", boot.link.url.split("#token=")[1]!, PASSWORD, META);
  expect(session.securityVersion).toBe(1);
  return { tenantId: boot.tenantId, userId: boot.userId, securityVersion: session.securityVersion };
}

function jobFields(owner: { tenantId: string; userId: string }, jobId: string, ownerSecurityVersion: number | null) {
  return {
    tenantId: owner.tenantId,
    jobId,
    userId: owner.userId,
    jobName: "Mailbox digest",
    description: null,
    cronExpression: "* * * * *",
    timeZone: "UTC",
    targetType: "prompt" as const,
    targetRef: null,
    input: { prompt: "Summarize my mailbox." },
    settingsSnapshot: {},
    enabled: true,
    // Due now, so the next tick claims it.
    nextRunAt: PAST(),
    ownerSecurityVersion
  };
}

/** A due job, saved as the route saves it, from a session at `version`. */
async function saveDueJob(owner: { tenantId: string; userId: string }, version: number | null): Promise<string> {
  const jobId = randomUUID();
  const created = await store().createScheduledJob(jobFields(owner, jobId, version), { maxActive: 0 });
  expect(created.status).toBe("created");
  return jobId;
}

async function jobRow(jobId: string) {
  return (await superuserPool().query(
    "SELECT enabled, paused_reason, next_run_at, owner_security_version FROM scheduled_jobs WHERE job_id = $1", [jobId]
  )).rows[0] as { enabled: boolean; paused_reason: string | null; next_run_at: Date | null; owner_security_version: number | null } | undefined;
}

async function runRows(jobId: string) {
  return (await superuserPool().query(
    "SELECT status, error_message FROM scheduled_job_runs WHERE job_id = $1 ORDER BY created_at", [jobId]
  )).rows as Array<{ status: string; error_message: string | null }>;
}

async function securityPauseAudits(tenantId: string) {
  return (await superuserPool().query(
    `SELECT user_id, payload FROM audit_events
     WHERE tenant_id = $1 AND event_type = 'scheduler.job.disabled' ORDER BY id`, [tenantId]
  )).rows as Array<{ user_id: string; payload: Record<string, unknown> }>;
}

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
 * A worker on the production stores, limited to one tenant's due jobs: the
 * suite database holds due jobs of other test files too. `beforeTurn` runs
 * after the claim, while the run prepares, where a real security change can
 * land.
 */
function scopedWorker(tenantId: string, options: {
  beforeTurn?: () => Promise<void>;
  /** Replaces the turn's events: for a turn that runs until something stops it. */
  stream?: (session: RuntimeSessionRef) => AsyncGenerator<BaseEvent>;
} = {}) {
  const settings = store();
  const runtimeSessions: string[] = [];
  const turns: string[] = [];
  const contextVersions: Array<number | null> = [];
  const runtime: SchedulerRuntimeAdapter = {
    id: "deep-agents",
    createSession: async (input) => {
      runtimeSessions.push(input.sessionId);
      return sessionRef(input.sessionId);
    },
    runMessageAGUI: (session) => {
      turns.push(session.sessionId);
      if (options.stream) return options.stream(session);
      return (async function* (): AsyncGenerator<BaseEvent> {
        yield { type: EventType.RUN_STARTED, threadId: session.sessionId, runId: "run" } as BaseEvent;
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Digest ready." } as BaseEvent;
        yield { type: EventType.RUN_FINISHED, threadId: session.sessionId, runId: "run" } as BaseEvent;
      })();
    },
    abortSession: async () => {},
    purgeSessionData: async () => {}
  };
  const deps: SchedulerWorkerDeps = {
    settings: {
      listDueJobs: async () => (await settings.listDueJobs(10_000)).filter((job) => job.tenantId === tenantId),
      claimJob: settings.claimJob.bind(settings),
      createJobRun: settings.createJobRun.bind(settings),
      completeJobRun: settings.completeJobRun.bind(settings),
      recordJobRunOutcome: settings.recordJobRunOutcome.bind(settings),
      sweepStaleJobRuns: async () => [],
      pauseJobForSecurityChange: settings.pauseJobForSecurityChange.bind(settings),
      getOwnerSecurityVersion: settings.getOwnerSecurityVersion.bind(settings)
    },
    sessions: new SessionStore(appPool()),
    messages: new MessageStore(appPool()),
    toolContexts: {
      create: async (input) => {
        contextVersions.push(input.ownerSecurityVersion);
        return {
        toolContextId: randomUUID(), tenantId: input.tenantId, sessionId: input.sessionId, userId: input.userId,
        runtimeId: input.runtimeId, runtimePolicyId: input.runtimePolicyId, messageId: input.messageId,
        credentialEnvelope: {}, metadata: input.metadata ?? {},
        expiresAt: new Date(Date.now() + input.ttlMs).toISOString(), createdAt: new Date().toISOString()
        };
      }
    },
    runtimeAdapter: runtime,
    resolveRuntime: async () => {
      await options.beforeTurn?.();
      return { kind: "ok", adapter: runtime, modelId: null };
    },
    auditEvents: new AuditEventStore(appPool()),
    logger: createSilentLogger()
  };
  const worker = new SchedulerWorker(deps, { maxConcurrentJobs: 5, jobTimeoutMs: 60_000, maxConsecutiveFailures: 1 });
  return { tick: () => worker.tick(), runtimeSessions, turns, contextVersions };
}

const SECURITY_CHANGES = {
  "a password change": (owner: { tenantId: string; userId: string; securityVersion: number }) =>
    accounts().changeOwnPassword(owner.tenantId, owner.userId, PASSWORD, "a different long passphrase", owner.securityVersion, META),
  "sign out everywhere": (owner: { tenantId: string; userId: string }) =>
    accounts().revokeSessions(owner.tenantId, owner.userId, owner.userId, META)
};

describe.skipIf(!adminDatabaseUrl())("scheduled jobs after a security change of the owner", () => {
  test.each(Object.keys(SECURITY_CHANGES) as Array<keyof typeof SECURITY_CHANGES>)(
    "after %s, the job does not start and is paused with its reason and an audit event",
    async (change) => {
      const owner = await activeLocalOwner();
      const jobId = await saveDueJob(owner, owner.securityVersion);
      await seedScheduledJobRun({ tenantId: owner.tenantId, userId: owner.userId, jobId, ageMs: 0 });
      await superuserPool().query("UPDATE scheduled_job_runs SET status = 'completed' WHERE job_id = $1", [jobId]);

      await SECURITY_CHANGES[change](owner);
      const worker = scopedWorker(owner.tenantId);
      await worker.tick();

      // The claim refused the job: no run row, no runtime, no turn.
      expect(worker.runtimeSessions).toEqual([]);
      expect(worker.turns).toEqual([]);
      expect(await runRows(jobId)).toEqual([{ status: "completed", error_message: null }]);
      // Paused, not deleted. The saved version stays for the record.
      expect(await jobRow(jobId)).toEqual({
        enabled: false, paused_reason: "security_change", next_run_at: null, owner_security_version: 1
      });
      expect(await securityPauseAudits(owner.tenantId)).toEqual([{
        user_id: owner.userId, payload: { jobId, reason: "security_change", disabled: true }
      }]);

      // The next tick finds nothing due and writes nothing more.
      await worker.tick();
      expect(await securityPauseAudits(owner.tenantId)).toHaveLength(1);
    }
  );

  test("the owner's edit from a current session stores the new version, and the job runs again", async () => {
    const owner = await activeLocalOwner();
    const jobId = await saveDueJob(owner, owner.securityVersion);
    await SECURITY_CHANGES["sign out everywhere"](owner);
    const worker = scopedWorker(owner.tenantId);
    await worker.tick();
    expect((await jobRow(jobId))?.paused_reason).toBe("security_change");

    // The route stores the version of the session that sends the edit. The
    // owner's new session carries version 2.
    const resumed = await store().updateScheduledJob(jobFields(owner, jobId, 2), { maxActive: 0 });
    expect(resumed).toMatchObject({ status: "updated", job: { enabled: true, pausedReason: null } });
    expect(await jobRow(jobId)).toMatchObject({ enabled: true, paused_reason: null, owner_security_version: 2 });

    await worker.tick();
    expect(worker.turns).toHaveLength(1);
    expect(await runRows(jobId)).toEqual([{ status: "completed", error_message: null }]);
  });

  test("a run claimed before the security change is refused before its turn starts", async () => {
    const owner = await activeLocalOwner();
    const jobId = await saveDueJob(owner, owner.securityVersion);
    // The change lands after the claim, while the run prepares.
    const worker = scopedWorker(owner.tenantId, { beforeTurn: async () => { await SECURITY_CHANGES["sign out everywhere"](owner); } });

    await worker.tick();

    expect(worker.runtimeSessions).toEqual([]);
    expect(worker.turns).toEqual([]);
    expect(await runRows(jobId)).toEqual([{ status: "failed", error_message: OWNER_SECURITY_CHANGED_RUN_ERROR }]);
    expect(await jobRow(jobId)).toMatchObject({ enabled: false, paused_reason: "security_change" });
    expect(await securityPauseAudits(owner.tenantId)).toEqual([{
      user_id: owner.userId, payload: { jobId, reason: "security_change", disabled: true }
    }]);
    // The refused run does not count toward auto-disable (the limit here is 1).
    expect((await superuserPool().query(
      "SELECT consecutive_failures FROM scheduled_jobs WHERE job_id = $1", [jobId])).rows[0]).toEqual({ consecutive_failures: 0 });
  });

  // Bead q4w0.13: a turn that already runs stops at the change. The production
  // adapter's invalidateRuntimesForUser aborts the turn, and its stream ends
  // with an interrupted RUN_FINISHED (deep-agents-runtime-adapter.test.ts);
  // this runtime does the same. The gateway refuses the turn's tool calls on
  // every replica (mcp-gateway-security-version.integration.test.ts).
  test("a scheduled turn in progress stops when the owner signs out everywhere", async () => {
    const owner = await activeLocalOwner();
    const jobId = await saveDueJob(owner, owner.securityVersion);
    let started!: () => void;
    const turnStarted = new Promise<void>((resolve) => { started = resolve; });
    const aborts = new Map<string, (reason?: TurnStopReason) => void>();
    const stopped: string[] = [];
    const runtimes = {
      invalidateRuntimesForUser: async (tenantId: string, userId: string, options?: { reason?: TurnStopReason }) => {
        const sessionIds = [...aborts.keys()];
        for (const sessionId of sessionIds) aborts.get(sessionId)!(options?.reason);
        stopped.push(`${tenantId}/${userId}`);
        return sessionIds;
      }
    };
    const worker = scopedWorker(owner.tenantId, {
      stream: (session) => (async function* (): AsyncGenerator<BaseEvent> {
        yield { type: EventType.RUN_STARTED, threadId: session.sessionId, runId: "run" } as BaseEvent;
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "Reading the mailbox" } as BaseEvent;
        const reason = await new Promise<TurnStopReason | undefined>((resolve) => {
          aborts.set(session.sessionId, resolve);
          started();
        });
        yield { type: EventType.RUN_FINISHED, threadId: session.sessionId, runId: "run", result: interruptedResult(reason) } as BaseEvent;
      })()
    });

    const ticking = worker.tick();
    await turnStarted;
    // The turn's tool context keeps the version that admitted it.
    expect(worker.contextVersions).toEqual([owner.securityVersion]);

    await accounts(stopActiveWork({ runtimes, logger: createSilentLogger() }))
      .revokeSessions(owner.tenantId, owner.userId, owner.userId, META);
    await ticking;

    expect(stopped).toEqual([`${owner.tenantId}/${owner.userId}`]);
    expect(await runRows(jobId)).toEqual([{
      status: "failed", error_message: "Scheduled job stopped because your account's security settings changed."
    }]);
    // The run's assistant row keeps the reason; the chat shows it as a notice.
    const turnSessionId = worker.runtimeSessions[0]!;
    const history = await new MessageStore(appPool()).listBySession(owner.tenantId, turnSessionId, owner.userId, { limit: null });
    expect(history.messages.find((message) => message.role === "assistant"))
      .toMatchObject({ status: "interrupted", stopReason: "security_change" });
    // The next tick pauses the job for review instead of running it again.
    await superuserPool().query("UPDATE scheduled_jobs SET next_run_at = now() - interval '1 minute' WHERE job_id = $1", [jobId]);
    await worker.tick();
    expect(worker.turns).toHaveLength(1);
    expect(await jobRow(jobId)).toMatchObject({ enabled: false, paused_reason: "security_change" });
  });

  test("a WorkOS owner's job has no version and runs; a local owner's job with no version is paused", async () => {
    const tenantId = await seedTenant();
    const userId = await seedUser();
    await seedMembership(tenantId, userId);
    const workosJob = await saveDueJob({ tenantId, userId }, null);
    const workos = scopedWorker(tenantId);
    await workos.tick();
    expect(workos.turns).toHaveLength(1);
    expect(await runRows(workosJob)).toEqual([{ status: "completed", error_message: null }]);

    // A row without a version, for example from older code during a rolling
    // deploy, does not run for a local owner.
    const owner = await activeLocalOwner();
    const unversioned = await saveDueJob(owner, null);
    const local = scopedWorker(owner.tenantId);
    await local.tick();
    expect(local.turns).toEqual([]);
    expect(await jobRow(unversioned)).toMatchObject({ enabled: false, paused_reason: "security_change" });
  });

  test("a job that is on ignores a pause reason; the database refuses an unknown reason", async () => {
    // Older backend code (a rolling deploy or a rollback) turns a paused job
    // on without clearing the reason. That save must not fail, and the job
    // must not show as paused.
    const owner = await activeLocalOwner();
    const jobId = await saveDueJob(owner, owner.securityVersion);
    await superuserPool().query("UPDATE scheduled_jobs SET paused_reason = 'security_change' WHERE job_id = $1", [jobId]);
    const listed = await store().listScheduledJobs(owner.tenantId, owner.userId);
    expect(listed.find((job) => job.jobId === jobId)).toMatchObject({ enabled: true, pausedReason: null });

    await expect(superuserPool().query(
      "UPDATE scheduled_jobs SET enabled = FALSE, paused_reason = 'owner_choice' WHERE job_id = $1", [jobId]
    )).rejects.toMatchObject({ code: "23514" });
  });

  test("a manager's disable of a local member pauses the member's jobs for review", async () => {
    const owner = await activeLocalOwner();
    const created = await accounts().createMember({
      tenantId: owner.tenantId, email: `${randomUUID()}@example.test`, displayName: "Member", role: "member",
      actorUserId: owner.userId, meta: META
    });
    const member = await accounts().redeemLink("account_setup", created.link!.url.split("#token=")[1]!, PASSWORD, META);
    const onJob = await saveDueJob(member, member.securityVersion);
    const offJob = await saveDueJob(member, member.securityVersion);
    await superuserPool().query("UPDATE scheduled_jobs SET enabled = FALSE, next_run_at = NULL WHERE job_id = $1", [offJob]);

    await accounts().disableMember(owner.tenantId, member.userId, owner.userId, META);

    // Both need a review: the account was disabled, so someone else can
    // have saved either prompt.
    for (const jobId of [onJob, offJob]) {
      expect(await jobRow(jobId)).toMatchObject({ enabled: false, paused_reason: "security_change", next_run_at: null });
    }
    const listed = await store().listScheduledJobs(owner.tenantId, member.userId);
    expect(listed.map((job) => job.pausedReason)).toEqual(["security_change", "security_change"]);
  });

  test("removing a member pauses the member's jobs for review", async () => {
    const tenantId = await seedTenant();
    const ownerId = await seedUser();
    const memberId = await seedUser();
    await seedMembership(tenantId, ownerId, "owner");
    await seedMembership(tenantId, memberId, "member");
    const jobId = await saveDueJob({ tenantId, userId: memberId }, null);
    const app = Fastify();
    app.addHook("preHandler", async (request) => {
      request.auth = { userId: ownerId, tenantId, role: "owner", isAdmin: true };
    });
    await registerTenantRoutes(app, { dataRoutes: devDataRoutes(), afterSecurityChange: IGNORE_SECURITY_CHANGE,
      db: appPool(),
      tenantOrgSettings: new TenantOrgSettingsStore(appPool(), "scheduled-job-security-secret-32-chars")
    });
    await app.ready();
    try {
      const removed = await app.inject({ method: "DELETE", url: `/tenant/members/${memberId}` });
      expect(removed.statusCode).toBeLessThan(300);
    } finally {
      await app.close();
    }

    expect(await jobRow(jobId)).toMatchObject({ enabled: false, paused_reason: "security_change", next_run_at: null });
  });
});

describe.skipIf(!adminDatabaseUrl())("migration 080: scheduled job owner security version", () => {
  test("only jobs saved after the owner's last security change keep running", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => Number.parseInt(file, 10) <= 79);

      // A local owner whose last security change was one day ago.
      const boot = await bootstrapLocalTenant(db, ORIGIN, {
        tenantName: "Before 080", ownerEmail: `${randomUUID()}@example.test`, ownerName: "Owner"
      });
      await db.query(
        `UPDATE local_identities SET security_version = 3, updated_at = NOW() - INTERVAL '1 day'
         WHERE tenant_id = $1 AND user_id = $2`,
        [boot.tenantId, boot.userId]
      );
      // A WorkOS owner in another tenant.
      const workos = { tenantId: randomUUID(), userId: randomUUID() };
      await db.query("INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES ($1, 'WorkOS', $1)", [workos.tenantId]);
      await db.query("INSERT INTO users (user_id, email) VALUES ($1, $2)", [workos.userId, `${workos.userId}@example.test`]);
      await db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')",
        [workos.tenantId, workos.userId]);

      // `created` and `updated` are offsets from now, as SQL intervals.
      const insertJob = async (owner: { tenantId: string; userId: string }, created: string, updated: string) => {
        const jobId = randomUUID();
        await db.query(
          `INSERT INTO scheduled_jobs
             (job_id, tenant_id, user_id, job_name, cron_expression, time_zone, enabled, next_run_at, created_at, updated_at)
           VALUES ($1, $2, $3, 'old job', '* * * * *', 'UTC', TRUE, NOW() - INTERVAL '1 minute',
                   NOW() - $4::interval, NOW() - $5::interval)`,
          [jobId, owner.tenantId, owner.userId, created, updated]
        );
        return jobId;
      };
      const editEvent = async (jobId: string, age: string, by: { tenantId: string; userId: string } = boot) => {
        await db.query(
          `INSERT INTO audit_events (tenant_id, user_id, event_type, payload, created_at)
           VALUES ($1, $2, 'user.scheduled_job.updated', $3::jsonb, NOW() - $4::interval)`,
          [by.tenantId, by.userId, JSON.stringify({ jobId, enabled: true }), age]
        );
      };

      // Saved before the change, never edited.
      const savedBefore = await insertJob(boot, "2 days", "2 days");
      // Saved before the change, then claimed and run after it. A run sets
      // updated_at, which is not a save.
      const ranAfter = await insertJob(boot, "2 days", "1 minute");
      // Saved before the change, edited after it from a current session.
      const editedAfter = await insertJob(boot, "2 days", "2 days");
      await editEvent(editedAfter, "1 hour");
      // Saved and edited before the change.
      const editedBefore = await insertJob(boot, "3 days", "3 days");
      await editEvent(editedBefore, "2 days");
      // Created after the change.
      const createdAfter = await insertJob(boot, "1 hour", "1 hour");
      // Saved within the minute after the change: inside the safety margin.
      const createdInMargin = await insertJob(boot, "86370 seconds", "86370 seconds");
      // An edit event of another person or another tenant does not count.
      const otherUserEdit = await insertJob(boot, "2 days", "2 days");
      await editEvent(otherUserEdit, "1 hour", { tenantId: boot.tenantId, userId: workos.userId });
      const otherTenantEdit = await insertJob(boot, "2 days", "2 days");
      await editEvent(otherTenantEdit, "1 hour", { tenantId: workos.tenantId, userId: boot.userId });
      // Turned off before the migration (for example by a manager's disable).
      const offBefore = await insertJob(boot, "2 days", "2 days");
      await db.query("UPDATE scheduled_jobs SET enabled = FALSE, next_run_at = NULL WHERE job_id = $1", [offBefore]);
      // A WorkOS job that is off keeps no pause reason.
      const workosOff = await insertJob(workos, "2 days", "2 days");
      await db.query("UPDATE scheduled_jobs SET enabled = FALSE, next_run_at = NULL WHERE job_id = $1", [workosOff]);
      const workosJob = await insertJob(workos, "2 days", "2 days");

      await migrate((file) => Number.parseInt(file, 10) === 80);

      const versions = new Map((await db.query<{ job_id: string; owner_security_version: number | null }>(
        "SELECT job_id, owner_security_version FROM scheduled_jobs"
      )).rows.map((row) => [row.job_id, row.owner_security_version]));
      expect({
        savedBefore: versions.get(savedBefore), ranAfter: versions.get(ranAfter), editedAfter: versions.get(editedAfter),
        editedBefore: versions.get(editedBefore), createdAfter: versions.get(createdAfter), workos: versions.get(workosJob)
      }).toEqual({ savedBefore: null, ranAfter: null, editedAfter: 3, editedBefore: null, createdAfter: 3, workos: null });
      expect({
        createdInMargin: versions.get(createdInMargin),
        otherUserEdit: versions.get(otherUserEdit),
        otherTenantEdit: versions.get(otherTenantEdit)
      }).toEqual({ createdInMargin: null, otherUserEdit: null, otherTenantEdit: null });
      const reasons = new Map((await db.query<{ job_id: string; paused_reason: string | null }>(
        "SELECT job_id, paused_reason FROM scheduled_jobs"
      )).rows.map((row) => [row.job_id, row.paused_reason]));
      expect({ offBefore: reasons.get(offBefore), workosOff: reasons.get(workosOff), savedBefore: reasons.get(savedBefore) })
        .toEqual({ offBefore: "security_change", workosOff: null, savedBefore: null });

      // Jobs saved after the change and WorkOS jobs keep running. The others
      // are not claimed, so the worker pauses them for a review.
      const migrated = new UserSettingsStore(db, db);
      const claimable = async (owner: { tenantId: string }, jobId: string) =>
        (await migrated.claimJob(owner.tenantId, jobId, null)) !== null;
      expect({
        savedBefore: await claimable(boot, savedBefore), ranAfter: await claimable(boot, ranAfter),
        editedAfter: await claimable(boot, editedAfter), editedBefore: await claimable(boot, editedBefore),
        createdAfter: await claimable(boot, createdAfter), workos: await claimable(workos, workosJob)
      }).toEqual({ savedBefore: false, ranAfter: false, editedAfter: true, editedBefore: false, createdAfter: true, workos: true });

      // A failure disable clears a pause reason that a job left on (older
      // code during a rollback), so the job does not show a security pause.
      await db.query("UPDATE scheduled_jobs SET paused_reason = 'security_change' WHERE job_id = $1", [createdAfter]);
      await migrated.disableJob(boot.tenantId, createdAfter);
      const disabled = await db.query<{ enabled: boolean; paused_reason: string | null }>(
        "SELECT enabled, paused_reason FROM scheduled_jobs WHERE job_id = $1", [createdAfter]
      );
      expect(disabled.rows[0]).toEqual({ enabled: false, paused_reason: null });
    });
  });
});
