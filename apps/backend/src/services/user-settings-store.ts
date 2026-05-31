import { type Pool, withTenantScope } from "../lib/db.js";

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
  consecutiveFailures: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

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
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
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
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    lastRunAt: row.last_run_at ? new Date(String(row.last_run_at)).toISOString() : null,
    nextRunAt: row.next_run_at ? new Date(String(row.next_run_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

function mapScheduledJobRun(row: Record<string, unknown>): ScheduledJobRunRecord {
  return {
    runId: String(row.run_id),
    jobId: String(row.job_id),
    userId: String(row.user_id),
    sessionId: row.session_id ? String(row.session_id) : null,
    status: String(row.status),
    startedAt: new Date(String(row.started_at)).toISOString(),
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
    durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    errorMessage: row.error_message ? String(row.error_message) : null,
    summary: row.summary ? String(row.summary) : null,
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

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

  /**
   * Count a user's ENABLED scheduled jobs. Used by the active-job cap at
   * creation time: only enabled jobs fire recurring synthetic turns, so
   * disabled/parked jobs (invalid cron, poison-disabled) must not count against
   * the limit — otherwise a user could be wedged out of creating new jobs by
   * dead rows that no longer do anything.
   */
  async countActiveScheduledJobs(tenantId: string, userId: string): Promise<number> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT COUNT(*) AS count
          FROM scheduled_jobs
          WHERE tenant_id = $1 AND user_id = $2 AND enabled = TRUE
        `,
        [tenantId, userId]
      );

      return Number(result.rows[0]?.count ?? 0);
    });
  }

  async createScheduledJob(input: {
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
  }): Promise<ScheduledJobRecord> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
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
            next_run_at
          )
          VALUES ($1, $2, $3, $4, $5, 'cron', $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)
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
          input.nextRunAt
        ]
      );

      return mapScheduledJob(result.rows[0]);
    });
  }

  async updateScheduledJob(input: {
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
  }): Promise<ScheduledJobRecord | null> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
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
          input.nextRunAt
        ]
      );

      return result.rows[0] ? mapScheduledJob(result.rows[0]) : null;
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

  async listDueJobs(limit: number): Promise<ScheduledJobRecord[]> {
    const result = await this.schedulerDb.query(
      `
        SELECT *
        FROM scheduled_jobs
        WHERE enabled = TRUE
          AND next_run_at IS NOT NULL
          AND next_run_at <= NOW()
        ORDER BY next_run_at ASC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) => mapScheduledJob(row));
  }

  /**
   * Claim a due job for execution. Runs on the RLS-bypassing scheduler pool
   * (the worker has no per-request tenant scope), so the `tenant_id` predicate
   * is the *only* thing isolating one tenant's jobs from another — it must
   * always be present and must come from the job row the worker already read,
   * never from caller-supplied input.
   */
  async claimJob(
    tenantId: string,
    jobId: string,
    nextRunAt: string | null
  ): Promise<ScheduledJobRecord | null> {
    const result = await this.schedulerDb.query(
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
        RETURNING *
      `,
      [tenantId, jobId, nextRunAt]
    );

    return result.rows[0] ? mapScheduledJob(result.rows[0]) : null;
  }

  /**
   * Record the outcome of a finished run against the job's poison counter.
   * On success the counter resets to 0; on failure it increments. Returns the
   * new `consecutive_failures` value so the scheduler can decide whether to
   * auto-disable. Runs on the RLS-bypassing scheduler pool (same as claimJob)
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
        SET enabled = FALSE, next_run_at = NULL, updated_at = NOW()
        WHERE tenant_id = $1 AND job_id = $2
      `,
      [tenantId, jobId]
    );
  }

  async createJobRun(input: {
    tenantId: string;
    runId: string;
    jobId: string;
    userId: string;
    sessionId: string | null;
  }): Promise<ScheduledJobRunRecord> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO scheduled_job_runs (tenant_id, run_id, job_id, user_id, session_id, status, started_at)
          VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
          RETURNING *
        `,
        [input.tenantId, input.runId, input.jobId, input.userId, input.sessionId]
      );

      return mapScheduledJobRun(result.rows[0]);
    });
  }

  async completeJobRun(input: {
    tenantId: string;
    runId: string;
    status: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    errorMessage: string | null;
    summary: string | null;
  }): Promise<ScheduledJobRunRecord> {
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

      return mapScheduledJobRun(result.rows[0]);
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
