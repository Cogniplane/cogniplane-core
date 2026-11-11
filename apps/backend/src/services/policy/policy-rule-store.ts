import {
  type PolicyConditions,
  type PolicyEffect,
  type PolicyRule,
  type PolicyRuleInput,
  type PolicyRulePatch
} from "@cogniplane/shared-types";

import type { PoolClient } from "pg";
import { type Pool, withTenantScope } from "../../lib/db.js";
import { uuidv7 } from "../../lib/uuid.js";

import type { LintableRule } from "./policy-lint.js";
import { weakensPolicy } from "./policy-weakening.js";
import { isoTimestamp } from "../../lib/db-mappers.js";
import { AuditEventStore, type AuditEventInput } from "../audit-event-store.js";
import { WeakerChangeError } from "../weaker-change-error.js";

// Coerce a JSONB dimension to a clean string[]. A value that is not an array,
// or an empty result, becomes undefined ("no constraint"). Non-string entries are
// dropped. The engine must never get a non-array, because `.includes()` would
// crash on the hot path.
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
    revision: Number(row.revision),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

/**
 * How a rule change is written. Each write classifies the change in its own
 * transaction, under the tenant's rule lock, against the rules as they are
 * then (policy-weakening.ts). A change that makes the policy weaker throws
 * WeakerChangeError and rolls back, unless `allowWeaker` (the caller has
 * step-up, or needs none). The audit event, when given, commits in the same
 * transaction, with its owner notice (AuditEventInput.alsoInTransaction);
 * `weaker` tells the caller whether to attach the notice.
 */
export type PolicyRuleWriteOptions<T> = {
  allowWeaker: boolean;
  audit?: (saved: T, weaker: boolean) => AuditEventInput;
};

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
    createdBy: string | null,
    options: PolicyRuleWriteOptions<PolicyRule>
  ): Promise<PolicyRule> {
    const ruleId = `pol_${uuidv7()}`;
    return withTenantScope(this.db, tenantId, async (client) => {
      await lockPolicyRules(client, tenantId);
      const before = await rulesOf(client, tenantId);
      // No explicit priority: append to the end of the current evaluation order
      // (max + 10). A fixed value could land mid-list after a reorder set the
      // priorities to index * 10. Read under the lock, so two concurrent creates
      // do not take the same priority.
      const priority = input.priority ?? (await appendPriority(client, tenantId));
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
      const rule = mapRow(result.rows[0]);
      const weaker = weakensPolicy(before, [...before, rule], [rule]);
      return finish(client, rule, weaker, options);
    });
  }

  /**
   * Partial update. Only provided fields change; the rest are preserved.
   *
   * `input.expectedRevision` is the revision that the change is based on. When
   * the rule has another revision, the update throws PolicyRuleConflictError
   * and writes nothing: no change, no audit event, no owner notice. The check
   * runs before the weaker-change check, so a stale save never asks for
   * step-up. A saved change adds 1 to the revision.
   */
  async update(
    tenantId: string,
    ruleId: string,
    input: PolicyRulePatch,
    options: PolicyRuleWriteOptions<PolicyRule>
  ): Promise<PolicyRule | null> {
    // Read and write in one locked transaction, so two partial updates (or an
    // update and a reorder) cannot overwrite each other's fields, and of two
    // saves from the same revision only the first is stored.
    return withTenantScope(this.db, tenantId, async (client) => {
      await lockPolicyRules(client, tenantId);
      const before = await rulesOf(client, tenantId);
      const existing = before.find((rule) => rule.ruleId === ruleId);
      if (!existing) return null;
      if (existing.revision !== input.expectedRevision) throw new PolicyRuleConflictError();

      const next = {
        name: input.name ?? existing.name,
        description: input.description !== undefined ? input.description : existing.description,
        priority: input.priority ?? existing.priority,
        enabled: input.enabled ?? existing.enabled,
        effect: input.effect ?? existing.effect,
        conditions: input.conditions ?? existing.conditions,
        reason: input.reason !== undefined ? input.reason : existing.reason
      };

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
            revision = revision + 1,
            updated_at = NOW()
          WHERE tenant_id = $1 AND rule_id = $2 AND revision = $10
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
          next.reason,
          input.expectedRevision
        ]
      );
      // Every store write takes the rule lock. The revision in the WHERE
      // clause also refuses a change that a writer without the lock committed
      // after the read above (the UPDATE reads the newest row version).
      if (!result.rows[0]) throw new PolicyRuleConflictError();
      const rule = mapRow(result.rows[0]);
      const after = before.map((candidate) => (candidate.ruleId === ruleId ? rule : candidate));
      const weaker = weakensPolicy(before, after, [existing, rule]);
      return finish(client, rule, weaker, options);
    });
  }

  async delete(
    tenantId: string,
    ruleId: string,
    options: PolicyRuleWriteOptions<PolicyRule>
  ): Promise<PolicyRule | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      await lockPolicyRules(client, tenantId);
      const before = await rulesOf(client, tenantId);
      const existing = before.find((rule) => rule.ruleId === ruleId);
      if (!existing) return null;
      const result = await client.query(
        `DELETE FROM policy_rule WHERE tenant_id = $1 AND rule_id = $2`,
        [tenantId, ruleId]
      );
      if ((result.rowCount ?? 0) === 0) return null;
      const after = before.filter((rule) => rule.ruleId !== ruleId);
      const weaker = weakensPolicy(before, after, [existing]);
      return finish(client, existing, weaker, options);
    });
  }

  /**
   * Bulk-rewrite rule priorities to match a desired evaluation order. `ruleIds`
   * must be EXACTLY the tenant's current rule set (same members, no duplicates);
   * a mismatch means the caller's view drifted (a rule was created/deleted since
   * they fetched the list), so we reject the whole reorder rather than apply it
   * to a stale set. It rewrites priorities to index*10 (gaps for future single
   * inserts) and returns the new ordering. A rule whose priority changes gets
   * the next revision: its place decides what it does, so an edit from before
   * the move is refused.
   *
   * Throws {@link PolicyReorderMismatchError} on a set mismatch — the route maps
   * it to a 409 so the UI can refetch and retry.
   */
  async reorder(
    tenantId: string,
    ruleIds: readonly string[],
    options: PolicyRuleWriteOptions<PolicyRule[]>
  ): Promise<PolicyRule[]> {
    if (new Set(ruleIds).size !== ruleIds.length) {
      throw new PolicyReorderMismatchError("ruleIds must not contain duplicates.");
    }
    return withTenantScope(this.db, tenantId, async (client) => {
      await lockPolicyRules(client, tenantId);
      const before = await rulesOf(client, tenantId);
      const existingIds = new Set(before.map((rule) => rule.ruleId));
      if (existingIds.size !== ruleIds.length || ruleIds.some((id) => !existingIds.has(id))) {
        throw new PolicyReorderMismatchError(
          "ruleIds must be exactly the tenant's current set of policy rules."
        );
      }

      for (let index = 0; index < ruleIds.length; index += 1) {
        // In SET, `priority` is the value before this UPDATE.
        await client.query(
          `UPDATE policy_rule
              SET revision = CASE WHEN priority = $3 THEN revision ELSE revision + 1 END,
                  priority = $3, updated_at = NOW()
            WHERE tenant_id = $1 AND rule_id = $2`,
          [tenantId, ruleIds[index], index * 10]
        );
      }

      const after = await rulesOf(client, tenantId);
      // Only a rule whose priority changed can change its place in the order.
      const moved = before.filter((rule) => after.find((candidate) => candidate.ruleId === rule.ruleId)?.priority !== rule.priority);
      const weaker = weakensPolicy(before, after, moved);
      return finish(client, after, weaker, options);
    });
  }

  /**
   * The priority for a new rule that lands at the END of the current evaluation
   * order: max(priority) + 10, or 0 for the first rule. A reorder sets priorities
   * to index * 10, so a fixed priority could land in the middle of the list.
   */
  async nextAppendPriority(tenantId: string): Promise<number> {
    return withTenantScope(this.db, tenantId, (client) => appendPriority(client, tenantId));
  }
}

/** All rules of the tenant, in evaluation order, in the write's transaction. */
async function rulesOf(client: PoolClient, tenantId: string): Promise<PolicyRule[]> {
  const result = await client.query(
    `SELECT * FROM policy_rule WHERE tenant_id = $1 ORDER BY priority ASC, rule_id ASC`,
    [tenantId]
  );
  return result.rows.map(mapRow);
}

/** Refuses a weaker change that the caller did not allow (rolls back), else writes the audit event. */
async function finish<T>(client: PoolClient, saved: T, weaker: boolean, options: PolicyRuleWriteOptions<T>): Promise<T> {
  if (weaker && !options.allowWeaker) throw new WeakerChangeError();
  if (options.audit) await AuditEventStore.createInTransaction(client, options.audit(saved, weaker));
  return saved;
}

// Every policy rule write of a tenant takes this transaction lock first, so a
// create, update, delete and reorder see each other's committed result.
async function lockPolicyRules(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('policy_rule:' || $1, 0))", [tenantId]);
}

async function appendPriority(client: PoolClient, tenantId: string): Promise<number> {
  const result = await client.query(
    `SELECT COALESCE(MAX(priority), -10) + 10 AS next FROM policy_rule WHERE tenant_id = $1`,
    [tenantId]
  );
  return Number(result.rows[0]?.next ?? 0);
}

// Raised by update() when the rule has another revision than the one that the
// change is based on. The route answers 409 `policy_rule_conflict`, and the
// editor shows the saved rule next to the draft.
export class PolicyRuleConflictError extends Error {
  constructor() {
    super("The policy rule has another revision than the one that the change is based on.");
    this.name = "PolicyRuleConflictError";
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
