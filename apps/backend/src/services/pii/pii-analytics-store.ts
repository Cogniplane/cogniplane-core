// Read-only analytics aggregates for the admin PII dashboard. Each method
// runs through `withTenantScope` so RLS gates the underlying tables —
// `PiiScanRunStore` owns per-row CRUD; this store owns the dashboard
// aggregations.

import { type Pool, withTenantScope } from "../../lib/db.js";

import type {
  ConfidenceRow,
  EntityCount,
  RecentActionToken,
  ResolvedRange,
  SubjectRow,
  TimeSeriesPoint
} from "../../routes/admin/admin-pii-schemas.js";

export type KpiRow = {
  scans: number;
  findings: number;
  blocked: number;
  transformed: number;
  failed: number;
};

export type TopUserRow = {
  userId: string;
  findingsTotal: number;
  sessionsCount: number;
  blockCount: number;
  transformCount: number;
  failedCount: number;
  lastSeenAt: string | null;
};

export type TopSessionRow = {
  sessionId: string;
  userId: string | null;
  findingsTotal: number;
  actionMix: { allow: number; report: number; block: number; transform: number; failed: number };
  lastActivityAt: string | null;
};

export type RecentActivityRow = {
  scanRunId: string;
  createdAt: string;
  completedAt: string | null;
  subjectType: string;
  subjectId: string;
  sessionId: string | null;
  userId: string | null;
  mode: string;
  actionTaken: string | null;
  status: string;
  providerType: string | null;
  providerModel: string | null;
  findingsCount: number;
  errorMessage: string | null;
  entityTypes: string[];
};

export type QueueStats = {
  queued: number;
  claimed: number;
  completed: number;
  failed: number;
  oldestQueuedAt: string | null;
  maxAttemptsHit: number;
};

export type LatencyPercentilesRow = {
  subjectType: string;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  sampleCount: number;
};

export type TopErrorRow = { message: string; count: number };

export class PiiAnalyticsStore {
  constructor(private readonly db: Pool) {}

  async getKpis(tenantId: string, from: Date, to: Date): Promise<KpiRow> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT
            COUNT(*)::int AS scans,
            COALESCE(SUM(jsonb_array_length(findings_json)), 0)::int AS findings,
            COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
            COUNT(*) FILTER (WHERE status = 'transformed')::int AS transformed,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM pii_scan_runs
          WHERE created_at >= $1 AND created_at < $2
        `,
        [from, to]
      );
      const row = (result.rows[0] ?? {}) as Record<string, unknown>;
      return {
        scans: Number(row.scans ?? 0),
        findings: Number(row.findings ?? 0),
        blocked: Number(row.blocked ?? 0),
        transformed: Number(row.transformed ?? 0),
        failed: Number(row.failed ?? 0)
      };
    });
  }

  async getTimeSeries(tenantId: string, range: ResolvedRange): Promise<TimeSeriesPoint[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      // generate_series gives us zero-filled buckets so the frontend chart
      // doesn't need to gap-fill. action_taken is NULL for status='failed'
      // (failed scans never reach a decision), so we count them separately.
      const result = await client.query(
        `
          WITH buckets AS (
            SELECT generate_series(
              date_trunc($3, $1::timestamptz),
              date_trunc($3, $2::timestamptz - INTERVAL '1 microsecond'),
              ('1 ' || $3)::interval
            ) AS bucket
          ),
          scans AS (
            SELECT
              date_trunc($3, created_at) AS bucket,
              status,
              action_taken
            FROM pii_scan_runs
            WHERE created_at >= $1 AND created_at < $2
          )
          SELECT
            b.bucket,
            COUNT(*) FILTER (WHERE s.action_taken = 'allow')::int      AS allow,
            COUNT(*) FILTER (WHERE s.action_taken = 'report')::int     AS report,
            COUNT(*) FILTER (WHERE s.action_taken = 'block')::int      AS block,
            COUNT(*) FILTER (WHERE s.action_taken = 'transform')::int  AS transform,
            COUNT(*) FILTER (WHERE s.status = 'failed')::int           AS failed
          FROM buckets b
          LEFT JOIN scans s ON s.bucket = b.bucket
          GROUP BY b.bucket
          ORDER BY b.bucket
        `,
        [range.from, range.to, range.bucket]
      );
      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          bucket: new Date(String(row.bucket)).toISOString(),
          allow: Number(row.allow ?? 0),
          report: Number(row.report ?? 0),
          block: Number(row.block ?? 0),
          transform: Number(row.transform ?? 0),
          failed: Number(row.failed ?? 0)
        };
      });
    });
  }

  async getByEntityType(tenantId: string, from: Date, to: Date): Promise<EntityCount[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT
            finding->>'entityType' AS entity_type,
            COUNT(*)::int          AS count
          FROM pii_scan_runs,
            LATERAL jsonb_array_elements(findings_json) AS finding
          WHERE created_at >= $1 AND created_at < $2
            AND finding->>'entityType' IS NOT NULL
          GROUP BY finding->>'entityType'
          ORDER BY count DESC, entity_type
        `,
        [from, to]
      );
      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return { entityType: String(row.entity_type), count: Number(row.count ?? 0) };
      });
    });
  }

  async getByConfidence(tenantId: string, from: Date, to: Date): Promise<ConfidenceRow[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          WITH confidence_counts AS (
            SELECT
              finding->>'entityType' AS entity_type,
              COUNT(*) FILTER (WHERE finding->>'confidence' = 'high')::int   AS high,
              COUNT(*) FILTER (WHERE finding->>'confidence' = 'medium')::int AS medium,
              COUNT(*) FILTER (WHERE finding->>'confidence' = 'low')::int    AS low
            FROM pii_scan_runs,
              LATERAL jsonb_array_elements(findings_json) AS finding
            WHERE created_at >= $1 AND created_at < $2
              AND finding->>'entityType' IS NOT NULL
            GROUP BY finding->>'entityType'
          )
          SELECT
            entity_type,
            high,
            medium,
            low
          FROM confidence_counts
          ORDER BY (high + medium + low) DESC, entity_type
        `,
        [from, to]
      );
      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          entityType: String(row.entity_type),
          high: Number(row.high ?? 0),
          medium: Number(row.medium ?? 0),
          low: Number(row.low ?? 0)
        };
      });
    });
  }

  async getBySubjectType(tenantId: string, from: Date, to: Date): Promise<SubjectRow[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT subject_type, COUNT(*)::int AS count
          FROM pii_scan_runs
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY subject_type
          ORDER BY subject_type
        `,
        [from, to]
      );
      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return { subjectType: String(row.subject_type), count: Number(row.count ?? 0) };
      });
    });
  }

  // Both top-* helpers exclude pending/processing scans because those rows
  // represent in-flight work — counting them would double-attribute findings
  // once the scan completes. The terminal states (completed/failed/blocked/
  // transformed) are the only signal worth ranking on.
  async getTopByUser(
    tenantId: string,
    from: Date,
    to: Date,
    limit: number
  ): Promise<TopUserRow[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT
            source_user_id                                        AS user_id,
            COALESCE(SUM(jsonb_array_length(findings_json)), 0)::int AS findings_total,
            COUNT(DISTINCT source_session_id)::int                AS sessions_count,
            COUNT(*) FILTER (WHERE status = 'blocked')::int       AS block_count,
            COUNT(*) FILTER (WHERE status = 'transformed')::int   AS transform_count,
            COUNT(*) FILTER (WHERE status = 'failed')::int        AS failed_count,
            MAX(created_at)                                       AS last_seen_at
          FROM pii_scan_runs
          WHERE created_at >= $1 AND created_at < $2
            AND source_user_id IS NOT NULL
            AND status NOT IN ('pending', 'processing')
          GROUP BY source_user_id
          ORDER BY findings_total DESC, last_seen_at DESC
          LIMIT $3
        `,
        [from, to, limit]
      );
      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          userId: String(row.user_id),
          findingsTotal: Number(row.findings_total ?? 0),
          sessionsCount: Number(row.sessions_count ?? 0),
          blockCount: Number(row.block_count ?? 0),
          transformCount: Number(row.transform_count ?? 0),
          failedCount: Number(row.failed_count ?? 0),
          lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)).toISOString() : null
        };
      });
    });
  }

  async getTopBySession(
    tenantId: string,
    from: Date,
    to: Date,
    limit: number
  ): Promise<TopSessionRow[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT
            source_session_id                                     AS session_id,
            (ARRAY_AGG(source_user_id ORDER BY created_at DESC)
              FILTER (WHERE source_user_id IS NOT NULL))[1]       AS user_id,
            COALESCE(SUM(jsonb_array_length(findings_json)), 0)::int AS findings_total,
            COUNT(*) FILTER (WHERE action_taken = 'allow')::int   AS allow_count,
            COUNT(*) FILTER (WHERE action_taken = 'report')::int  AS report_count,
            COUNT(*) FILTER (WHERE status = 'blocked')::int       AS block_count,
            COUNT(*) FILTER (WHERE status = 'transformed')::int   AS transform_count,
            COUNT(*) FILTER (WHERE status = 'failed')::int        AS failed_count,
            MAX(created_at)                                       AS last_activity_at
          FROM pii_scan_runs
          WHERE created_at >= $1 AND created_at < $2
            AND source_session_id IS NOT NULL
            AND status NOT IN ('pending', 'processing')
          GROUP BY source_session_id
          ORDER BY findings_total DESC, last_activity_at DESC
          LIMIT $3
        `,
        [from, to, limit]
      );
      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          sessionId: String(row.session_id),
          userId: row.user_id ? String(row.user_id) : null,
          findingsTotal: Number(row.findings_total ?? 0),
          actionMix: {
            allow: Number(row.allow_count ?? 0),
            report: Number(row.report_count ?? 0),
            block: Number(row.block_count ?? 0),
            transform: Number(row.transform_count ?? 0),
            failed: Number(row.failed_count ?? 0)
          },
          lastActivityAt: row.last_activity_at
            ? new Date(String(row.last_activity_at)).toISOString()
            : null
        };
      });
    });
  }

  async getRecentActivity(
    tenantId: string,
    from: Date,
    to: Date,
    actions: RecentActionToken[],
    limit: number
  ): Promise<RecentActivityRow[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      // Recent feed has no native "action filter" in the schema —
      // action_taken is `allow|report|block|transform` and `failed` is a
      // status. We pass two arrays so the WHERE clause can OR them: rows
      // match either an action_taken value or a 'failed' status. Empty
      // arrays make the predicate effectively false so we never return
      // everything by accident.
      const actionTakenValues = actions.filter((a) => a !== "failed");
      const includeFailed = actions.includes("failed");

      const result = await client.query(
        `
          SELECT
            scan_run_id,
            created_at,
            completed_at,
            subject_type,
            subject_id,
            source_session_id,
            source_user_id,
            mode,
            action_taken,
            status,
            provider_type,
            provider_model,
            jsonb_array_length(findings_json)::int AS findings_count,
            error_message,
            (
              SELECT COALESCE(
                jsonb_agg(DISTINCT entity_type ORDER BY entity_type)
                  FILTER (WHERE entity_type IS NOT NULL),
                '[]'::jsonb
              )
              FROM jsonb_array_elements(findings_json) AS f,
                LATERAL (SELECT f->>'entityType' AS entity_type) e
            ) AS entity_types
          FROM pii_scan_runs
          WHERE created_at >= $1 AND created_at < $2
            AND (
              action_taken = ANY($3::text[])
              OR ($4::boolean AND status = 'failed')
            )
          ORDER BY created_at DESC
          LIMIT $5
        `,
        [from, to, actionTakenValues, includeFailed, limit]
      );

      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        const rawEntityTypes = row.entity_types;
        let entityTypes: string[] = [];
        if (Array.isArray(rawEntityTypes)) {
          entityTypes = rawEntityTypes as string[];
        } else if (typeof rawEntityTypes === "string") {
          try {
            const parsed = JSON.parse(rawEntityTypes);
            if (Array.isArray(parsed)) entityTypes = parsed as string[];
          } catch {
            entityTypes = [];
          }
        }
        return {
          scanRunId: String(row.scan_run_id),
          createdAt: new Date(String(row.created_at)).toISOString(),
          completedAt: row.completed_at
            ? new Date(String(row.completed_at)).toISOString()
            : null,
          subjectType: String(row.subject_type),
          subjectId: String(row.subject_id),
          sessionId: row.source_session_id ? String(row.source_session_id) : null,
          userId: row.source_user_id ? String(row.source_user_id) : null,
          mode: String(row.mode),
          actionTaken: row.action_taken ? String(row.action_taken) : null,
          status: String(row.status),
          providerType: row.provider_type ? String(row.provider_type) : null,
          providerModel: row.provider_model ? String(row.provider_model) : null,
          findingsCount: Number(row.findings_count ?? 0),
          errorMessage: row.error_message ? String(row.error_message) : null,
          entityTypes
        };
      });
    });
  }

  // Queue stats are point-in-time, not range-bounded — operators want to see
  // what's queued NOW, not "what was queued in the last 7 days." That's why
  // this method takes no range argument.
  async getQueueStats(tenantId: string): Promise<QueueStats> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT
            COUNT(*) FILTER (WHERE status = 'queued')::int    AS queued,
            COUNT(*) FILTER (WHERE status = 'claimed')::int   AS claimed,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
            COUNT(*) FILTER (WHERE status = 'failed')::int    AS failed,
            MIN(created_at) FILTER (WHERE status = 'queued')  AS oldest_queued_at,
            COUNT(*) FILTER (WHERE attempts >= max_attempts)::int AS max_attempts_hit
          FROM pii_scan_jobs
        `
      );
      const row = (result.rows[0] ?? {}) as Record<string, unknown>;
      return {
        queued: Number(row.queued ?? 0),
        claimed: Number(row.claimed ?? 0),
        completed: Number(row.completed ?? 0),
        failed: Number(row.failed ?? 0),
        oldestQueuedAt: row.oldest_queued_at
          ? new Date(String(row.oldest_queued_at)).toISOString()
          : null,
        maxAttemptsHit: Number(row.max_attempts_hit ?? 0)
      };
    });
  }

  async getLatencyPercentiles(
    tenantId: string,
    from: Date,
    to: Date
  ): Promise<LatencyPercentilesRow[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      // percentile_cont over (completed_at - created_at) milliseconds, split
      // by subject type. Include every terminal state that represents a real
      // end-to-end measurement: 'completed' (allow / report), 'blocked', and
      // 'transformed'. 'failed' is excluded — those rows have completed_at
      // set but the elapsed time is dominated by retry/timeout, not real
      // scan work, and would skew perf numbers operators care about.
      const result = await client.query(
        `
          SELECT
            subject_type,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000
            ) AS p50_ms,
            percentile_cont(0.95) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000
            ) AS p95_ms,
            percentile_cont(0.99) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000
            ) AS p99_ms,
            COUNT(*)::int AS sample_count
          FROM pii_scan_runs
          WHERE created_at >= $1 AND created_at < $2
            AND status IN ('completed', 'blocked', 'transformed')
            AND completed_at IS NOT NULL
          GROUP BY subject_type
          ORDER BY subject_type
        `,
        [from, to]
      );
      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          subjectType: String(row.subject_type),
          p50Ms: row.p50_ms == null ? null : Number(row.p50_ms),
          p95Ms: row.p95_ms == null ? null : Number(row.p95_ms),
          p99Ms: row.p99_ms == null ? null : Number(row.p99_ms),
          sampleCount: Number(row.sample_count ?? 0)
        };
      });
    });
  }

  async getTopErrors(tenantId: string, from: Date, to: Date): Promise<TopErrorRow[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      // Group on the trimmed message — provider exceptions often differ in
      // IDs / timestamps and would otherwise bucket as separate errors.
      // Truncating to 200 chars matches the trade-off the rest of the
      // codebase makes for human-facing error displays.
      const result = await client.query(
        `
          SELECT
            LEFT(error_message, 200) AS message,
            COUNT(*)::int            AS count
          FROM pii_scan_runs
          WHERE created_at >= $1 AND created_at < $2
            AND status = 'failed'
            AND error_message IS NOT NULL
          GROUP BY LEFT(error_message, 200)
          ORDER BY count DESC, message
          LIMIT 5
        `,
        [from, to]
      );
      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          message: String(row.message ?? ""),
          count: Number(row.count ?? 0)
        };
      });
    });
  }
}
