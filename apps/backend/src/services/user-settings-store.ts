import type { PoolClient } from "pg";

import { type Pool, withTenantScope, withTransaction } from "../lib/db.js";
import { isoTimestamp, isoTimestampOrNull } from "../lib/db-mappers.js";
import { computeNextCronRunAt } from "../lib/cron.js";
import { ownerSecurityVersionSql } from "./auth/security-change.js";
import { AuditEventStore, type AuditEventInput } from "./audit-event-store.js";

export const userSettingsSectionKeys = ["scheduled_jobs", "github", "skills", "mcp", "model"] as const;

export type UserSettingsSectionKey = (typeof userSettingsSectionKeys)[number];

export type UserSettingsSectionRecord = {
  userId: string;
  sectionKey: UserSettingsSectionKey;
  version: number;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledJobRunRecord = {
  runId: string;
  jobId: string;
  userId: string;
  sessionId: string | null;
  status: string;
  /** The slot of the run: the `next_run_at` that its claim took. Null on runs written before slots. */
  scheduledFor: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  errorMessage: string | null;
  summary: string | null;
  createdAt: string;
};

/** Identifying fields of a pending run recovered by `sweepStaleJobRuns`. */
export type OrphanedJobRunRecord = {
  tenantId: string;
  runId: string;
  jobId: string;
  userId: string;
  sessionId: string | null;
};

export type ScheduledJobRecord = {
  tenantId: string;
  jobId: string;
  userId: string;
  jobName: string;
  description: string | null;
  scheduleKind: "cron";
  cronExpression: string;
  timeZone: string;
  targetType: "prompt" | "skill";
  targetRef: string | null;
  input: Record<string, unknown>;
  settingsSnapshot: Record<string, unknown>;
  enabled: boolean;
  /** Why the job is paused. Null when the job is on, or off by the owner's choice. */
  pausedReason: ScheduledJobPausedReason | null;
  consecutiveFailures: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledJobPausedReason = "security_change";

/**
 * A due job as the scheduler lists it. `revision` counts the owner's saves; a
 * write of the scheduler that must not apply to a newer save of the job
 * requires it. It stays out of `ScheduledJobRecord`, so API responses do not
 * carry it.
 */
export type DueScheduledJob = ScheduledJobRecord & { revision: number };

/**
 * A job as the scheduler claimed it. `ownerSecurityVersion` is the security
 * version of the owner's local account from the session that last saved the
 * job; null for a WorkOS owner. `runId` is the pending run that the claim
 * wrote, and `scheduledFor` its slot. `revision` is the revision that the
 * claim read.
 */
export type ClaimedScheduledJob = DueScheduledJob & {
  ownerSecurityVersion: number | null;
  runId: string;
  scheduledFor: string;
};

/**
 * - `claimed`: the job runs; its pending run is written.
 * - `skipped`: an earlier run of the job is still pending. The slot has a
 *   `skipped` run and does not run.
 * - `slot_taken`: the slot already has a run, so no run is written. The job's
 *   next run moves forward.
 * - `not_claimed`: the job is not due, is off, or its owner is no longer a
 *   member or had a security change. Another worker may have claimed it.
 *
 * In each case except `not_claimed`, `next_run_at` moved to the next slot.
 */
export type ClaimJobResult =
  | { status: "claimed"; job: ClaimedScheduledJob }
  | { status: "skipped"; runId: string; scheduledFor: string }
  | { status: "slot_taken"; scheduledFor: string }
  | { status: "not_claimed" };

/** The run error of a slot that came due while the previous run was still pending. */
export const SKIPPED_RUN_MESSAGE = "The run was skipped because the previous run of this job was still running.";

/**
 * - `finished`: this call wrote the run's outcome. `consecutiveFailures` is
 *   the new counter when the outcome counted and the job still has the claimed
 *   revision; otherwise null. `disabled` is true when this call disabled the
 *   job because the counter reached the limit.
 * - `already_finished`: another writer (the stale-run sweep) finished the run
 *   first. Nothing changed.
 * - `missing`: the job and its runs are gone, because the job was deleted.
 *   Nothing changed. The sweep can have failed the run before the delete.
 */
export type FinishJobRunResult =
  | { status: "finished"; run: ScheduledJobRunRecord; consecutiveFailures: number | null; disabled: boolean }
  | { status: "already_finished" }
  | { status: "missing" };

/** What a create or edit stores about the session that saved the job. */
export type ScheduledJobOwnerSession = {
  /** The session's local security version; null for a WorkOS session. */
  ownerSecurityVersion: number | null;
};

/**
 * Admission limit for a write that can leave a scheduled job enabled.
 * `maxActive` is the most enabled jobs one user may hold; 0 turns the cap off.
 */
export type ScheduledJobAdmission = { maxActive: number };

export type CreateScheduledJobResult =
  | { status: "created"; job: ScheduledJobRecord }
  | { status: "limit_reached" };

export type UpdateScheduledJobResult =
  | { status: "updated"; job: ScheduledJobRecord }
  | { status: "not_found" }
  | { status: "limit_reached" };

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapSection(row: Record<string, unknown>): UserSettingsSectionRecord {
  return {
    userId: String(row.user_id),
    sectionKey: String(row.section_key) as UserSettingsSectionKey,
    version: Number(row.version),
    config: toRecord(row.config_json),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

function mapScheduledJob(row: Record<string, unknown>): ScheduledJobRecord {
  return {
    tenantId: String(row.tenant_id),
    jobId: String(row.job_id),
    userId: String(row.user_id),
    jobName: String(row.job_name),
    description: row.description ? String(row.description) : null,
    scheduleKind: "cron",
    cronExpression: String(row.cron_expression),
    timeZone: String(row.time_zone),
    targetType: row.target_type === "skill" ? "skill" : "prompt",
    targetRef: row.target_ref ? String(row.target_ref) : null,
    input: toRecord(row.input_json),
    settingsSnapshot: toRecord(row.settings_snapshot_json),
    enabled: Boolean(row.enabled),
    // The reason applies only while the job is off. Older backend code can
    // turn a paused job on without clearing it (migration 080).
    pausedReason: !row.enabled && row.paused_reason === "security_change" ? "security_change" : null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    lastRunAt: isoTimestampOrNull(row.last_run_at),
    nextRunAt: isoTimestampOrNull(row.next_run_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

function mapDueScheduledJob(row: Record<string, unknown>): DueScheduledJob {
  return { ...mapScheduledJob(row), revision: Number(row.revision ?? 0) };
}

function mapClaimedScheduledJob(row: Record<string, unknown>, runId: string, scheduledFor: string): ClaimedScheduledJob {
  return {
    ...mapDueScheduledJob(row),
    ownerSecurityVersion: row.owner_security_version === null || row.owner_security_version === undefined
      ? null
      : Number(row.owner_security_version),
    runId,
    scheduledFor
  };
}

function mapScheduledJobRun(row: Record<string, unknown>): ScheduledJobRunRecord {
  return {
    runId: String(row.run_id),
    jobId: String(row.job_id),
    userId: String(row.user_id),
    sessionId: row.session_id ? String(row.session_id) : null,
    status: String(row.status),
    scheduledFor: isoTimestampOrNull(row.scheduled_for),
    startedAt: isoTimestamp(row.started_at),
    completedAt: isoTimestampOrNull(row.completed_at),
    durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    errorMessage: row.error_message ? String(row.error_message) : null,
    summary: row.summary ? String(row.summary) : null,
    createdAt: isoTimestamp(row.created_at)
  };
}

// Every write that can raise a user's enabled-job count takes this
// transaction lock first. The quota is not stored in a row, so a row lock alone
// cannot stop two inserts from both passing the count. The key is a JSON array
// so that two different (tenant, user) pairs cannot build the same key.
async function lockScheduledJobQuota(
  client: PoolClient,
  tenantId: string,
  userId: string
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    JSON.stringify(["scheduled-job-quota", tenantId, userId])
  ]);
}

// Only enabled jobs fire recurring synthetic turns, so disabled or parked jobs
// (invalid cron, poison-disabled) must not count against the cap. Otherwise
// dead rows could keep a user from creating new jobs.
async function countEnabledScheduledJobs(
  client: PoolClient,
  tenantId: string,
  userId: string
): Promise<number> {
  const result = await client.query(
    `
      SELECT COUNT(*) AS count
      FROM scheduled_jobs
      WHERE tenant_id = $1 AND user_id = $2 AND enabled = TRUE
    `,
    [tenantId, userId]
  );

  return Number(result.rows[0]?.count ?? 0);
}

// True when the owner's local account had no security change (password change
// or reset, sign out everywhere, disable, a factor change) after the session
// that last saved the job, or the owner is a WorkOS account. Use it in a
// statement on `scheduled_jobs`.
const OWNER_SECURITY_CURRENT_SQL = ownerSecurityVersionSql("scheduled_jobs");

export class UserSettingsStore {
  constructor(
    private readonly db: Pool,
    private readonly schedulerDb: Pool = db
  ) {}

  /**
   * Runs one guarded job change on the RLS-bypassing scheduler pool and, when
   * it changed a row and `audit` is given, writes the event in the same
   * transaction. Returns true when the change matched a row.
   */
  private async changeJobWithAudit(sql: string, params: unknown[], audit?: AuditEventInput): Promise<boolean> {
    return withTransaction(this.schedulerDb, async (client) => {
      const result = await client.query(sql, params);
      const changed = (result.rowCount ?? 0) > 0;
      if (changed && audit) await AuditEventStore.createInTransaction(client, audit);
      return changed;
    });
  }

  async listSections(tenantId: string, userId: string): Promise<UserSettingsSectionRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM user_settings_sections
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY section_key ASC
        `,
        [tenantId, userId]
      );

      return result.rows.map((row) => mapSection(row));
    });
  }

  /** `audit` builds the save's audit event, which commits in the save's transaction. */
  async upsertSection(input: {
    tenantId: string;
    userId: string;
    sectionKey: UserSettingsSectionKey;
    config: Record<string, unknown>;
  }, audit?: (section: UserSettingsSectionRecord) => AuditEventInput): Promise<UserSettingsSectionRecord> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO user_settings_sections (tenant_id, user_id, section_key, version, config_json)
          VALUES ($1, $2, $3, 1, $4::jsonb)
          ON CONFLICT (tenant_id, user_id, section_key)
          DO UPDATE SET
            config_json = EXCLUDED.config_json,
            version = user_settings_sections.version + 1,
            updated_at = NOW()
          RETURNING *
        `,
        [input.tenantId, input.userId, input.sectionKey, JSON.stringify(input.config)]
      );

      const section = mapSection(result.rows[0]);
      if (audit) await AuditEventStore.createInTransaction(client, audit(section));
      return section;
    });
  }

  async listScheduledJobs(tenantId: string, userId: string): Promise<ScheduledJobRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM scheduled_jobs
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY updated_at DESC, created_at DESC
        `,
        [tenantId, userId]
      );

      return result.rows.map((row) => mapScheduledJob(row));
    });
  }

  async getScheduledJob(
    tenantId: string,
    jobId: string,
    userId: string
  ): Promise<ScheduledJobRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM scheduled_jobs
          WHERE tenant_id = $1 AND job_id = $2 AND user_id = $3
        `,
        [tenantId, jobId, userId]
      );

      return result.rows[0] ? mapScheduledJob(result.rows[0]) : null;
    });
  }

  /**
   * Create a job. Admission to the per-user active-job cap runs in the same
   * transaction as the insert, under a per-(tenant, user) lock: only ENABLED
   * jobs fire recurring synthetic turns, so a disabled job is never counted and
   * never blocked. Without the lock, two requests could both read 49 enabled
   * jobs and each insert one more. `audit` builds the create's audit event,
   * which commits in the same transaction.
   */
  async createScheduledJob(
    input: {
      tenantId: string;
      jobId: string;
      userId: string;
      jobName: string;
      description: string | null;
      cronExpression: string;
      timeZone: string;
      targetType: "prompt" | "skill";
      targetRef: string | null;
      input: Record<string, unknown>;
      settingsSnapshot: Record<string, unknown>;
      enabled: boolean;
      nextRunAt: string | null;
    } & ScheduledJobOwnerSession,
    admission: ScheduledJobAdmission,
    audit?: (job: ScheduledJobRecord) => AuditEventInput
  ): Promise<CreateScheduledJobResult> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      if (input.enabled && admission.maxActive > 0) {
        await lockScheduledJobQuota(client, input.tenantId, input.userId);
        const active = await countEnabledScheduledJobs(client, input.tenantId, input.userId);
        if (active >= admission.maxActive) {
          return { status: "limit_reached" };
        }
      }

      const result = await client.query(
        `
          INSERT INTO scheduled_jobs (
            tenant_id,
            job_id,
            user_id,
            job_name,
            description,
            schedule_kind,
            cron_expression,
            time_zone,
            target_type,
            target_ref,
            input_json,
            settings_snapshot_json,
            enabled,
            next_run_at,
            owner_security_version
          )
          VALUES ($1, $2, $3, $4, $5, 'cron', $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)
          RETURNING *
        `,
        [
          input.tenantId,
          input.jobId,
          input.userId,
          input.jobName,
          input.description,
          input.cronExpression,
          input.timeZone,
          input.targetType,
          input.targetRef,
          JSON.stringify(input.input),
          JSON.stringify(input.settingsSnapshot),
          input.enabled,
          input.nextRunAt,
          input.ownerSecurityVersion
        ]
      );

      const job = mapScheduledJob(result.rows[0]);
      if (audit) await AuditEventStore.createInTransaction(client, audit(job));
      return { status: "created", job };
    });
  }

  /**
   * Update a job. A disabled to enabled change is admitted like a create. The
   * transition is decided from the job row read under its row lock, not from
   * a caller's earlier read, so enabling a job that is already enabled never
   * counts it twice. Lock order is always quota lock, then job row.
   *
   * The edit is the owner's confirmation of the job: it stores the saving
   * session's security version and clears a pause reason. It also starts a
   * new revision with no failures: the outcome of a run claimed before the
   * edit does not count against the edited job (`finishJobRun`). `audit`
   * builds the edit's audit event, which commits in the same transaction.
   */
  async updateScheduledJob(
    input: {
      tenantId: string;
      jobId: string;
      userId: string;
      jobName: string;
      description: string | null;
      cronExpression: string;
      timeZone: string;
      targetType: "prompt" | "skill";
      targetRef: string | null;
      input: Record<string, unknown>;
      settingsSnapshot: Record<string, unknown>;
      enabled: boolean;
      nextRunAt: string | null;
    } & ScheduledJobOwnerSession,
    admission: ScheduledJobAdmission,
    audit?: (job: ScheduledJobRecord) => AuditEventInput
  ): Promise<UpdateScheduledJobResult> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      if (input.enabled && admission.maxActive > 0) {
        await lockScheduledJobQuota(client, input.tenantId, input.userId);
        const current = await client.query(
          `
            SELECT enabled
            FROM scheduled_jobs
            WHERE tenant_id = $1 AND job_id = $2 AND user_id = $3
            FOR UPDATE
          `,
          [input.tenantId, input.jobId, input.userId]
        );
        if (!current.rows[0]) {
          return { status: "not_found" };
        }
        if (!current.rows[0].enabled) {
          const active = await countEnabledScheduledJobs(client, input.tenantId, input.userId);
          if (active >= admission.maxActive) {
            return { status: "limit_reached" };
          }
        }
      }

      const result = await client.query(
        `
          UPDATE scheduled_jobs
          SET
            job_name = $4,
            description = $5,
            cron_expression = $6,
            time_zone = $7,
            target_type = $8,
            target_ref = $9,
            input_json = $10::jsonb,
            settings_snapshot_json = $11::jsonb,
            enabled = $12,
            next_run_at = $13,
            owner_security_version = $14,
            paused_reason = NULL,
            consecutive_failures = 0,
            revision = revision + 1,
            updated_at = NOW()
          WHERE tenant_id = $1 AND job_id = $2 AND user_id = $3
          RETURNING *
        `,
        [
          input.tenantId,
          input.jobId,
          input.userId,
          input.jobName,
          input.description,
          input.cronExpression,
          input.timeZone,
          input.targetType,
          input.targetRef,
          JSON.stringify(input.input),
          JSON.stringify(input.settingsSnapshot),
          input.enabled,
          input.nextRunAt,
          input.ownerSecurityVersion
        ]
      );

      if (!result.rows[0]) return { status: "not_found" };
      const job = mapScheduledJob(result.rows[0]);
      if (audit) await AuditEventStore.createInTransaction(client, audit(job));
      return { status: "updated", job };
    });
  }

  /** `audit` is the delete's audit event. It commits in the delete's transaction, only when a job was deleted. */
  async deleteScheduledJob(tenantId: string, jobId: string, userId: string,
    audit?: AuditEventInput): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          DELETE FROM scheduled_jobs
          WHERE tenant_id = $1 AND job_id = $2 AND user_id = $3
        `,
        [tenantId, jobId, userId]
      );

      const deleted = (result.rowCount ?? 0) > 0;
      if (deleted && audit) await AuditEventStore.createInTransaction(client, audit);
      return deleted;
    });
  }

  /**
   * The due jobs that the next `limit` free slots take, in turn order:
   *
   * - One job per tenant in each round. Tenants go in the order of their last
   *   run start (the latest `last_run_at` of all their jobs), oldest first,
   *   and a tenant with no run yet goes first.
   * - In a tenant's turns, its members take turns in the same way, by the
   *   latest `last_run_at` of their own jobs.
   * - A member's own jobs go oldest `next_run_at` first.
   *
   * `claimJob` sets `last_run_at` in the UPDATE that takes the job. After a
   * claim on any replica, the next list puts that tenant after the other
   * tenants of the round, and that member after the other members of the
   * tenant. Each fresh list reflects committed claims. A replica can still
   * use a list it read before another replica claimed a job, so this is not
   * a strict cross-replica dispatch order. The order counts runs, not run
   * time, and a due job still waits for a free slot.
   *
   * All jobs of a tenant or member count, also disabled ones, so turning a job
   * off does not give an earlier turn. Runs on the RLS-bypassing scheduler
   * pool; each row and each aggregate stays keyed by its own tenant_id.
   */
  async listDueJobs(limit: number): Promise<DueScheduledJob[]> {
    const result = await this.schedulerDb.query(
      `
        WITH due AS (
          SELECT *
          FROM scheduled_jobs
          WHERE enabled = TRUE
            AND next_run_at IS NOT NULL
            AND next_run_at <= NOW()
            -- The job's owner must still be a member of the tenant. Member
            -- removal disables their jobs directly; this is the standing guard
            -- for rows that predate that fix or that a failed removal missed.
            AND EXISTS (
              SELECT 1 FROM tenant_memberships m
              WHERE m.tenant_id = scheduled_jobs.tenant_id
                AND m.user_id = scheduled_jobs.user_id
            )
        ),
        last_runs AS (
          SELECT
            tenant_id,
            user_id,
            MAX(last_run_at) AS member_last_run_at,
            MAX(MAX(last_run_at)) OVER (PARTITION BY tenant_id) AS tenant_last_run_at
          FROM scheduled_jobs
          WHERE tenant_id IN (SELECT tenant_id FROM due)
          GROUP BY tenant_id, user_id
        ),
        member_turns AS (
          SELECT
            due.*,
            last_runs.member_last_run_at,
            last_runs.tenant_last_run_at,
            ROW_NUMBER() OVER (
              PARTITION BY due.tenant_id, due.user_id
              ORDER BY due.next_run_at, due.job_id
            ) AS member_turn
          FROM due
          JOIN last_runs USING (tenant_id, user_id)
        ),
        tenant_turns AS (
          SELECT
            member_turns.*,
            ROW_NUMBER() OVER (
              PARTITION BY tenant_id
              ORDER BY member_turn, member_last_run_at ASC NULLS FIRST, next_run_at, user_id
            ) AS tenant_turn
          FROM member_turns
        )
        SELECT *
        FROM tenant_turns
        ORDER BY tenant_turn, tenant_last_run_at ASC NULLS FIRST, next_run_at, tenant_id, job_id
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) => mapDueScheduledJob(row));
  }

  /**
   * Claim the due slot of a job. The slot is the job's `next_run_at`; the run
   * row keeps it as `scheduled_for`, and a unique index lets each slot have
   * one run. The next slot comes from the cron expression and the database
   * clock, not the worker's clock. See `ClaimJobResult` for the outcomes.
   *
   * One transaction as `app_user` in the tenant's scope (`maintenance_user`
   * has no INSERT on `scheduled_job_runs`). RLS and the `tenant_id` predicate
   * both bound it. The tenant comes from the job row that `listDueJobs` read,
   * never from caller-supplied input.
   *
   * Order:
   * 1. Lock the job row if it is due and may run. Under concurrent claims, the
   *    loser waits on the lock, then finds `next_run_at` in the future and
   *    matches no row.
   * 2. In a new statement, so with a new snapshot, read the database time and
   *    whether the job has a pending run. The pending run of a claim that
   *    committed while this one waited is visible here.
   * 3. A pending run means the earlier run still runs: write a `skipped` run
   *    for the slot. Otherwise write the `pending` run. Then move
   *    `next_run_at` to the next slot.
   *
   * A crash after the commit leaves a pending run that `sweepStaleJobRuns`
   * fails. A failed insert rolls the claim back, so the job stays due.
   *
   * A job whose owner had a security change since the job was saved is not
   * claimed. The worker then pauses it with `pauseJobForSecurityChange`.
   *
   * `last_run_at = NOW()` is the record of a run start that `listDueJobs`
   * uses for the turn order of tenants and members. Only a claimed run sets
   * it, in the same transaction as its run row.
   */
  async claimJob(tenantId: string, jobId: string, runId: string): Promise<ClaimJobResult> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const due = await client.query(
        `
          SELECT *
          FROM scheduled_jobs
          WHERE tenant_id = $1
            AND job_id = $2
            AND enabled = TRUE
            AND next_run_at IS NOT NULL
            AND next_run_at <= NOW()
            -- Also checked here, not just in listDueJobs: that query is a
            -- pre-filter run once per tick, while this lock is the gate.
            -- A tick that listed a job just before its owner was removed would
            -- otherwise still claim and execute it.
            AND EXISTS (
              SELECT 1 FROM tenant_memberships m
              WHERE m.tenant_id = scheduled_jobs.tenant_id
                AND m.user_id = scheduled_jobs.user_id
            )
            AND ${OWNER_SECURITY_CURRENT_SQL}
          FOR UPDATE
        `,
        [tenantId, jobId]
      );
      const job = due.rows[0];
      if (!job) return { status: "not_claimed" };

      const state = await client.query<{ db_now: Date; busy: boolean }>(
        `
          SELECT
            clock_timestamp() AS db_now,
            EXISTS (
              SELECT 1 FROM scheduled_job_runs
              WHERE tenant_id = $1 AND job_id = $2 AND status = 'pending'
            ) AS busy
        `,
        [tenantId, jobId]
      );
      const { db_now: dbNow, busy } = state.rows[0]!;
      const scheduledFor = isoTimestamp(job.next_run_at);
      // Strictly after the current minute of the database clock, so after the
      // slot that this claim takes too.
      const nextRunAt = computeNextCronRunAt(String(job.cron_expression), String(job.time_zone), dbNow);

      // The slot comes from the locked row, not from a JavaScript Date, so it
      // keeps the full precision of `next_run_at`.
      const inserted = await client.query(
        `
          INSERT INTO scheduled_job_runs (
            tenant_id, run_id, job_id, user_id, session_id, status, scheduled_for,
            started_at, completed_at, duration_ms, error_message
          )
          SELECT
            tenant_id, $3::text, job_id, user_id, NULL, $4::text, next_run_at,
            NOW(),
            CASE WHEN $4::text = 'skipped' THEN NOW() END,
            CASE WHEN $4::text = 'skipped' THEN 0 END,
            CASE WHEN $4::text = 'skipped' THEN $5::text END
          FROM scheduled_jobs
          WHERE tenant_id = $1 AND job_id = $2
          ON CONFLICT (tenant_id, job_id, scheduled_for) DO NOTHING
          RETURNING run_id
        `,
        [tenantId, jobId, runId, busy ? "skipped" : "pending", SKIPPED_RUN_MESSAGE]
      );
      const wrote = (inserted.rowCount ?? 0) > 0;
      const started = wrote && !busy;

      const advanced = await client.query(
        `
          UPDATE scheduled_jobs
          SET
            last_run_at = CASE WHEN $4::boolean THEN NOW() ELSE last_run_at END,
            next_run_at = $3,
            updated_at = NOW()
          WHERE tenant_id = $1 AND job_id = $2
          RETURNING *
        `,
        [tenantId, jobId, nextRunAt, started]
      );

      if (!wrote) return { status: "slot_taken", scheduledFor };
      if (busy) return { status: "skipped", runId, scheduledFor };
      return { status: "claimed", job: mapClaimedScheduledJob(advanced.rows[0], runId, scheduledFor) };
    });
  }

  /**
   * Take a due job out of the due query without a run: next_run_at = NULL.
   * The fallback for a job whose cron cannot be parsed when it cannot be
   * disabled. Applies only while the job has the listed `revision`, so it
   * does not park an edited job. Returns true when this call parked the job.
   * Runs on the RLS-bypassing scheduler pool, so the `tenant_id` predicate is
   * the sole isolation guarantee and must always be present. `audit` commits
   * with the change, only when the job changed.
   */
  async parkJob(tenantId: string, jobId: string, revision: number, audit?: AuditEventInput): Promise<boolean> {
    return this.changeJobWithAudit(
      `
        UPDATE scheduled_jobs
        SET next_run_at = NULL, updated_at = NOW()
        WHERE tenant_id = $1
          AND job_id = $2
          AND enabled = TRUE
          AND revision = $3
          AND next_run_at IS NOT NULL
          AND next_run_at <= NOW()
      `,
      [tenantId, jobId, revision],
      audit
    );
  }

  /**
   * Pause an enabled job whose owner had a security change since the job was
   * saved: enabled = FALSE, next_run_at = NULL, paused_reason =
   * 'security_change'. The job and its run history stay. Returns true when
   * this call paused the job. Only the owner can turn it on again, with an
   * edit from a current session (`updateScheduledJob`). Runs on the
   * RLS-bypassing scheduler pool, so the `tenant_id` predicate is the sole
   * isolation guarantee and must always be present. `audit` commits with the
   * change, only when the job changed.
   */
  async pauseJobForSecurityChange(tenantId: string, jobId: string, audit?: AuditEventInput): Promise<boolean> {
    return this.changeJobWithAudit(
      `
        UPDATE scheduled_jobs
        SET enabled = FALSE, next_run_at = NULL, paused_reason = 'security_change', updated_at = NOW()
        WHERE tenant_id = $1
          AND job_id = $2
          AND enabled = TRUE
          AND NOT (${OWNER_SECURITY_CURRENT_SQL})
      `,
      [tenantId, jobId],
      audit
    );
  }

  /**
   * The current security version of a job owner's local account, or null
   * for a WorkOS owner, who has no local identity. The worker compares it
   * with the claimed job's `ownerSecurityVersion` before the turn starts.
   * Scheduler pool, read only.
   */
  async getOwnerSecurityVersion(tenantId: string, userId: string): Promise<number | null> {
    const result = await this.schedulerDb.query<{ security_version: number }>(
      `
        SELECT security_version
        FROM local_identities
        WHERE tenant_id = $1 AND user_id = $2
      `,
      [tenantId, userId]
    );

    return result.rows[0] ? Number(result.rows[0].security_version) : null;
  }

  /**
   * Disable a job (enabled = FALSE, next_run_at = NULL) so it leaves the
   * due-job query. Used for a job whose cron cannot be parsed. A job that
   * reaches the failure limit is disabled by `finishJobRun` instead.
   *
   * Applies only to a job that is on and still has `revision`. A job that the
   * owner saved since, or that is already off, does not change: a job paused
   * for a security change keeps its `paused_reason` and its review prompt.
   * On a job that is on, the reason can only be left over from older code
   * (migration 080), so the disable clears it. Returns true when this call
   * disabled the job, so the caller writes one audit event. Runs on the
   * RLS-bypassing scheduler pool, so the `tenant_id` predicate is the sole
   * isolation guarantee and must always be present. `audit` commits with the
   * change, only when the job changed.
   */
  async disableJob(tenantId: string, jobId: string, revision: number, audit?: AuditEventInput): Promise<boolean> {
    return this.changeJobWithAudit(
      `
        UPDATE scheduled_jobs
        SET enabled = FALSE, next_run_at = NULL, paused_reason = NULL, updated_at = NOW()
        WHERE tenant_id = $1 AND job_id = $2 AND enabled = TRUE AND revision = $3
      `,
      [tenantId, jobId, revision],
      audit
    );
  }

  /**
   * Link a claimed run to the session that the worker created for it.
   * Returns false when the run is no longer pending (the stale-run sweep
   * failed it) or its row is gone (the job was deleted).
   */
  async attachJobRunSession(input: { tenantId: string; runId: string; sessionId: string }): Promise<boolean> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE scheduled_job_runs
          SET session_id = $3
          WHERE tenant_id = $1 AND run_id = $2 AND status = 'pending'
        `,
        [input.tenantId, input.runId, input.sessionId]
      );

      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * Write the outcome of a pending run and, in the same transaction, its
   * effect on the job. See `FinishJobRunResult`.
   *
   * Lock order is job row, then run row, as in `claimJob` and in a job delete
   * (the delete cascades to the runs). The reverse order could deadlock with a
   * delete of the job. A job that is gone has no run row either: `missing`.
   *
   * Only a pending run changes, so a run has one outcome: a late writer after
   * the stale-run sweep changes nothing.
   *
   * The job changes when `counts` is true, and only while the job still has
   * the `revision` that the claim read: a success sets the failure counter to
   * 0, a failure adds 1. After an owner edit, the outcome of the older
   * definition does not count. When a failure takes the counter to
   * `disableAtFailures` (0: never) and the job is on, the same write disables
   * the job. The job row lock then orders the disable with each claim and each
   * other outcome: no claim starts a run after the limit, and an older failure
   * cannot disable the job after a newer success.
   *
   * `audit` builds the events of a finished run (its outcome, and a
   * failure-limit disable). They commit in the same transaction; when they
   * fail, the run stays pending and the stale-run sweep fails it later.
   */
  async finishJobRun(input: {
    tenantId: string;
    jobId: string;
    runId: string;
    revision: number;
    status: "completed" | "failed";
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    errorMessage: string | null;
    summary: string | null;
    counts: boolean;
    disableAtFailures: number;
  }, audit?: (finished: Extract<FinishJobRunResult, { status: "finished" }>) => AuditEventInput[]): Promise<FinishJobRunResult> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const locked = await client.query<{ enabled: boolean; revision: number; consecutive_failures: number }>(
        `
          SELECT enabled, revision, consecutive_failures
          FROM scheduled_jobs
          WHERE tenant_id = $1 AND job_id = $2
          FOR NO KEY UPDATE
        `,
        [input.tenantId, input.jobId]
      );
      const job = locked.rows[0];
      if (!job) return { status: "missing" };

      const result = await client.query(
        `
          UPDATE scheduled_job_runs
          SET
            status = $4,
            completed_at = NOW(),
            duration_ms = $5,
            input_tokens = $6,
            output_tokens = $7,
            error_message = $8,
            summary = $9
          WHERE tenant_id = $1 AND job_id = $2 AND run_id = $3 AND status = 'pending'
          RETURNING *
        `,
        [
          input.tenantId,
          input.jobId,
          input.runId,
          input.status,
          input.durationMs,
          input.inputTokens,
          input.outputTokens,
          input.errorMessage,
          input.summary
        ]
      );
      const run = result.rows[0];
      if (!run) {
        const existing = await client.query(
          "SELECT 1 FROM scheduled_job_runs WHERE tenant_id = $1 AND job_id = $2 AND run_id = $3",
          [input.tenantId, input.jobId, input.runId]
        );
        return (existing.rowCount ?? 0) > 0 ? { status: "already_finished" } : { status: "missing" };
      }

      const finish = async (finished: Extract<FinishJobRunResult, { status: "finished" }>) => {
        if (audit) await AuditEventStore.createManyInTransaction(client, audit(finished));
        return finished;
      };
      if (!input.counts || Number(job.revision) !== input.revision) {
        return finish({ status: "finished", run: mapScheduledJobRun(run), consecutiveFailures: null, disabled: false });
      }

      const failed = input.status === "failed";
      const consecutiveFailures = failed ? Number(job.consecutive_failures) + 1 : 0;
      const disabled = failed && job.enabled && input.disableAtFailures > 0
        && consecutiveFailures >= input.disableAtFailures;
      // The disable clears `paused_reason` as `disableJob` does: on a job that
      // is on, a reason can only be left over from older code.
      await client.query(
        `
          UPDATE scheduled_jobs
          SET
            consecutive_failures = $3,
            enabled = CASE WHEN $4::boolean THEN FALSE ELSE enabled END,
            next_run_at = CASE WHEN $4::boolean THEN NULL ELSE next_run_at END,
            paused_reason = CASE WHEN $4::boolean THEN NULL ELSE paused_reason END,
            updated_at = NOW()
          WHERE tenant_id = $1 AND job_id = $2
        `,
        [input.tenantId, input.jobId, consecutiveFailures, disabled]
      );

      return finish({ status: "finished", run: mapScheduledJobRun(run), consecutiveFailures, disabled });
    });
  }

  /**
   * Recover run rows orphaned by a crash/restart: stuck in `status='pending'`
   * with no live `executeJob` to ever finish them. Marks them failed with a
   * fixed error message and returns identifying fields so the caller can
   * audit each one. A job with a pending run is not claimed again
   * (`claimJob`), so this sweep also frees the job for its next slot.
   *
   * Cross-tenant by design (runs on the RLS-bypassing scheduler pool).
   * `olderThanMs` must exceed the longest a healthy run can stay pending (job
   * timeout + abort-settle grace), so a live in-flight run is never swept. If
   * a presumed-dead run settles later, `finishJobRun` finds it no longer
   * pending and writes nothing, so the run keeps one outcome and one audit
   * event. `FOR UPDATE SKIP LOCKED` keeps concurrent sweeps from
   * double-claiming.
   *
   * `audit` builds each swept run's event. The batch and its events commit in
   * one transaction: when an event fails, every run of the batch stays
   * pending for the next sweep.
   */
  async sweepStaleJobRuns(olderThanMs: number, limit = 100,
    audit?: (run: OrphanedJobRunRecord) => AuditEventInput): Promise<OrphanedJobRunRecord[]> {
    return withTransaction(this.schedulerDb, async (client) => {
      const result = await client.query(
        `
          UPDATE scheduled_job_runs
          SET status = 'failed',
              completed_at = NOW(),
              error_message = 'Run orphaned by a scheduler crash or restart'
          WHERE status = 'pending'
            AND run_id IN (
              SELECT run_id
              FROM scheduled_job_runs
              WHERE status = 'pending'
                AND started_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
              ORDER BY started_at ASC
              LIMIT $2
              FOR UPDATE SKIP LOCKED
            )
          RETURNING tenant_id, run_id, job_id, user_id, session_id
        `,
        [olderThanMs, limit]
      );

      const runs = result.rows.map((row) => ({
        tenantId: String(row.tenant_id),
        runId: String(row.run_id),
        jobId: String(row.job_id),
        userId: String(row.user_id),
        sessionId: row.session_id ? String(row.session_id) : null
      }));
      if (audit) await AuditEventStore.createManyInTransaction(client, runs.map(audit));
      return runs;
    });
  }

  async listJobRuns(tenantId: string, jobId: string, userId: string): Promise<ScheduledJobRunRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM scheduled_job_runs
          WHERE tenant_id = $1 AND job_id = $2 AND user_id = $3
          ORDER BY created_at DESC
          LIMIT 50
        `,
        [tenantId, jobId, userId]
      );

      return result.rows.map((row) => mapScheduledJobRun(row));
    });
  }
}
