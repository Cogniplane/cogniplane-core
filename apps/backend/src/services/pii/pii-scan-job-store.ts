import type { PoolClient } from "pg";

import { type Pool, withTenantScope } from "../../lib/db.js";
import { insertPiiScanRun, type PiiScanSubjectType } from "./pii-scan-run-store.js";
import { uuidv7 } from "../../lib/uuid.js";
import { isoTimestamp } from "../../lib/db-mappers.js";
import { UPLOAD_SCAN_PENDING_KEY, writeArtifactPiiDetail } from "../artifacts/artifact-store.js";

export type PiiScanJobMode = "detect" | "block" | "transform";

export type PiiScanJobStatus = "queued" | "claimed" | "completed" | "failed";

export type PiiScanJobPayload = {
  text?: string;
  contentType?: string;
  storageKey?: string;
  entityTypes?: string[];
  // "chat_prompt", "upload", or the subject kind of a registered import source.
  subjectKind?: "chat_prompt" | "upload" | (string & {});
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
  /** Claims so far. Also the fence of the current claim (PiiScanJobClaim). */
  attempts: number;
  maxAttempts: number;
  /** Claims that ended in a transient storage failure; they do not use `maxAttempts`. */
  transientRetries: number;
  runAfter: string;
  claimedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The attempt that a worker claimed. Only that attempt can finish the job. */
export type PiiScanJobClaim = Pick<PiiScanJobRecord, "tenantId" | "jobId" | "attempts">;

export type EnqueueArtifactPiiScanJobInput = {
  tenantId: string;
  artifactId: string;
  sourceSessionId: string;
  sourceUserId: string;
  mode: PiiScanJobMode;
  payload: PiiScanJobPayload;
};

/** An upload whose scan state nothing will finish. See `listStalledUploads`. */
export type StalledUpload = { tenantId: string; artifactId: string };

/**
 * - `requeued`: an open scan run had a recorded decision; a new job finishes it.
 * - `failed`: the open scan runs, and a pending upload with its PII detail, are failed.
 * - `skipped`: the upload or its scan state changed since it was listed.
 */
export type StalledUploadOutcome = "requeued" | "failed" | "skipped";

/** Stored on a scan run and an upload that recovery closes without a decision. */
export const PII_SCAN_INTERRUPTED = "pii_scan_interrupted";

/**
 * Retries after a transient storage failure (`recordFailure` with
 * `transient`). Such a failure does not use the scan budget, so it does not
 * fail a good file while the bucket is down. The retries wait 30 seconds,
 * then twice as long each time, up to 10 minutes: 30 retries cover about
 * four and a half hours. After the cap, a transient failure counts as a
 * normal attempt again, so a storage outage cannot keep a job forever.
 */
export const PII_SCAN_TRANSIENT_RETRY_LIMIT = 30;
const TRANSIENT_RETRY_BASE_MS = 30_000;
const TRANSIENT_RETRY_MAX_DELAY_MS = 10 * 60_000;

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
    transientRetries: Number(row.transient_retries ?? 0),
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
    return withTenantScope(this.db, input.tenantId, (client) => insertPiiScanJob(client, input));
  }

  /**
   * Opens the queued scan of an upload: scan run `pending`, PII detail
   * `pending` and job `queued` commit together, or none of them does. A job
   * row thus exists if and only if its scan run and pending detail exist, and
   * the worker cannot finish the job before the pending detail is written.
   */
  async enqueueArtifactScan(
    input: EnqueueArtifactPiiScanJobInput
  ): Promise<{ scanRunId: string; jobId: string }> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const run = await insertPiiScanRun(client, {
        tenantId: input.tenantId,
        subjectType: "artifact",
        subjectId: input.artifactId,
        sourceSessionId: input.sourceSessionId,
        sourceUserId: input.sourceUserId,
        mode: input.mode,
        status: "pending"
      });
      await writeArtifactPiiDetail(client, input.tenantId, input.artifactId, {
        status: "pending",
        modeApplied: input.mode,
        scanRunId: run.scanRunId
      });
      const job = await insertPiiScanJob(client, {
        tenantId: input.tenantId,
        scanRunId: run.scanRunId,
        subjectType: "artifact",
        subjectId: input.artifactId,
        sourceSessionId: input.sourceSessionId,
        sourceUserId: input.sourceUserId,
        mode: input.mode,
        payload: input.payload
      });
      return { scanRunId: run.scanRunId, jobId: job.jobId };
    });
  }

  /**
   * Atomically claims up to `limit` jobs that are due (`status = 'queued'` and
   * `run_after <= NOW()`). Uses `FOR UPDATE SKIP LOCKED` so concurrent workers
   * don't fight over the same row. Runs through `schedulerDb` because the
   * worker does not have a tenant context when polling across tenants.
   *
   * Tenants take turns, as in the mail outbox (`mail-outbox-worker.ts`). A
   * job's turn is its place in its tenant's due queue (oldest first) plus the
   * jobs of that tenant that are claimed now, on any replica. So a tenant with
   * a large backlog and running jobs comes after a tenant with one new job,
   * also when a worker claims one job at a time. Equal turns go oldest first,
   * then by job id, so the order is stable.
   */
  async claimDueJobs(limit: number): Promise<PiiScanJobRecord[]> {
    const result = await this.schedulerDb.query(
      `
        WITH waiting AS (
          SELECT tenant_id, job_id, run_after,
                 row_number() OVER (PARTITION BY tenant_id ORDER BY run_after, job_id) AS turn
          FROM pii_scan_jobs
          WHERE status = 'queued' AND run_after <= NOW()
        ),
        running AS (
          SELECT tenant_id, count(*) AS claimed
          FROM pii_scan_jobs
          WHERE status = 'claimed'
          GROUP BY tenant_id
        ),
        due AS (
          SELECT j.job_id
          FROM pii_scan_jobs j
          JOIN waiting w ON w.job_id = j.job_id
          LEFT JOIN running r ON r.tenant_id = w.tenant_id
          WHERE j.status = 'queued' AND j.run_after <= NOW()
          ORDER BY w.turn + COALESCE(r.claimed, 0), w.run_after, w.job_id
          LIMIT $1
          FOR UPDATE OF j SKIP LOCKED
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

  /**
   * Completes the job if `claim` still holds it. A stale attempt (its claim
   * expired and the job was claimed again, or another attempt finished it)
   * changes nothing and gets false.
   */
  async markCompleted(claim: PiiScanJobClaim): Promise<boolean> {
    return withTenantScope(this.db, claim.tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE pii_scan_jobs
          SET status = 'completed', completed_at = NOW(), updated_at = NOW(), error_message = NULL
          WHERE tenant_id = $1 AND job_id = $2 AND status = 'claimed' AND attempts = $3
        `,
        [claim.tenantId, claim.jobId, claim.attempts]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * Records a failure. When `permanent` is true (e.g. malformed artifact,
   * unsupported MIME), the job is terminated immediately regardless of
   * attempts so callers don't waste retries on errors that can't recover.
   * When false (the default — transient errors like provider timeouts),
   * the job is requeued with a backoff `run_after` until `max_attempts`.
   * Only the attempt that `claim` names can record it; for a stale attempt
   * this returns null and changes nothing.
   *
   * `transient` (object storage slow or unavailable) requeues the job
   * without using its budget, until PII_SCAN_TRANSIENT_RETRY_LIMIT. The
   * claim count (`attempts`) still keeps this claim: the next claim gets a
   * new, higher fence, so this attempt cannot finish the job after it.
   */
  async recordFailure(
    claim: PiiScanJobClaim,
    errorMessage: string,
    options: { backoffMs?: number; permanent?: boolean; transient?: boolean } = {}
  ): Promise<PiiScanJobRecord | null> {
    const backoffMs = options.backoffMs ?? 30_000;
    const permanent = options.permanent ?? false;
    const transient = !permanent && (options.transient ?? false);
    return withTenantScope(this.db, claim.tenantId, async (client) => {
      // SET reads the old row. A transient failure under its cap requeues
      // with its own delay; any other failure uses the scan budget.
      const result = await client.query(
        `
          WITH failure AS (
            SELECT job_id,
                   $7::boolean AND transient_retries < $8 AS deferred,
                   NOT ($7::boolean AND transient_retries < $8)
                     AND ($5::boolean OR attempts - transient_retries >= max_attempts) AS terminal,
                   LEAST($10::bigint, $9::bigint * power(2, LEAST(transient_retries, 20))::bigint) AS deferred_delay_ms
            FROM pii_scan_jobs
            WHERE tenant_id = $1 AND job_id = $2 AND status = 'claimed' AND attempts = $6
          )
          UPDATE pii_scan_jobs j
          SET
            status = CASE WHEN f.terminal THEN 'failed' ELSE 'queued' END,
            run_after = CASE
              WHEN f.terminal THEN j.run_after
              WHEN f.deferred THEN NOW() + (f.deferred_delay_ms * INTERVAL '1 millisecond')
              ELSE NOW() + ($3::int * INTERVAL '1 millisecond') END,
            transient_retries = j.transient_retries + CASE WHEN f.deferred THEN 1 ELSE 0 END,
            claimed_at = NULL,
            completed_at = CASE WHEN f.terminal THEN NOW() ELSE NULL END,
            error_message = $4,
            updated_at = NOW()
          FROM failure f
          WHERE j.tenant_id = $1 AND j.job_id = f.job_id AND j.status = 'claimed' AND j.attempts = $6
          RETURNING j.*
        `,
        [claim.tenantId, claim.jobId, backoffMs, errorMessage, permanent, claim.attempts,
          transient, PII_SCAN_TRANSIENT_RETRY_LIMIT, TRANSIENT_RETRY_BASE_MS, TRANSIENT_RETRY_MAX_DELAY_MS]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }

  /**
   * Recovers jobs stranded in `claimed` by a worker that crashed between claim
   * and completion (deploy, OOM). Without this the row — and the artifact's PII
   * status — stays stuck forever, since the only transitions out of `claimed`
   * are markCompleted / recordFailure, both driven by the in-process handler
   * that died. Runs cross-tenant on `schedulerDb` (no tenant context while
   * polling), mirroring `claimDueJobs` and the scheduler's own
   * `sweepStaleJobRuns`. A row whose attempts are exhausted is failed; otherwise
   * it is requeued for another attempt. Returns the number of rows swept.
   */
  async sweepStaleClaims(staleAfterMs: number): Promise<number> {
    // A decision may have committed before its job acknowledgement failed.
    // Recover those jobs without evaluating or auditing the subject again.
    const completed = await this.schedulerDb.query(
      `UPDATE pii_scan_jobs j
       SET status = 'completed', claimed_at = NULL, completed_at = NOW(),
           error_message = NULL, updated_at = NOW()
       WHERE j.status = 'claimed'
         AND j.claimed_at < NOW() - ($1::int * INTERVAL '1 millisecond')
         AND EXISTS (
           SELECT 1 FROM pii_scan_runs r
           WHERE r.tenant_id = j.tenant_id AND r.scan_run_id = j.scan_run_id
             AND r.status IN ('completed', 'blocked', 'transformed')
         )`,
      [staleAfterMs]
    );
    const result = await this.schedulerDb.query(
      `
        UPDATE pii_scan_jobs
        SET
          status = CASE WHEN attempts - transient_retries >= max_attempts THEN 'failed' ELSE 'queued' END,
          run_after = CASE WHEN attempts - transient_retries >= max_attempts THEN run_after ELSE NOW() END,
          claimed_at = NULL,
          completed_at = CASE WHEN attempts - transient_retries >= max_attempts THEN NOW() ELSE NULL END,
          error_message = 'claim expired (worker presumed crashed before completion)',
          updated_at = NOW()
        WHERE status = 'claimed'
          AND claimed_at < NOW() - ($1::int * INTERVAL '1 millisecond')
      `,
      [staleAfterMs]
    );
    return (completed.rowCount ?? 0) + (result.rowCount ?? 0);
  }

  /**
   * Failed jobs whose scan run or subject is still open. The stale-claim sweep
   * fails a job without touching either, and a failed write can stop the
   * handler between them. The worker finishes these rows; it reads them again
   * on each tick until both are closed. A subject with a newer queued or
   * claimed job is left to that job.
   */
  async listUnfinishedFailures(limit: number): Promise<PiiScanJobRecord[]> {
    const result = await this.schedulerDb.query(
      `SELECT j.* FROM pii_scan_jobs j
       JOIN pii_scan_runs r ON r.tenant_id = j.tenant_id AND r.scan_run_id = j.scan_run_id
       WHERE j.status = 'failed'
         AND (
           r.status IN ('pending', 'processing')
           OR (j.subject_type = 'artifact' AND EXISTS (
             SELECT 1 FROM artifacts a
             WHERE a.tenant_id = j.tenant_id AND a.artifact_id = j.subject_id
               AND a.status = 'pending'))
           OR (j.subject_type = 'message' AND EXISTS (
             SELECT 1 FROM messages m
             WHERE m.tenant_id = j.tenant_id AND m.message_id = j.subject_id
               AND m.detail_json->'pii'->>'status' IN ('pending', 'scanning')))
         )
         AND NOT EXISTS (
           SELECT 1 FROM pii_scan_jobs newer
           WHERE newer.tenant_id = j.tenant_id AND newer.subject_type = j.subject_type
             AND newer.subject_id = j.subject_id AND newer.status IN ('queued', 'claimed'))
       ORDER BY j.updated_at
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => mapRow(row as Record<string, unknown>));
  }

  /**
   * Uploads whose scan state nothing will finish. A crash or a failed write
   * between the upload commit and its scan state leaves one of these:
   *
   * - a `pending` upload with the `awaitingUploadScan` marker and no open
   *   scan run;
   * - an open scan run with no job (a synchronous scan stopped before or
   *   after it recorded its decision, or a queued scan from before the
   *   one-transaction enqueue).
   *
   * Each must be unchanged for `staleAfterMs`, longer than a synchronous scan
   * can run. A subject with a queued or claimed job, or an open run that a
   * failed job owns (`listUnfinishedFailures`), is left alone. Reads across
   * tenants on `schedulerDb`; `recoverStalledUpload` closes each one in its
   * tenant scope.
   */
  async listStalledUploads(staleAfterMs: number, limit: number): Promise<StalledUpload[]> {
    const cutoff = staleCutoffSql("$1");
    const result = await this.schedulerDb.query(
      `WITH subjects AS (
         SELECT a.tenant_id, a.artifact_id AS subject_id FROM artifacts a
         WHERE a.status = 'pending' AND a.detail_json ? '${UPLOAD_SCAN_PENDING_KEY}' AND a.updated_at < ${cutoff}
         UNION
         SELECT r.tenant_id, r.subject_id FROM pii_scan_runs r
         WHERE r.subject_type = 'artifact' AND r.status IN ('pending', 'processing') AND r.updated_at < ${cutoff}
       )
       SELECT s.tenant_id, s.subject_id FROM subjects s
       WHERE ${unownedSubjectSql("s.tenant_id", "s.subject_id", cutoff)}
       ORDER BY s.tenant_id, s.subject_id
       LIMIT $2`,
      [staleAfterMs, limit]
    );
    return result.rows.map((row) => ({ tenantId: String(row.tenant_id), artifactId: String(row.subject_id) }));
  }

  /**
   * Closes one stalled upload in its tenant scope, after a check of the same
   * conditions under lock:
   *
   * - An open scan run with a recorded decision gets a new queued job, so the
   *   handler finishes that decision (a block deletes the bytes and ends
   *   `blocked`; an allow makes the upload ready).
   * - Without a decision, the open scan runs, the PII detail and a pending
   *   upload become `failed`. The bytes stay, because nothing scanned them.
   *   A rescan is not tried: the scan run does not store the import source,
   *   so a rescan could apply the wrong scope.
   *
   * Lock order: scan runs, then the artifact, as `finishUndecidedFailure`
   * takes the run before its subject write.
   */
  async recoverStalledUpload(
    tenantId: string,
    artifactId: string,
    staleAfterMs: number
  ): Promise<StalledUploadOutcome> {
    const cutoff = staleCutoffSql("$3");
    return withTenantScope(this.db, tenantId, async (client) => {
      const runs = await client.query(
        `SELECT scan_run_id, mode, source_session_id, source_user_id, created_at,
                pending_decision IS NOT NULL AS decided
         FROM pii_scan_runs
         WHERE tenant_id = $1 AND subject_type = 'artifact' AND subject_id = $2
           AND status IN ('pending', 'processing')
         ORDER BY created_at DESC, scan_run_id DESC
         FOR UPDATE`,
        [tenantId, artifactId]
      );
      const artifact = await client.query(
        `SELECT status = 'pending' AND detail_json ? '${UPLOAD_SCAN_PENDING_KEY}' AND updated_at < ${cutoff} AS stalled
         FROM artifacts WHERE tenant_id = $1 AND artifact_id = $2
         FOR UPDATE`,
        [tenantId, artifactId, staleAfterMs]
      );
      const pendingUpload = artifact.rows[0]?.stalled === true;
      if (runs.rows.length === 0 && !pendingUpload) return "skipped";
      const unowned = await client.query(
        `SELECT ${unownedSubjectSql("$1", "$2", cutoff)} AS unowned`,
        [tenantId, artifactId, staleAfterMs]
      );
      if (unowned.rows[0]?.unowned !== true) return "skipped";

      const decided = runs.rows.find((run) => run.decided === true);
      if (decided) {
        // The decision stands; the job handler applies it.
        await insertPiiScanJob(client, {
          tenantId,
          scanRunId: String(decided.scan_run_id),
          subjectType: "artifact",
          subjectId: artifactId,
          sourceSessionId: decided.source_session_id == null ? null : String(decided.source_session_id),
          sourceUserId: decided.source_user_id == null ? null : String(decided.source_user_id),
          mode: jobModeOf(decided.mode),
          // The handler skips an audit event that this scan run wrote after
          // the job's creation time. Use the run's start, so an event that the
          // interrupted attempt wrote counts.
          createdAt: decided.created_at as Date
        });
        return "requeued";
      }

      await client.query(
        `UPDATE pii_scan_runs
         SET status = 'failed', error_message = $3, completed_at = NOW(), updated_at = NOW()
         WHERE tenant_id = $1 AND subject_type = 'artifact' AND subject_id = $2
           AND status IN ('pending', 'processing')`,
        [tenantId, artifactId, PII_SCAN_INTERRUPTED]
      );
      if (pendingUpload) {
        const newest = runs.rows[0];
        // The marker moves the pending upload to `failed` with this write.
        await writeArtifactPiiDetail(client, tenantId, artifactId, {
          status: "failed",
          summaryText: PII_SCAN_INTERRUPTED,
          ...(newest ? { modeApplied: newest.mode, scanRunId: String(newest.scan_run_id) } : {})
        });
      }
      return "failed";
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

function staleCutoffSql(staleAfterMs: string): string {
  return `NOW() - (${staleAfterMs}::int * INTERVAL '1 millisecond')`;
}

// An artifact subject that no job owns: no queued or claimed job, and no open
// scan run that changed since `cutoff` (a synchronous scan still running) or
// that a failed job owns (`listUnfinishedFailures` finishes those).
function unownedSubjectSql(tenantId: string, subjectId: string, cutoff: string): string {
  return `NOT EXISTS (
      SELECT 1 FROM pii_scan_jobs live
      WHERE live.tenant_id = ${tenantId} AND live.subject_type = 'artifact'
        AND live.subject_id = ${subjectId} AND live.status IN ('queued', 'claimed'))
    AND NOT EXISTS (
      SELECT 1 FROM pii_scan_runs busy
      WHERE busy.tenant_id = ${tenantId} AND busy.subject_type = 'artifact'
        AND busy.subject_id = ${subjectId} AND busy.status IN ('pending', 'processing')
        AND (busy.updated_at >= ${cutoff} OR EXISTS (
          SELECT 1 FROM pii_scan_jobs failed
          WHERE failed.tenant_id = busy.tenant_id AND failed.scan_run_id = busy.scan_run_id
            AND failed.status = 'failed')))`;
}

// A scan run stores the routed mode until it ends. `off` is not a job mode;
// a recorded decision keeps its own applied mode.
function jobModeOf(mode: unknown): PiiScanJobMode {
  return mode === "detect" || mode === "transform" ? mode : "block";
}

/** Inserts a job in the caller's tenant transaction. */
export async function insertPiiScanJob(
  client: PoolClient,
  input: CreatePiiScanJobInput & { createdAt?: Date }
): Promise<PiiScanJobRecord> {
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
        run_after,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, COALESCE($11, NOW()), COALESCE($12, NOW()))
      RETURNING *
    `,
    [
      input.tenantId,
      input.jobId ?? uuidv7(),
      input.scanRunId,
      input.subjectType,
      input.subjectId,
      input.sourceSessionId ?? null,
      input.sourceUserId ?? null,
      input.mode,
      JSON.stringify(input.payload ?? {}),
      input.maxAttempts ?? 3,
      input.runAfter ?? null,
      input.createdAt ?? null
    ]
  );
  return mapRow(result.rows[0] as Record<string, unknown>);
}
