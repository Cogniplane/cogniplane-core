import type {
  PolicyDecision,
  PolicyDecisionDetail,
  PolicyDecisionFilters,
  PolicyEffect,
  PolicyMonitorOutcomeCounts,
  PolicyMonitorSummaryResponse,
  PolicySeverity
} from "@cogniplane/shared-types";
import {
  POLICY_DECISIONS_MAX_LIMIT,
  POLICY_DECISIONS_MAX_OFFSET,
  POLICY_DECISIONS_PAGE_SIZE,
  POLICY_MONITOR_SUMMARY_DAYS
} from "@cogniplane/shared-types";

import { type Pool, withTenantScope } from "../../lib/db.js";
import { uuidv7 } from "../../lib/uuid.js";
import { redactSecrets } from "../redact-secrets.js";
import { isoTimestamp, utcMicrosText } from "../../lib/db-mappers.js";

export type PolicyDecisionInput = {
  sessionId: string | null;
  userId: string | null;
  runtimeId: string | null;
  toolName: string;
  toolCategory: string | null;
  severity: PolicySeverity | null;
  serverId: string | null;
  matchedRuleId: string | null;
  outcome: PolicyEffect;
  enforced: boolean;
  explanation: string | null;
  actionSnapshot: Record<string, unknown>;
};

export type PolicyDecisionListResult = {
  decisions: PolicyDecision[];
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
};

// created_at has microsecond precision, but pg parses it into a JS Date, which
// keeps milliseconds only. Every decision query also selects created_at as UTC
// ISO text with six fraction digits. A client can then send createdAt back as
// the `before` bound, and the bound includes every row with that timestamp.
const DECISION_COLUMNS = `*, ${utcMicrosText("created_at")} AS created_at_iso`;

function exactCreatedAt(row: Record<string, unknown>): string {
  if (typeof row.created_at_iso !== "string") {
    throw new TypeError("Expected created_at_iso: select DECISION_COLUMNS");
  }
  return row.created_at_iso;
}

function mapRow(row: Record<string, unknown>): PolicyDecision {
  return {
    decisionId: String(row.decision_id),
    tenantId: String(row.tenant_id),
    sessionId: row.session_id == null ? null : String(row.session_id),
    userId: row.user_id == null ? null : String(row.user_id),
    runtimeId: row.runtime_id == null ? null : String(row.runtime_id),
    toolName: String(row.tool_name),
    toolCategory: row.tool_category == null ? null : String(row.tool_category),
    severity: row.severity == null ? null : (String(row.severity) as PolicySeverity),
    serverId: row.server_id == null ? null : String(row.server_id),
    matchedRuleId: row.matched_rule_id == null ? null : String(row.matched_rule_id),
    outcome: String(row.outcome) as PolicyEffect,
    enforced: Boolean(row.enforced),
    explanation: row.explanation == null ? null : String(row.explanation),
    createdAt: exactCreatedAt(row)
  };
}

function mapDetailRow(row: Record<string, unknown>): PolicyDecisionDetail {
  const snapshot =
    row.action_snapshot_json && typeof row.action_snapshot_json === "object"
      ? (row.action_snapshot_json as Record<string, unknown>)
      : {};
  return {
    ...mapRow(row),
    // Evidence is redacted at write time; re-redact on read so a snapshot field
    // a future caller forgets to scrub can't leak through the detail endpoint.
    // The stored row is never mutated — this only sanitizes the response copy.
    actionSnapshot: redactSecrets(snapshot)
  };
}

/**
 * One UTC day in milliseconds — used to turn the inclusive `to` date filter into
 * a half-open upper bound (created_at < to + 1 day) so the picked end-day counts.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize a `YYYY-MM-DD` (or full ISO) string to an exclusive upper bound at
 * the start of the *next* UTC day. Returns null for an unparseable value.
 */
function toExclusiveUpperBound(value: string): string | null {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    return null;
  }
  return new Date(ts + ONE_DAY_MS).toISOString();
}

// An ISO date-time with more than three fraction digits. Group 1 holds the
// fourth to sixth digits: the microseconds that Date.parse drops. Digits after
// the sixth are below the precision of timestamptz and are ignored.
const SUB_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(\d{1,3})\d*(?:Z|[+-]\d{2}:\d{2})?$/;

/**
 * Normalize a timestamp to a UTC ISO string for an exact bound. Keeps the
 * microseconds of an ISO value, so that a createdAt value from this store
 * selects its own row. Returns null for an unparseable value.
 */
function toExactBound(value: string): string | null {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    return null;
  }
  const iso = new Date(ts).toISOString();
  const micros = SUB_MILLISECOND_PATTERN.exec(value)?.[1];
  return micros ? `${iso.slice(0, -1)}${micros.padEnd(3, "0")}Z` : iso;
}

/** Dedupe + trim a string array; drop empties. Returns undefined when nothing remains. */
function cleanList(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const cleaned = Array.from(new Set(values.map((v) => v.trim()).filter((v) => v.length > 0)));
  return cleaned.length > 0 ? cleaned : undefined;
}

type WhereClause = { sql: string; params: unknown[] };

// Unenforced block or require_approval records. In Monitor mode the gateway
// records gating outcomes with enforced=false. A resource check after a
// completed tool call records require_approval with enforced=false in both
// modes, so this set alone does not prove Monitor mode.
const UNENFORCED_GATING_SQL =
  "enforced = false AND outcome IN ('block', 'require_approval')";

// Resource checks after a completed tool call (routes/sessions.ts) put
// resourceUri in the snapshot.
const RESOURCE_CHECK_SQL = "action_snapshot_json ? 'resourceUri'";

// The `monitor_gateway` evidence set: unenforced gating outcomes that the MCP
// gateway recorded in Monitor mode. Gateway snapshots always carry an
// argumentKeys array (services/mcp/policy-gate.ts); resource checks do not.
// Records without argumentKeys (older or unknown writers) are excluded. The
// list filter and the monitor summary use this one predicate so their counts
// agree. COALESCE keeps the predicate true/false (never NULL) under NOT.
const MONITOR_GATEWAY_EVIDENCE_SQL = `(${UNENFORCED_GATING_SQL}
  AND matched_rule_id IS NOT NULL
  AND COALESCE(jsonb_typeof(action_snapshot_json -> 'argumentKeys') = 'array', false)
  AND NOT (${RESOURCE_CHECK_SQL}))`;

const SUMMARY_WINDOW_MS = POLICY_MONITOR_SUMMARY_DAYS * 24 * 60 * 60 * 1000;

/**
 * Build the shared WHERE clause (and its positional params) once so the page
 * SELECT and the COUNT(*) use identical predicates. `$1` is always tenant_id —
 * kept explicit even under RLS so the planner can use the tenant indexes.
 */
function buildWhere(tenantId: string, filters: PolicyDecisionFilters): WhereClause {
  const conditions: string[] = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  const next = () => `$${params.length + 1}`;

  if (filters.sessionId) {
    conditions.push(`session_id = ${next()}`);
    params.push(filters.sessionId);
  }
  if (filters.matchedRuleId) {
    conditions.push(`matched_rule_id = ${next()}`);
    params.push(filters.matchedRuleId);
  }
  if (filters.evidence === "monitor_gateway") {
    conditions.push(MONITOR_GATEWAY_EVIDENCE_SQL);
  }
  const outcomes = cleanList(filters.outcomes);
  if (outcomes) {
    conditions.push(`outcome = ANY(${next()}::text[])`);
    params.push(outcomes);
  }
  if (filters.enforced !== undefined) {
    conditions.push(`enforced = ${next()}`);
    params.push(filters.enforced);
  }
  const toolNames = cleanList(filters.toolNames);
  if (toolNames) {
    conditions.push(`tool_name = ANY(${next()}::text[])`);
    params.push(toolNames);
  }
  const severities = cleanList(filters.severities);
  if (severities) {
    conditions.push(`severity = ANY(${next()}::text[])`);
    params.push(severities);
  }
  if (filters.from) {
    const lower = toExactBound(filters.from);
    if (lower) {
      conditions.push(`created_at >= ${next()}`);
      params.push(lower);
    }
  }
  if (filters.to) {
    const upper = toExclusiveUpperBound(filters.to);
    if (upper) {
      conditions.push(`created_at < ${next()}`);
      params.push(upper);
    }
  }
  if (filters.before) {
    const upper = toExactBound(filters.before);
    if (upper) {
      conditions.push(`created_at <= ${next()}`);
      params.push(upper);
    }
  }

  return { sql: conditions.join(" AND "), params };
}

export class PolicyDecisionStore {
  constructor(private readonly db: Pool) {}

  async record(tenantId: string, input: PolicyDecisionInput): Promise<PolicyDecision> {
    const decisionId = `pdc_${uuidv7()}`;
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO policy_decision (
            decision_id, tenant_id, session_id, user_id, runtime_id,
            tool_name, tool_category, severity, server_id, matched_rule_id,
            outcome, enforced, explanation, action_snapshot_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
          RETURNING ${DECISION_COLUMNS}
        `,
        [
          decisionId,
          tenantId,
          input.sessionId,
          input.userId,
          input.runtimeId,
          input.toolName,
          input.toolCategory,
          input.severity,
          input.serverId,
          input.matchedRuleId,
          input.outcome,
          input.enforced,
          input.explanation,
          JSON.stringify(input.actionSnapshot ?? {})
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  /**
   * Filtered, paginated evidence list (newest first). Returns the page plus the
   * total matching the filters and the clamped paging actually applied. Reuses a
   * single WHERE for the page SELECT and the COUNT so the two never diverge.
   */
  async list(tenantId: string, filters: PolicyDecisionFilters = {}): Promise<PolicyDecisionListResult> {
    if (filters.from && filters.to) {
      // Compare the bounds the query uses: `to` is exclusive and one day later,
      // so a `from` time on the same day as a date-only `to` is not empty.
      const lower = toExactBound(filters.from);
      const upper = toExclusiveUpperBound(filters.to);
      if (lower !== null && upper !== null && Date.parse(lower) >= Date.parse(upper)) {
        // Empty range: no rows can match. Skip the round-trip.
        const limit = clampLimit(filters.limit);
        const offset = clampOffset(filters.offset);
        return { decisions: [], total: 0, hasMore: false, limit, offset };
      }
    }

    const limit = clampLimit(filters.limit);
    const offset = clampOffset(filters.offset);
    const where = buildWhere(tenantId, filters);

    return withTenantScope(this.db, tenantId, async (client) => {
      const pageResult = await client.query(
        `SELECT ${DECISION_COLUMNS} FROM policy_decision WHERE ${where.sql}
           ORDER BY created_at DESC, id DESC
           LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
        [...where.params, limit, offset]
      );
      const countResult = await client.query(
        `SELECT COUNT(*)::bigint AS total FROM policy_decision WHERE ${where.sql}`,
        where.params
      );
      const total = Number(countResult.rows[0]?.total ?? 0);
      const decisions = pageResult.rows.map(mapRow);
      return {
        decisions,
        total,
        hasMore: offset + decisions.length < total,
        limit,
        offset
      };
    });
  }

  /**
   * Monitor evidence for the seven days that end at `windowEnd`, grouped by the
   * recorded rule ID, with the current rule metadata. Counts every matching row
   * in the database (no paging). The window and evidence predicate are the same
   * ones the list applies for `from`, `before`, and evidence=monitor_gateway.
   */
  async summarizeMonitor(tenantId: string, windowEnd: Date): Promise<PolicyMonitorSummaryResponse> {
    const windowEndIso = windowEnd.toISOString();
    const windowStartIso = new Date(windowEnd.getTime() - SUMMARY_WINDOW_MS).toISOString();
    const where = buildWhere(tenantId, {
      evidence: "monitor_gateway",
      from: windowStartIso,
      before: windowEndIso
    });

    return withTenantScope(this.db, tenantId, async (client) => {
      // The join repeats the tenant predicate so a rule ID can only resolve to
      // this tenant's rule, even without RLS.
      const grouped = await client.query(
        `
          SELECT d.matched_rule_id,
                 d.block_count, d.approval_interactive_count,
                 d.approval_scheduled_count, d.approval_unknown_count,
                 d.total_count, d.last_recorded_at,
                 r.rule_id AS current_rule_id, r.name AS current_name,
                 r.enabled AS current_enabled, r.effect AS current_effect
          FROM (
            SELECT matched_rule_id,
                   COUNT(*) FILTER (WHERE outcome = 'block') AS block_count,
                   COUNT(*) FILTER (WHERE outcome = 'require_approval'
                     AND action_snapshot_json ->> 'turnContext' = 'interactive') AS approval_interactive_count,
                   COUNT(*) FILTER (WHERE outcome = 'require_approval'
                     AND action_snapshot_json ->> 'turnContext' = 'scheduled') AS approval_scheduled_count,
                   COUNT(*) FILTER (WHERE outcome = 'require_approval'
                     AND COALESCE(action_snapshot_json ->> 'turnContext', '') NOT IN ('interactive', 'scheduled')
                   ) AS approval_unknown_count,
                   COUNT(*) AS total_count,
                   MAX(created_at) AS last_recorded_at
            FROM policy_decision
            WHERE ${where.sql}
            GROUP BY matched_rule_id
          ) d
          LEFT JOIN policy_rule r ON r.tenant_id = $1 AND r.rule_id = d.matched_rule_id
          ORDER BY d.total_count DESC, d.block_count DESC, d.matched_rule_id ASC
        `,
        where.params
      );
      const excluded = await client.query(
        `
          SELECT COUNT(*) FILTER (WHERE ${RESOURCE_CHECK_SQL}) AS resource_checks,
                 COUNT(*) FILTER (WHERE NOT (${RESOURCE_CHECK_SQL})) AS unrecognized
          FROM policy_decision
          WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3
            AND ${UNENFORCED_GATING_SQL}
            AND NOT ${MONITOR_GATEWAY_EVIDENCE_SQL}
        `,
        [tenantId, windowStartIso, windowEndIso]
      );

      const totals = emptyCounts();
      const rules = grouped.rows.map((row) => {
        const counts: PolicyMonitorOutcomeCounts = {
          block: Number(row.block_count ?? 0),
          approvalInteractive: Number(row.approval_interactive_count ?? 0),
          approvalScheduled: Number(row.approval_scheduled_count ?? 0),
          approvalUnknownContext: Number(row.approval_unknown_count ?? 0),
          total: Number(row.total_count ?? 0)
        };
        totals.block += counts.block;
        totals.approvalInteractive += counts.approvalInteractive;
        totals.approvalScheduled += counts.approvalScheduled;
        totals.approvalUnknownContext += counts.approvalUnknownContext;
        totals.total += counts.total;
        return {
          ruleId: String(row.matched_rule_id),
          currentRule:
            row.current_rule_id == null
              ? null
              : {
                  name: String(row.current_name),
                  enabled: Boolean(row.current_enabled),
                  effect: String(row.current_effect) as PolicyEffect
                },
          counts,
          lastRecordedAt: isoTimestamp(row.last_recorded_at)
        };
      });
      const excludedRow = excluded.rows[0] ?? {};
      return {
        windowStart: windowStartIso,
        windowEnd: windowEndIso,
        totals,
        rules,
        excluded: {
          resourceChecks: Number(excludedRow.resource_checks ?? 0),
          unrecognized: Number(excludedRow.unrecognized ?? 0)
        }
      };
    });
  }

  /** Full evidence row including the (re-redacted) action snapshot, or null. */
  async get(tenantId: string, decisionId: string): Promise<PolicyDecisionDetail | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT ${DECISION_COLUMNS} FROM policy_decision WHERE tenant_id = $1 AND decision_id = $2 LIMIT 1`,
        [tenantId, decisionId]
      );
      const row = result.rows[0];
      return row ? mapDetailRow(row) : null;
    });
  }
}

function emptyCounts(): PolicyMonitorOutcomeCounts {
  return { block: 0, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 0, total: 0 };
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? POLICY_DECISIONS_PAGE_SIZE, 1), POLICY_DECISIONS_MAX_LIMIT);
}

function clampOffset(offset: number | undefined): number {
  return Math.min(Math.max(offset ?? 0, 0), POLICY_DECISIONS_MAX_OFFSET);
}
