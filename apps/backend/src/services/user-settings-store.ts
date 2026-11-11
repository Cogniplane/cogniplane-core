import type { PoolClient } from "pg";

import { type Pool, withTenantScope } from "../lib/db.js";
import { isoTimestamp, isoTimestampOrNull } from "../lib/db-mappers.js";
import { ownerSecurityVersionSql } from "./auth/security-change.js";

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
 * A job as the scheduler claimed it. `ownerSecurityVersion` is the security
 * version of the owner's local account from the session that last saved the
 * job; null for a WorkOS owner. It stays out of `ScheduledJobRecord`, so API
 * responses do not carry it. `runId` is the pending run that the claim wrote.
 */
export type ClaimedScheduledJob = ScheduledJobRecord & { ownerSecurityVersion: number | null; runId: string };

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

function mapClaimedScheduledJob(row: Record<string, unknown>, runId: string): ClaimedScheduledJob {
  return {
    ...mapScheduledJob(row),
    ownerSecurityVersion: row.owner_security_version === null || row.owner_security_version === undefined
      ? null
      : Number(row.owner_security_version),
    runId
  };
}

function mapScheduledJobRun(row: Record<string, unknown>): ScheduledJobRunRecord {
  return {
    runId: String(row.run_id),
    jobId: String(row.job_id),
    userId: String(row.user_id),
    sessionId: row.session_id ? String(row.session_id) : null,
    status: String(row.status),
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

  async upsertSection(input: {
    tenantId: string;
    userId: string;
    sectionKey: UserSettingsSectionKey;
    config: Record<string, unknown>;
  }): Promise<UserSettingsSectionRecord> {
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

      return mapSection(result.rows[0]);
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
   * jobs and each insert one more.
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
    admission: ScheduledJobAdmission
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

      return { status: "created", job: mapScheduledJob(result.rows[0]) };
    });
  }

  /**
   * Update a job. A disabled to enabled change is admitted like a create. The
   * transition is decided from the job row read under its row lock, not from
   * a caller's earlier read, so enabling a job that is already enabled never
   * counts it twice. Lock order is always quota lock, then job row.
   *
   * The edit is the owner's confirmation of the job: it stores the saving
   * session's security version and clears a pause reason.
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
    admission: ScheduledJobAdmission
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

      return result.rows[0]
        ? { status: "updated", job: mapScheduledJob(result.rows[0]) }
        : { status: "not_found" };
    });
  }

  async deleteScheduledJob(tenantId: string, jobId: string, userId: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          DELETE FROM scheduled_jobs
          WHERE tenant_id = $1 AND job_id = $2 AND user_id = $3
        `,
        [tenantId, jobId, userId]
      );

      return (result.rowCount ?? 0) > 0;
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
  async listDueJobs(limit: number): Promise<ScheduledJobRecord[]> {
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

    return result.rows.map((row) => mapScheduledJob(row));
  }

  /**
   * Claim a due job for execution and write its pending run (`runId`, no
   * session yet) in the same transaction. A crash after the claim therefore
   * leaves a run that `sweepStaleJobRuns` recovers, and a failed insert
   * leaves the job due for the next tick. Under concurrent claims, the loser
   * waits on the job row lock, then matches no row and writes no run.
   *
   * Runs as `app_user` in the tenant's scope: `maintenance_user` has no
   * INSERT on `scheduled_job_runs`. RLS and the `tenant_id` predicate both
   * bound the claim. The tenant comes from the job row that `listDueJobs`
   * read, never from caller-supplied input.
   *
   * A job whose owner had a security change since the job was saved is not
   * claimed. The worker then pauses it with `pauseJobForSecurityChange`.
   *
   * `last_run_at = NOW()` is the record of the claim that `listDueJobs` uses
   * for the turn order of tenants and members. Keep it in this UPDATE, so a
   * claim and its turn record commit together.
   */
  async claimJob(
    tenantId: string,
    jobId: string,
    nextRunAt: string | null,
    runId: string
  ): Promise<ClaimedScheduledJob | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const claimed = await client.query(
        `
          UPDATE scheduled_jobs
          SET
            last_run_at = NOW(),
            next_run_at = $3,
            updated_at = NOW()
          WHERE tenant_id = $1
            AND job_id = $2
            AND enabled = TRUE
            AND next_run_at IS NOT NULL
            AND next_run_at <= NOW()
            -- Also checked here, not just in listDueJobs: that query is a
            -- pre-filter run once per tick, while this UPDATE is the atomic gate.
            -- A tick that listed a job just before its owner was removed would
            -- otherwise still claim and execute it.
            AND EXISTS (
              SELECT 1 FROM tenant_memberships m
              WHERE m.tenant_id = scheduled_jobs.tenant_id
                AND m.user_id = scheduled_jobs.user_id
            )
            AND ${OWNER_SECURITY_CURRENT_SQL}
          RETURNING *
        `,
        [tenantId, jobId, nextRunAt]
      );
      const row = claimed.rows[0];
      if (!row) return null;

      await client.query(
        `
          INSERT INTO scheduled_job_runs (tenant_id, run_id, job_id, user_id, session_id, status, started_at)
          VALUES ($1, $2, $3, $4, NULL, 'pending', NOW())
        `,
        [row.tenant_id, runId, row.job_id, row.user_id]
      );

      return mapClaimedScheduledJob(row, runId);
    });
  }

  /**
   * Take a due job out of the due query without a run: next_run_at = NULL.
   * The fallback for a job whose cron cannot be parsed when it cannot be
   * disabled. Runs on the RLS-bypassing scheduler pool, so the `tenant_id`
   * predicate is the sole isolation guarantee and must always be present.
   */
  async parkJob(tenantId: string, jobId: string): Promise<void> {
    await this.schedulerDb.query(
      `
        UPDATE scheduled_jobs
        SET next_run_at = NULL, updated_at = NOW()
        WHERE tenant_id = $1
          AND job_id = $2
          AND enabled = TRUE
          AND next_run_at IS NOT NULL
          AND next_run_at <= NOW()
      `,
      [tenantId, jobId]
    );
  }

  /**
   * Pause an enabled job whose owner had a security change since the job was
   * saved: enabled = FALSE, next_run_at = NULL, paused_reason =
   * 'security_change'. The job and its run history stay. Returns true when
   * this call paused the job. Only the owner can turn it on again, with an
   * edit from a current session (`updateScheduledJob`). Runs on the
   * RLS-bypassing scheduler pool, so the `tenant_id` predicate is the sole
   * isolation guarantee and must always be present.
   */
  async pauseJobForSecurityChange(tenantId: string, jobId: string): Promise<boolean> {
    const result = await this.schedulerDb.query(
      `
        UPDATE scheduled_jobs
        SET enabled = FALSE, next_run_at = NULL, paused_reason = 'security_change', updated_at = NOW()
        WHERE tenant_id = $1
          AND job_id = $2
          AND enabled = TRUE
          AND NOT (${OWNER_SECURITY_CURRENT_SQL})
      `,
      [tenantId, jobId]
    );

    return (result.rowCount ?? 0) > 0;
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
   * Record the outcome of a finished run against the job's poison counter.
   * On success the counter resets to 0; on failure it increments. Returns the
   * new `consecutive_failures` value so the scheduler can decide whether to
   * auto-disable. Runs on the RLS-bypassing scheduler pool
   * since the worker has no per-request tenant scope, so the `tenant_id`
   * predicate is the sole isolation guarantee and must always be present.
   */
  async recordJobRunOutcome(
    tenantId: string,
    jobId: string,
    succeeded: boolean
  ): Promise<number> {
    const result = await this.schedulerDb.query(
      `
        UPDATE scheduled_jobs
        SET
          consecutive_failures = CASE WHEN $3 THEN 0 ELSE consecutive_failures + 1 END,
          updated_at = NOW()
        WHERE tenant_id = $1 AND job_id = $2
        RETURNING consecutive_failures
      `,
      [tenantId, jobId, succeeded]
    );

    return result.rows[0] ? Number(result.rows[0].consecutive_failures ?? 0) : 0;
  }

  /**
   * Disable a job (enabled = FALSE, next_run_at = NULL) so it permanently
   * leaves the due-job query. Used for poison jobs (invalid cron or repeated
   * failures). Idempotent; runs on the RLS-bypassing scheduler pool, so the
   * `tenant_id` predicate is the sole isolation guarantee and must always be
   * present.
   */
  async disableJob(tenantId: string, jobId: string): Promise<void> {
    await this.schedulerDb.query(
      `
        UPDATE scheduled_jobs
        SET enabled = FALSE, next_run_at = NULL, paused_reason = NULL, updated_at = NOW()
        WHERE tenant_id = $1 AND job_id = $2
      `,
      [tenantId, jobId]
    );
  }

  /**
   * Link a claimed run to the session that the worker created for it.
   * Returns false when the run row is gone (the job was deleted).
   */
  async attachJobRunSession(input: { tenantId: string; runId: string; sessionId: string }): Promise<boolean> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE scheduled_job_runs
          SET session_id = $3
          WHERE tenant_id = $1 AND run_id = $2
        `,
        [input.tenantId, input.runId, input.sessionId]
      );

      return (result.rowCount ?? 0) > 0;
    });
  }

  /** Record the outcome of a run. Returns null when the run row is gone. */
  async completeJobRun(input: {
    tenantId: string;
    runId: string;
    status: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    errorMessage: string | null;
    summary: string | null;
  }): Promise<ScheduledJobRunRecord | null> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE scheduled_job_runs
          SET
            status = $2,
            completed_at = NOW(),
            duration_ms = $3,
            input_tokens = $4,
            output_tokens = $5,
            error_message = $6,
            summary = $7
          WHERE tenant_id = $8 AND run_id = $1
          RETURNING *
        `,
        [
          input.runId,
          input.status,
          input.durationMs,
          input.inputTokens,
          input.outputTokens,
          input.errorMessage,
          input.summary,
          input.tenantId
        ]
      );

      return result.rows[0] ? mapScheduledJobRun(result.rows[0]) : null;
    });
  }

  /**
   * Recover run rows orphaned by a crash/restart: stuck in `status='pending'`
   * with no live `executeJob` to ever call `completeJobRun`. Marks them failed
   * with a deterministic error message and returns identifying fields so the
   * caller can audit each one. Cross-tenant by design (runs on the
   * RLS-bypassing scheduler pool); `olderThanMs` must exceed the longest a
   * healthy run can legitimately stay pending (job timeout + abort-settle
   * grace), so a live in-flight run is never swept. If a presumed-dead run
   * does settle later, its `completeJobRun` overwrites this row with the true
   * outcome — acceptable, since that outcome is strictly more accurate.
   * `FOR UPDATE SKIP LOCKED` keeps concurrent sweeps from double-claiming.
   */
  async sweepStaleJobRuns(olderThanMs: number, limit = 100): Promise<OrphanedJobRunRecord[]> {
    const result = await this.schedulerDb.query(
      `
        UPDATE scheduled_job_runs
        SET status = 'failed',
            completed_at = NOW(),
            error_message = 'Run orphaned by a scheduler crash or restart'
        WHERE run_id IN (
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

    return result.rows.map((row) => ({
      tenantId: String(row.tenant_id),
      runId: String(row.run_id),
      jobId: String(row.job_id),
      userId: String(row.user_id),
      sessionId: row.session_id ? String(row.session_id) : null
    }));
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
