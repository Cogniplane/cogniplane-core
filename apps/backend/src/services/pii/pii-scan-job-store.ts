
import { type Pool, withTenantScope } from "../../lib/db.js";
import type { PiiScanSubjectType } from "./pii-scan-run-store.js";
import { uuidv7 } from "../../lib/uuid.js";
import { isoTimestamp } from "../../lib/db-mappers.js";

export type PiiScanJobMode = "detect" | "block" | "transform";

export type PiiScanJobStatus = "queued" | "claimed" | "completed" | "failed";

export type PiiScanJobPayload = {
  text?: string;
  contentType?: string;
  storageKey?: string;
  entityTypes?: string[];
  subjectKind?: "chat_prompt" | "upload" | "microsoft_import";
};

export type PiiScanJobRecord = {
  tenantId: string;
  jobId: string;
  scanRunId: string;
  subjectType: PiiScanSubjectType;
  subjectId: string;
  sourceSessionId: string | null;
  sourceUserId: string | null;
  mode: PiiScanJobMode;
  payload: PiiScanJobPayload;
  status: PiiScanJobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  claimedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatePiiScanJobInput = {
  tenantId: string;
  jobId?: string;
  scanRunId: string;
  subjectType: PiiScanSubjectType;
  subjectId: string;
  sourceSessionId?: string | null;
  sourceUserId?: string | null;
  mode: PiiScanJobMode;
  payload?: PiiScanJobPayload;
  maxAttempts?: number;
  runAfter?: Date;
};

function mapRow(row: Record<string, unknown>): PiiScanJobRecord {
  const payloadRaw = row.payload_json;
  let payload: PiiScanJobPayload = {};
  if (payloadRaw && typeof payloadRaw === "object" && !Array.isArray(payloadRaw)) {
    payload = payloadRaw as PiiScanJobPayload;
  } else if (typeof payloadRaw === "string") {
    try {
      const parsed = JSON.parse(payloadRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as PiiScanJobPayload;
      }
    } catch {
      payload = {};
    }
  }

  return {
    tenantId: String(row.tenant_id),
    jobId: String(row.job_id),
    scanRunId: String(row.scan_run_id),
    subjectType: row.subject_type === "artifact" ? "artifact" : "message",
    subjectId: String(row.subject_id),
    sourceSessionId: row.source_session_id == null ? null : String(row.source_session_id),
    sourceUserId: row.source_user_id == null ? null : String(row.source_user_id),
    mode: row.mode as PiiScanJobMode,
    payload,
    status: row.status as PiiScanJobStatus,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    runAfter: isoTimestamp(row.run_after),
    claimedAt: row.claimed_at == null ? null : isoTimestamp(row.claimed_at),
    completedAt: row.completed_at == null ? null : isoTimestamp(row.completed_at),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

export class PiiScanJobStore {
  constructor(
    private readonly db: Pool,
    private readonly schedulerDb: Pool = db
  ) {}

  async create(input: CreatePiiScanJobInput): Promise<PiiScanJobRecord> {
    const jobId = input.jobId ?? uuidv7();
    const payload = input.payload ?? {};
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO pii_scan_jobs (
            tenant_id,
            job_id,
            scan_run_id,
            subject_type,
            subject_id,
            source_session_id,
            source_user_id,
            mode,
            payload_json,
            max_attempts,
            run_after
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, COALESCE($11, NOW()))
          RETURNING *
        `,
        [
          input.tenantId,
          jobId,
          input.scanRunId,
          input.subjectType,
          input.subjectId,
          input.sourceSessionId ?? null,
          input.sourceUserId ?? null,
          input.mode,
          JSON.stringify(payload),
          input.maxAttempts ?? 3,
          input.runAfter ?? null
        ]
      );
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }

  /**
   * Atomically claims up to `limit` jobs that are due (`status = 'queued'` and
   * `run_after <= NOW()`). Uses `FOR UPDATE SKIP LOCKED` so concurrent workers
   * don't fight over the same row. Runs through `schedulerDb` because the
   * worker does not have a tenant context when polling across tenants.
   */
  async claimDueJobs(limit: number): Promise<PiiScanJobRecord[]> {
    const result = await this.schedulerDb.query(
      `
        WITH due AS (
          SELECT job_id
          FROM pii_scan_jobs
          WHERE status = 'queued' AND run_after <= NOW()
          ORDER BY run_after ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE pii_scan_jobs AS j
        SET
          status = 'claimed',
          attempts = j.attempts + 1,
          claimed_at = NOW(),
          updated_at = NOW()
        FROM due
        WHERE j.job_id = due.job_id
        RETURNING j.*
      `,
      [limit]
    );
    return result.rows.map((row) => mapRow(row as Record<string, unknown>));
  }

  async markCompleted(tenantId: string, jobId: string): Promise<void> {
    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `
          UPDATE pii_scan_jobs
          SET status = 'completed', completed_at = NOW(), updated_at = NOW(), error_message = NULL
          WHERE tenant_id = $1 AND job_id = $2
        `,
        [tenantId, jobId]
      );
    });
  }

  /**
   * Records a failure. When `permanent` is true (e.g. malformed artifact,
   * unsupported MIME), the job is terminated immediately regardless of
   * attempts so callers don't waste retries on errors that can't recover.
   * When false (the default — transient errors like provider timeouts),
   * the job is requeued with a backoff `run_after` until `max_attempts`.
   */
  async recordFailure(
    tenantId: string,
    jobId: string,
    errorMessage: string,
    options: { backoffMs?: number; permanent?: boolean } = {}
  ): Promise<PiiScanJobRecord | null> {
    const backoffMs = options.backoffMs ?? 30_000;
    const permanent = options.permanent ?? false;
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE pii_scan_jobs
          SET
            status = CASE WHEN $5::boolean OR attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            run_after = CASE WHEN $5::boolean OR attempts >= max_attempts THEN run_after ELSE NOW() + ($3::int * INTERVAL '1 millisecond') END,
            claimed_at = NULL,
            completed_at = CASE WHEN $5::boolean OR attempts >= max_attempts THEN NOW() ELSE NULL END,
            error_message = $4,
            updated_at = NOW()
          WHERE tenant_id = $1 AND job_id = $2
          RETURNING *
        `,
        [tenantId, jobId, backoffMs, errorMessage, permanent]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }

  async getById(tenantId: string, jobId: string): Promise<PiiScanJobRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM pii_scan_jobs WHERE tenant_id = $1 AND job_id = $2 LIMIT 1`,
        [tenantId, jobId]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }
}
