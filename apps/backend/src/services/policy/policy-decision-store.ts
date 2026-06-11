import type {
  PolicyDecision,
  PolicyDecisionDetail,
  PolicyDecisionFilters,
  PolicyEffect,
  PolicySeverity
} from "@cogniplane/shared-types";
import {
  POLICY_DECISIONS_MAX_LIMIT,
  POLICY_DECISIONS_MAX_OFFSET,
  POLICY_DECISIONS_PAGE_SIZE
} from "@cogniplane/shared-types";

import { type Pool, withTenantScope } from "../../lib/db.js";
import { uuidv7 } from "../../lib/uuid.js";
import { redactSecrets } from "../redact-secrets.js";
import { isoTimestamp } from "../../lib/db-mappers.js";

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
    createdAt: isoTimestamp(row.created_at)
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

function toLowerBound(value: string): string | null {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    return null;
  }
  return new Date(ts).toISOString();
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
    const lower = toLowerBound(filters.from);
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
    const beforeTs = Date.parse(filters.before);
    if (!Number.isNaN(beforeTs)) {
      conditions.push(`created_at <= ${next()}`);
      params.push(new Date(beforeTs).toISOString());
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
          RETURNING *
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
      const lo = Date.parse(filters.from);
      const hi = Date.parse(filters.to);
      if (!Number.isNaN(lo) && !Number.isNaN(hi) && lo > hi) {
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
        `SELECT * FROM policy_decision WHERE ${where.sql}
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

  /** Full evidence row including the (re-redacted) action snapshot, or null. */
  async get(tenantId: string, decisionId: string): Promise<PolicyDecisionDetail | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM policy_decision WHERE tenant_id = $1 AND decision_id = $2 LIMIT 1`,
        [tenantId, decisionId]
      );
      const row = result.rows[0];
      return row ? mapDetailRow(row) : null;
    });
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? POLICY_DECISIONS_PAGE_SIZE, 1), POLICY_DECISIONS_MAX_LIMIT);
}

function clampOffset(offset: number | undefined): number {
  return Math.min(Math.max(offset ?? 0, 0), POLICY_DECISIONS_MAX_OFFSET);
}
