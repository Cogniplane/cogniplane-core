import { type Pool, withTenantScope } from "../lib/db.js";

/**
 * Tracks Tier 3 LLM judgment submissions per (tenant, session, judgment_kind).
 * One row covers both sync and batch flows:
 *
 *   * sync mode: the worker inserts with status='running', calls the provider
 *     in the same tick, and updates to 'completed'/'failed'. batch_id is
 *     NULL or the provider's request id (for traceability only — sync
 *     submissions cannot be "polled later").
 *   * batch mode: the worker inserts with status='submitted' and a real
 *     batch_id; a separate poller pass walks `listInflight()` and calls
 *     `markCompleted` once results are ready.
 *
 * Two cross-tenant operations on the privileged DB:
 *   - listSessionsToJudge: which (tenant, session) pairs are eligible
 *     across the whole platform (the worker iterates these per tick).
 *   - listInflight:        which judgments are still pending across all
 *     tenants (the batch poller's work queue).
 *
 * All tenant-scoped writes go through `withTenantScope`, mirroring every
 * other store. A session row is inserted as the worker claims it; the
 * (tenant_id, session_id, judgment_kind) PK guarantees the worker cannot
 * re-judge the same session on a subsequent tick unless the row is
 * explicitly cleared.
 */

export type JudgmentKind = "skill_invocation";

export type SessionJudgmentStatus = "submitted" | "running" | "completed" | "failed";
export type SessionJudgmentMode = "sync" | "batch";

export type SessionJudgmentRecord = {
  tenantId: string;
  sessionId: string;
  judgmentKind: JudgmentKind;
  provider: string;
  model: string;
  mode: SessionJudgmentMode;
  batchId: string | null;
  status: SessionJudgmentStatus;
  submittedAt: string;
  completedAt: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
};

export type EligibleSession = {
  tenantId: string;
  sessionId: string;
  userId: string;
  /** Tenant's configured judge — already filtered to non-null providers. */
  provider: string;
  model: string;
  mode: SessionJudgmentMode;
};

function mapJudgmentRow(row: Record<string, unknown>): SessionJudgmentRecord {
  return {
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    judgmentKind: String(row.judgment_kind) as JudgmentKind,
    provider: String(row.provider),
    model: String(row.model),
    mode: row.mode === "batch" ? "batch" : "sync",
    batchId: row.batch_id ? String(row.batch_id) : null,
    status: String(row.status) as SessionJudgmentStatus,
    submittedAt: new Date(String(row.submitted_at)).toISOString(),
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
    error: row.error ? String(row.error) : null,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {}
  };
}

export class SessionJudgmentStore {
  constructor(
    private readonly db: Pool,
    /**
     * Cross-tenant scans require RLS to be off; default to the same pool the
     * tenant-scoped writes use so tests and dev environments work without
     * any extra wiring. In production, callers pass the privileged pool.
     */
    private readonly schedulerDb: Pool = db
  ) {}

  /**
   * Sessions that should be judged on the next worker tick. Returns one row
   * per (tenant, session, configured judge). Excludes sessions that already
   * have a judgment row for the same `judgmentKind` (regardless of status —
   * we don't retry failures automatically; that's an admin action).
   *
   * `inactiveBeforeMs` is the cutoff for "session is done": only sessions
   * with no message activity newer than `now - inactiveBeforeMs` are eligible.
   */
  async listSessionsToJudge(
    judgmentKind: JudgmentKind,
    inactiveBeforeMs: number,
    limit: number,
    tenantId?: string
  ): Promise<EligibleSession[]> {
    const params: unknown[] = [inactiveBeforeMs, judgmentKind, limit];
    let tenantClause = "";
    if (tenantId) {
      params.push(tenantId);
      tenantClause = `AND s.tenant_id = $${params.length}`;
    }

    const result = await this.schedulerDb.query(
      `
        SELECT
          s.tenant_id,
          s.session_id,
          s.user_id,
          ts.skill_judge_provider AS provider,
          ts.skill_judge_model    AS model,
          ts.skill_judge_mode     AS mode
        FROM sessions s
        JOIN tenant_settings ts ON ts.tenant_id = s.tenant_id
        WHERE ts.skill_judge_enabled  = true
          AND ts.skill_judge_provider IS NOT NULL
          AND ts.skill_judge_model    IS NOT NULL
          AND s.status = 'active'
          AND s.updated_at < NOW() - ($1::bigint || ' milliseconds')::interval
          AND NOT EXISTS (
            SELECT 1 FROM session_judgments j
            WHERE j.tenant_id = s.tenant_id
              AND j.session_id = s.session_id
              AND j.judgment_kind = $2
          )
          AND EXISTS (
            SELECT 1 FROM messages m
            WHERE m.tenant_id = s.tenant_id
              AND m.session_id = s.session_id
              AND m.role = 'assistant'
          )
          ${tenantClause}
        ORDER BY s.updated_at ASC
        LIMIT $3
      `,
      params
    );

    return result.rows.map((row) => ({
      tenantId: String(row.tenant_id),
      sessionId: String(row.session_id),
      userId: String(row.user_id),
      provider: String(row.provider),
      model: String(row.model),
      mode: row.mode === "batch" ? "batch" : "sync"
    }));
  }

  /**
   * Insert a placeholder row for a freshly-claimed session. Returns null when
   * another worker raced us to the insert (a duplicate-key violation maps to
   * "someone else owns this judgment now").
   */
  async claim(input: {
    tenantId: string;
    sessionId: string;
    judgmentKind: JudgmentKind;
    provider: string;
    model: string;
    mode: SessionJudgmentMode;
  }): Promise<SessionJudgmentRecord | null> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const initialStatus: SessionJudgmentStatus = input.mode === "sync" ? "running" : "submitted";
      const result = await client.query(
        `
          INSERT INTO session_judgments (
            tenant_id, session_id, judgment_kind, provider, model, mode, status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (tenant_id, session_id, judgment_kind) DO NOTHING
          RETURNING *
        `,
        [
          input.tenantId,
          input.sessionId,
          input.judgmentKind,
          input.provider,
          input.model,
          input.mode,
          initialStatus
        ]
      );
      return result.rows[0] ? mapJudgmentRow(result.rows[0]) : null;
    });
  }

  async markSubmitted(input: {
    tenantId: string;
    sessionId: string;
    judgmentKind: JudgmentKind;
    batchId: string;
  }): Promise<SessionJudgmentRecord | null> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE session_judgments
          SET batch_id = $4, status = 'submitted'
          WHERE tenant_id = $1 AND session_id = $2 AND judgment_kind = $3
          RETURNING *
        `,
        [input.tenantId, input.sessionId, input.judgmentKind, input.batchId]
      );
      return result.rows[0] ? mapJudgmentRow(result.rows[0]) : null;
    });
  }

  async markCompleted(input: {
    tenantId: string;
    sessionId: string;
    judgmentKind: JudgmentKind;
    metadata?: Record<string, unknown>;
  }): Promise<SessionJudgmentRecord | null> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE session_judgments
          SET status = 'completed',
              completed_at = NOW(),
              metadata = COALESCE($4::jsonb, metadata)
          WHERE tenant_id = $1 AND session_id = $2 AND judgment_kind = $3
          RETURNING *
        `,
        [
          input.tenantId,
          input.sessionId,
          input.judgmentKind,
          input.metadata ? JSON.stringify(input.metadata) : null
        ]
      );
      return result.rows[0] ? mapJudgmentRow(result.rows[0]) : null;
    });
  }

  async markFailed(input: {
    tenantId: string;
    sessionId: string;
    judgmentKind: JudgmentKind;
    error: string;
  }): Promise<SessionJudgmentRecord | null> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE session_judgments
          SET status = 'failed', completed_at = NOW(), error = $4
          WHERE tenant_id = $1 AND session_id = $2 AND judgment_kind = $3
          RETURNING *
        `,
        [input.tenantId, input.sessionId, input.judgmentKind, input.error]
      );
      return result.rows[0] ? mapJudgmentRow(result.rows[0]) : null;
    });
  }

  /**
   * Demote `running` sync rows older than `olderThanMs` to `failed`. These
   * are orphans — the worker crashed or was killed mid-call before it could
   * write `markCompleted`/`markFailed`. Without a reaper they pile up
   * forever, blocking those sessions from being re-judged.
   *
   * Only `running` (sync) rows are touched. Batch rows hold `submitted` for
   * legitimately long stretches (Anthropic Batch can take up to 24h) and
   * have their own poll loop.
   *
   * Cross-tenant via `schedulerDb` so a single sweep covers everyone.
   * Returns the row count for logging.
   */
  async reapStuckRunningRows(olderThanMs: number): Promise<number> {
    const result = await this.schedulerDb.query<{ count: string }>(
      `
        WITH demoted AS (
          UPDATE session_judgments
          SET status = 'failed',
              completed_at = NOW(),
              error = COALESCE(error, '') ||
                CASE WHEN error IS NULL OR error = '' THEN '' ELSE ' | ' END ||
                'reaped: running for more than ' || ($1::bigint / 1000) || 's'
          WHERE status = 'running'
            AND submitted_at < NOW() - ($1::bigint || ' milliseconds')::interval
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM demoted
      `,
      [olderThanMs]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Cross-tenant scan over judgments still in flight. **Worker only** — the
   * batch poller needs to see every tenant's pending work in one pass. Admin
   * routes must use `listInflightForTenant` so the tenant filter runs in SQL
   * instead of being applied after rows have crossed tenancy boundaries in
   * memory. Sync rows transition out of `running` in the same tick they
   * were claimed, so this query naturally surfaces only batch work in
   * production.
   */
  async listInflight(limit: number): Promise<SessionJudgmentRecord[]> {
    const result = await this.schedulerDb.query(
      `
        SELECT *
        FROM session_judgments
        WHERE status IN ('submitted', 'running')
        ORDER BY submitted_at ASC
        LIMIT $1
      `,
      [limit]
    );
    return result.rows.map(mapJudgmentRow);
  }

  /**
   * Tenant-scoped variant of `listInflight` for admin dashboards. Filters in
   * SQL so cross-tenant rows never enter the route's response-building scope.
   */
  async listInflightForTenant(
    tenantId: string,
    limit: number
  ): Promise<SessionJudgmentRecord[]> {
    const result = await this.schedulerDb.query(
      `
        SELECT *
        FROM session_judgments
        WHERE status IN ('submitted', 'running')
          AND tenant_id = $2
        ORDER BY submitted_at ASC
        LIMIT $1
      `,
      [limit, tenantId]
    );
    return result.rows.map(mapJudgmentRow);
  }

  /**
   * Group inflight rows by `(provider, model, batch_id)`. Each group is
   * exactly the set of sessions one batch covers, so the poller can call
   * `provider.poll(batchId, sessionIds)` once per group instead of once per
   * row. Sessions whose judgment was claimed but never associated with a
   * batch (i.e. status='running' with NULL batch_id) are ignored — they're
   * either in-flight sync requests or rows the worker will retry.
   */
  async listInflightBatches(limit: number): Promise<InflightBatch[]> {
    const rows = await this.listInflight(limit);
    const groups = new Map<string, InflightBatch>();
    for (const row of rows) {
      if (!row.batchId) continue;
      const key = `${row.provider}|${row.model}|${row.batchId}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          provider: row.provider,
          model: row.model,
          batchId: row.batchId,
          submittedAt: row.submittedAt,
          sessions: []
        };
        groups.set(key, group);
      }
      group.sessions.push({
        tenantId: row.tenantId,
        sessionId: row.sessionId,
        judgmentKind: row.judgmentKind
      });
    }
    return Array.from(groups.values());
  }
}

export type InflightBatch = {
  provider: string;
  model: string;
  batchId: string;
  submittedAt: string;
  sessions: Array<{ tenantId: string; sessionId: string; judgmentKind: JudgmentKind }>;
};
