import {
  type PolicyConditions,
  type PolicyEffect,
  type PolicyRule,
  type PolicyRuleInput,
  type PolicyRulePatch
} from "@cogniplane/shared-types";

import { type Pool, withTenantScope } from "../../lib/db.js";
import { uuidv7 } from "../../lib/uuid.js";

import type { LintableRule } from "./policy-lint.js";

// Coerce a JSONB dimension to a clean string[] (or undefined when absent).
// Non-array or non-string entries are dropped rather than trusted — the engine
// must never receive a non-array here (it would crash `.includes()` on the
// hot path). An empty result is normalized to undefined ("no constraint").
function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  return entries.length > 0 ? entries : undefined;
}

function toConditions(value: unknown): PolicyConditions {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const conditions: PolicyConditions = {};
  const toolNames = toStringArray(raw.toolNames);
  const categories = toStringArray(raw.categories);
  const severities = toStringArray(raw.severities);
  const turnContexts = toStringArray(raw.turnContexts);
  if (toolNames) conditions.toolNames = toolNames;
  if (categories) conditions.categories = categories;
  if (severities) conditions.severities = severities as PolicyConditions["severities"];
  if (turnContexts) conditions.turnContexts = turnContexts as PolicyConditions["turnContexts"];
  return conditions;
}

function mapRow(row: Record<string, unknown>): PolicyRule {
  return {
    ruleId: String(row.rule_id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    priority: Number(row.priority),
    enabled: Boolean(row.enabled),
    effect: row.effect as PolicyEffect,
    conditions: toConditions(row.conditions_json),
    reason: row.reason == null ? null : String(row.reason),
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

export class PolicyRuleStore {
  constructor(private readonly db: Pool) {}

  /** All rules for a tenant, ordered the way the engine evaluates them. */
  async list(tenantId: string): Promise<PolicyRule[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM policy_rule WHERE tenant_id = $1 ORDER BY priority ASC, rule_id ASC`,
        [tenantId]
      );
      return result.rows.map(mapRow);
    });
  }

  /**
   * Rules for the conflict lint, carrying the RAW `conditions_json` rather than
   * the normalized {@link PolicyRule.conditions}. The lint must see unknown/typo'd
   * dimension keys (e.g. `toolName` for `toolNames`) to warn on them — but
   * {@link mapRow} runs `toConditions()`, which silently drops those keys at the
   * read boundary. Reading the raw JSONB here is what makes the `unknown_condition`
   * warning fire for persisted rules. The known-dimension subset checks behave
   * identically on raw vs. normalized input (both ignore unknown keys), so the
   * shadow/duplicate verdicts are unaffected.
   */
  async listForLint(tenantId: string): Promise<LintableRule[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT rule_id, name, priority, enabled, conditions_json
           FROM policy_rule WHERE tenant_id = $1 ORDER BY priority ASC, rule_id ASC`,
        [tenantId]
      );
      return result.rows.map((row: Record<string, unknown>) => ({
        ruleId: String(row.rule_id),
        name: String(row.name),
        priority: Number(row.priority),
        enabled: Boolean(row.enabled),
        conditions:
          row.conditions_json && typeof row.conditions_json === "object"
            ? (row.conditions_json as PolicyConditions)
            : {}
      }));
    });
  }

  async get(tenantId: string, ruleId: string): Promise<PolicyRule | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM policy_rule WHERE tenant_id = $1 AND rule_id = $2`,
        [tenantId, ruleId]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async create(
    tenantId: string,
    input: PolicyRuleInput,
    createdBy: string | null
  ): Promise<PolicyRule> {
    const ruleId = `pol_${uuidv7()}`;
    // No explicit priority → append to the end of the current evaluation order
    // (max+10) rather than a fixed 100, so a new rule never lands mid-list after
    // a drag-reorder rewrote priorities to index*10.
    const priority = input.priority ?? (await this.nextAppendPriority(tenantId));
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO policy_rule (
            rule_id, tenant_id, name, description, priority, enabled,
            effect, conditions_json, reason, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
          RETURNING *
        `,
        [
          ruleId,
          tenantId,
          input.name,
          input.description ?? null,
          priority,
          input.enabled ?? true,
          input.effect,
          JSON.stringify(input.conditions ?? {}),
          input.reason ?? null,
          createdBy
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  /** Partial update. Only provided fields change; the rest are preserved. */
  async update(
    tenantId: string,
    ruleId: string,
    input: PolicyRulePatch
  ): Promise<PolicyRule | null> {
    const existing = await this.get(tenantId, ruleId);
    if (!existing) return null;

    const next = {
      name: input.name ?? existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      priority: input.priority ?? existing.priority,
      enabled: input.enabled ?? existing.enabled,
      effect: input.effect ?? existing.effect,
      conditions: input.conditions ?? existing.conditions,
      reason: input.reason !== undefined ? input.reason : existing.reason
    };

    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE policy_rule SET
            name = $3,
            description = $4,
            priority = $5,
            enabled = $6,
            effect = $7,
            conditions_json = $8::jsonb,
            reason = $9,
            updated_at = NOW()
          WHERE tenant_id = $1 AND rule_id = $2
          RETURNING *
        `,
        [
          tenantId,
          ruleId,
          next.name,
          next.description,
          next.priority,
          next.enabled,
          next.effect,
          JSON.stringify(next.conditions),
          next.reason
        ]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async delete(tenantId: string, ruleId: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM policy_rule WHERE tenant_id = $1 AND rule_id = $2`,
        [tenantId, ruleId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * Bulk-rewrite rule priorities to match a desired evaluation order. `ruleIds`
   * must be EXACTLY the tenant's current rule set (same members, no duplicates);
   * a mismatch means the caller's view drifted (a rule was created/deleted since
   * they fetched the list), so we reject the whole reorder rather than apply it
   * to a stale set. Priorities are rewritten to index*10 (gaps for future single
   * inserts) and the new ordering is returned. One transaction via the shared
   * tenant-scoped client.
   *
   * Throws {@link PolicyReorderMismatchError} on a set mismatch — the route maps
   * it to a 409 so the UI can refetch and retry.
   */
  async reorder(tenantId: string, ruleIds: readonly string[]): Promise<PolicyRule[]> {
    if (new Set(ruleIds).size !== ruleIds.length) {
      throw new PolicyReorderMismatchError("ruleIds must not contain duplicates.");
    }
    return withTenantScope(this.db, tenantId, async (client) => {
      const existing = await client.query(
        `SELECT rule_id FROM policy_rule WHERE tenant_id = $1`,
        [tenantId]
      );
      const existingIds = new Set(existing.rows.map((row) => String(row.rule_id)));
      if (existingIds.size !== ruleIds.length || ruleIds.some((id) => !existingIds.has(id))) {
        throw new PolicyReorderMismatchError(
          "ruleIds must be exactly the tenant's current set of policy rules."
        );
      }

      for (let index = 0; index < ruleIds.length; index += 1) {
        await client.query(
          `UPDATE policy_rule SET priority = $3, updated_at = NOW() WHERE tenant_id = $1 AND rule_id = $2`,
          [tenantId, ruleIds[index], index * 10]
        );
      }

      const result = await client.query(
        `SELECT * FROM policy_rule WHERE tenant_id = $1 ORDER BY priority ASC, rule_id ASC`,
        [tenantId]
      );
      return result.rows.map(mapRow);
    });
  }

  /**
   * The priority a newly-created rule should take to land at the END of the
   * tenant's current evaluation order: max(priority)+10, or 0 for the first
   * rule. Without this a new rule defaults to a fixed priority and can land in
   * the middle of a reordered list (which uses index*10 priorities).
   */
  async nextAppendPriority(tenantId: string): Promise<number> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT COALESCE(MAX(priority), -10) + 10 AS next FROM policy_rule WHERE tenant_id = $1`,
        [tenantId]
      );
      return Number(result.rows[0]?.next ?? 0);
    });
  }
}

// Raised by reorder() when the supplied rule-ID set doesn't match the tenant's
// current rules. The route turns this into a 409 (conflict) so the client knows
// to refetch and retry rather than treating it as a generic 500.
export class PolicyReorderMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyReorderMismatchError";
  }
}
