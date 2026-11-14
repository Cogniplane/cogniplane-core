import { describe, test, expect, vi } from "vitest";

import type { Pool } from "../../lib/db.js";

import { PolicyRuleConflictError, PolicyRuleStore, PolicyReorderMismatchError, type PolicyRuleWriteOptions } from "./policy-rule-store.js";
import { WeakerChangeError } from "../weaker-change-error.js";
import { UnreadableControlValueError } from "../admin-config-store-mappers.js";
import { enforcePolicyCenter, type PolicyGate } from "../mcp/policy-gate.js";
import { PolicyBlockedError, PolicyService } from "./policy-service.js";
import type { AuditEventInput } from "../audit-event-store.js";
import type { PolicyDecisionInput } from "./policy-decision-store.js";
import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";

const AUDIT: AuditEventInput = {
  tenantId: "t1", sessionId: null, userId: "admin-1", type: "admin.policy_rule.updated", payload: {}
};
import { ALLOW_WEAKER } from "../../test-helpers/data-routes.js";

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };

// Supplies rows for application-side patch merging and validation.
// SQL ordering, tenant filtering, and append priorities run in the integration suite.
class InMemoryRuleDatabase {
  rows: Record<string, unknown>[] = [];
  private clock = 0;

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.query(sql, params),
      release: () => {}
    };
  }

  private nextTimestamp(): string {
    return new Date(Date.UTC(2026, 4, 31, 0, 0, this.clock++)).toISOString();
  }

  // Statement kinds in order, to check what runs in one locked transaction.
  readonly statements: string[] = [];
  // Audit events written in a rule write's transaction.
  readonly audits: Array<{ type: unknown; payload: unknown }> = [];

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      this.statements.push(sql);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT set_config")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
      this.statements.push(`lock:${String(params[0])}`);
      return { rows: [], rowCount: 0 };
    }
    this.statements.push(sql.trim().split(/\s+/)[0]!.toUpperCase());

    const tenantId = String(params[0]);
    const ofTenant = () => this.rows.filter((r) => r.tenant_id === tenantId);

    if (sql.includes("COALESCE(MAX(priority)")) {
      const rows = ofTenant();
      const max = rows.length === 0 ? -10 : Math.max(...rows.map((r) => Number(r.priority)));
      return { rows: [{ next: max + 10 }], rowCount: 1 };
    }

    if (sql.includes("SELECT rule_id FROM policy_rule")) {
      return { rows: ofTenant().map((r) => ({ rule_id: r.rule_id })), rowCount: ofTenant().length };
    }

    if (sql.includes("SELECT rule_id, name, priority")) {
      // listForLint — carries raw conditions_json
      const rows = ofTenant()
        .slice()
        .sort((a, b) => Number(a.priority) - Number(b.priority) || String(a.rule_id).localeCompare(String(b.rule_id)));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes("SELECT * FROM policy_rule") && sql.includes("rule_id = $2")) {
      const row = ofTenant().find((r) => r.rule_id === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("SELECT * FROM policy_rule")) {
      const rows = ofTenant()
        .slice()
        .sort((a, b) => Number(a.priority) - Number(b.priority) || String(a.rule_id).localeCompare(String(b.rule_id)));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes("INSERT INTO policy_rule")) {
      const now = this.nextTimestamp();
      const row: Record<string, unknown> = {
        rule_id: String(params[0]),
        tenant_id: String(params[1]),
        name: params[2],
        description: params[3],
        priority: Number(params[4]),
        enabled: Boolean(params[5]),
        effect: params[6],
        conditions_json: JSON.parse(String(params[7])),
        reason: params[8],
        created_by: params[9],
        revision: 1,
        created_at: now,
        updated_at: now
      };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes("SET revision = CASE WHEN priority = $3")) {
      // reorder single-row update: a moved rule gets the next revision
      const row = ofTenant().find((r) => r.rule_id === params[1]);
      if (row) {
        if (row.priority !== Number(params[2])) row.revision = Number(row.revision) + 1;
        row.priority = Number(params[2]);
        row.updated_at = this.nextTimestamp();
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE policy_rule SET")) {
      // update: only from the expected revision ($10), and it adds 1
      const row = ofTenant().find((r) => r.rule_id === params[1] && r.revision === params[9]);
      if (!row) return { rows: [], rowCount: 0 };
      row.revision = Number(row.revision) + 1;
      row.name = params[2];
      row.description = params[3];
      row.priority = Number(params[4]);
      row.enabled = Boolean(params[5]);
      row.effect = params[6];
      // COALESCE($8::jsonb, conditions_json): no conditions in the patch keeps the stored JSON.
      if (params[7] !== null) row.conditions_json = JSON.parse(String(params[7]));
      row.reason = params[8];
      row.updated_at = this.nextTimestamp();
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO audit_events")) {
      this.audits.push({ type: params[4], payload: JSON.parse(String(params[5])) });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("DELETE FROM policy_rule")) {
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => !(r.tenant_id === tenantId && r.rule_id === params[1]));
      return { rows: [], rowCount: before - this.rows.length };
    }

    throw new Error(`Unexpected query in test: ${sql}`);
  }
}

function makeStore() {
  const db = new InMemoryRuleDatabase();
  return { db, store: new PolicyRuleStore(db as unknown as Pool) };
}

test("create honors an explicit priority instead of appending", async () => {
  const { store } = makeStore();
  const rule = await store.create("t1", { name: "x", effect: "require_approval", priority: 250 }, null, ALLOW_WEAKER);
  expect(rule.priority).toBe(250);
  expect(rule.createdBy).toBe(null);
});

test("get returns null for a missing rule", async () => {
  const { store } = makeStore();
  expect(await store.get("t1", "pol_missing")).toBe(null);
});

test("update preserves unspecified fields and changes provided ones", async () => {
  const { store } = makeStore();
  const created = await store.create(
    "t1",
    { name: "orig", effect: "block", description: "d", reason: "r", conditions: { toolNames: ["x"] } },
    null,
    ALLOW_WEAKER
  );

  const updated = await store.update("t1", created.ruleId, { expectedRevision: 1, name: "renamed" }, ALLOW_WEAKER);
  expect(updated).not.toBeNull();
  expect(updated!.name).toBe("renamed");
  expect(updated!.revision).toBe(2);
  expect(updated!.effect).toBe("block");
  expect(updated!.description).toBe("d");
  expect(updated!.reason).toBe("r");
  expect(updated!.conditions).toEqual({ toolNames: ["x"] });
});

test("update can null out a description explicitly", async () => {
  const { store } = makeStore();
  const created = await store.create("t1", { name: "n", effect: "allow", description: "keep" }, null, ALLOW_WEAKER);
  const updated = await store.update("t1", created.ruleId, { expectedRevision: 1, description: null }, ALLOW_WEAKER);
  expect(updated!.description).toBe(null);
});

test("update returns null for a missing rule", async () => {
  const { store } = makeStore();
  expect(await store.update("t1", "pol_nope", { expectedRevision: 1, name: "x" }, ALLOW_WEAKER)).toBe(null);
});

// The check runs before the write and before the weaker-change check.
test("update from an older revision throws PolicyRuleConflictError and rolls back with no write and no audit event", async () => {
  const { db, store } = makeStore();
  const created = await store.create("t1", { name: "block", effect: "block" }, null, ALLOW_WEAKER);
  await store.update("t1", created.ruleId, { expectedRevision: 1, name: "block exports" }, ALLOW_WEAKER);
  db.statements.length = 0;
  const audit = vi.fn(() => AUDIT);

  await expect(store.update("t1", created.ruleId, { expectedRevision: 1, enabled: false }, { allowWeaker: false, audit }))
    .rejects.toBeInstanceOf(PolicyRuleConflictError);
  expect(db.statements).toEqual(["BEGIN", "lock:t1", "SELECT", "ROLLBACK"]);
  expect(audit).not.toHaveBeenCalled();
  expect(await store.get("t1", created.ruleId)).toMatchObject({ name: "block exports", enabled: true, revision: 2 });
});

test("delete returns the removed rule, or null when there is none", async () => {
  const { store } = makeStore();
  const created = await store.create("t1", { name: "n", effect: "allow" }, null, ALLOW_WEAKER);
  expect(await store.delete("t1", created.ruleId, ALLOW_WEAKER)).toEqual(created);
  expect(await store.delete("t1", created.ruleId, ALLOW_WEAKER)).toBe(null);
});

test("reorder rewrites priorities to index*10 in the supplied order", async () => {
  const { store } = makeStore();
  const a = await store.create("t1", { name: "a", effect: "allow" }, null, ALLOW_WEAKER);
  const b = await store.create("t1", { name: "b", effect: "allow" }, null, ALLOW_WEAKER);
  const c = await store.create("t1", { name: "c", effect: "allow" }, null, ALLOW_WEAKER);

  const reordered = await store.reorder("t1", [c.ruleId, a.ruleId, b.ruleId], ALLOW_WEAKER);
  expect(reordered.map((r) => r.name)).toEqual(["c", "a", "b"]);
  expect(reordered.map((r) => r.priority)).toEqual([0, 10, 20]);
  // Each rule moved, so each has the next revision.
  expect(reordered.map((r) => r.revision)).toEqual([2, 2, 2]);
});

test("reorder rejects duplicate ids", async () => {
  const { store } = makeStore();
  const a = await store.create("t1", { name: "a", effect: "allow" }, null, ALLOW_WEAKER);
  await expect(() => store.reorder("t1", [a.ruleId, a.ruleId], ALLOW_WEAKER)).rejects.toBeInstanceOf(
    PolicyReorderMismatchError
  );
});

test("reorder rejects a set that does not match the tenant's current rules", async () => {
  const { store } = makeStore();
  const a = await store.create("t1", { name: "a", effect: "allow" }, null, ALLOW_WEAKER);
  await store.create("t1", { name: "b", effect: "allow" }, null, ALLOW_WEAKER);
  // Missing one of the two existing rules.
  await expect(() => store.reorder("t1", [a.ruleId], ALLOW_WEAKER)).rejects.toBeInstanceOf(
    PolicyReorderMismatchError
  );
});

// Stored conditions that the shared strict schema cannot read (issue #121).
// Before, the store dropped unknown keys and bad entries, so `{ toolName:
// ["typo"] }` on an allow rule became "allow every tool".
describe("a stored rule whose conditions cannot be read", () => {
  function seedRow(db: InMemoryRuleDatabase, row: Partial<Record<string, unknown>> & { rule_id: string }) {
    db.rows.push({
      tenant_id: "t1", name: row.rule_id, description: null, priority: 0, enabled: true, effect: "allow",
      conditions_json: {}, reason: null, created_by: null, revision: 1,
      created_at: "2026-05-31T00:00:00.000Z", updated_at: "2026-05-31T00:00:00.000Z", ...row
    });
  }

  function gateService(store: PolicyRuleStore) {
    const decisions: PolicyDecisionInput[] = [];
    const service = new PolicyService({
      rules: store,
      decisions: { record: async (tenantId, input, audit) => {
        decisions.push(input);
        const decision = { ...input, decisionId: "pdc_1", tenantId, createdAt: new Date(0).toISOString() };
        audit(decision);
        return decision;
      } },
      logger: { warn() {} },
      ruleCacheTtlMs: 0
    });
    return { service, decisions };
  }

  function gateInput(toolName: string, enforcementMode: "monitor" | "enforce") {
    return {
      tenantId: "t1", sessionId: "s1", userId: "u1", runtimeId: "r1", toolName, category: "github",
      severity: "read_only" as const, serverId: "github", turnContext: "interactive" as const, enforcementMode
    };
  }

  test.each([
    ["an unknown key", { toolName: ["typo"] }],
    ["a list with a non-string entry", { toolNames: ["ok", 5] }],
    ["a dimension that is not a list", { categories: "github" }],
    ["an unknown severity", { severities: ["root"] }],
    ["an unknown turn context", { turnContexts: ["batch"] }],
    ["an empty tool name", { toolNames: [""] }],
    ["a list instead of an object", ["toolNames"]],
    ["null", null]
  ])("%s marks the rule unreadable instead of dropping the value", async (_label, conditions) => {
    const { db, store } = makeStore();
    seedRow(db, { rule_id: "pol_bad", conditions_json: conditions });

    const rule = await store.get("t1", "pol_bad");

    expect(rule).toMatchObject({ conditions: {}, conditionsInvalid: true, effect: "allow" });
  });

  test("valid empty conditions stay a catch-all with no marker", async () => {
    const { db, store } = makeStore();
    seedRow(db, { rule_id: "pol_all", conditions_json: {} });
    const rule = await store.get("t1", "pol_all");
    expect(rule).not.toHaveProperty("conditionsInvalid");
    expect(rule?.conditions).toEqual({});
  });

  test("an unknown stored effect fails the read instead of passing a cast", async () => {
    const { db, store } = makeStore();
    seedRow(db, { rule_id: "pol_effect", effect: "permit" });
    await expect(store.list("t1")).rejects.toThrow(UnreadableControlValueError);
  });

  test("a typo'd high-priority allow rule blocks at the gateway instead of allowing every tool", async () => {
    const { db, store } = makeStore();
    seedRow(db, { rule_id: "pol_allow_typo", priority: 0, effect: "allow", conditions_json: { toolName: ["typo"] } });
    seedRow(db, { rule_id: "pol_block_export", priority: 10, effect: "block", conditions_json: { toolNames: ["export"] } });
    const { service, decisions } = gateService(store);

    await expect(service.gateAction(gateInput("export", "enforce"))).rejects.toBeInstanceOf(PolicyBlockedError);
    await expect(service.gateAction(gateInput("search", "enforce"))).rejects.toMatchObject({
      matchedRuleId: "pol_allow_typo",
      explanation: expect.stringContaining("cannot be read")
    });
    // Monitor mode records what Enforce would block and lets the call through.
    const monitored = await service.gateAction(gateInput("search", "monitor"));
    expect(monitored).toMatchObject({ enforced: false, evaluation: { outcome: "block", matchedRuleId: "pol_allow_typo" } });
    expect(decisions.map((decision) => decision.outcome)).toEqual(["block", "block", "block"]);
  });

  test("an unreadable block rule still blocks, and blocks every action", async () => {
    const { db, store } = makeStore();
    seedRow(db, { rule_id: "pol_block_bad", priority: 0, effect: "block", conditions_json: { toolNames: ["export", 7] } });
    seedRow(db, { rule_id: "pol_allow", priority: 10, effect: "allow", conditions_json: {} });
    const { service } = gateService(store);

    for (const tool of ["export", "search"]) {
      await expect(service.gateAction(gateInput(tool, "enforce"))).rejects.toMatchObject({ matchedRuleId: "pol_block_bad" });
    }
  });

  test("the gateway hook refuses the call through the real store, service and Policy Center gate", async () => {
    const { db, store } = makeStore();
    seedRow(db, { rule_id: "pol_allow_typo", effect: "allow", conditions_json: { toolName: ["typo"] } });
    const { service } = gateService(store);
    const context: ToolExecutionContext = {
      toolContextId: "ctx-1", tenantId: "t1", sessionId: "s1", userId: "u1", runtimeId: "r1",
      runtimePolicyId: "p", messageId: null, credentialEnvelope: {},
      metadata: { turnContext: "interactive", runtimePolicy: {
        id: "p", policyEnforcementMode: "enforce", webSearchMode: "disabled", approvalPolicy: "on-request",
        approvalReviewer: "user", enabledToolIds: ["search"], enabledMcpServers: ["github"]
      } },
      createdAt: "2026-11-14T00:00:00.000Z", expiresAt: "2026-11-14T01:00:00.000Z"
    };
    const gate: PolicyGate = {
      policyService: service, approvals: { get: async () => null, consume: async () => false }, logger: { warn() {} }
    };

    await expect(enforcePolicyCenter(gate, context, "search", "github", { readOnly: true }, {}, null))
      .rejects.toBeInstanceOf(PolicyBlockedError);
  });

  test("a disabled unreadable rule does nothing", async () => {
    const { db, store } = makeStore();
    seedRow(db, { rule_id: "pol_off", enabled: false, effect: "block", conditions_json: { toolName: ["typo"] } });
    const { service } = gateService(store);
    await expect(service.gateAction(gateInput("search", "enforce"))).resolves.toMatchObject({
      enforced: false, evaluation: { outcome: "allow", matchedRuleId: null }
    });
  });

  describe("changes keep the weaker-change protection", () => {
    async function seededInvalid() {
      const { db, store } = makeStore();
      seedRow(db, { rule_id: "pol_bad", priority: 0, effect: "allow", conditions_json: { toolName: ["typo"] } });
      seedRow(db, { rule_id: "pol_allow", priority: 10, effect: "allow", conditions_json: { toolNames: ["search"] } });
      return { db, store };
    }

    const weaker: Array<[string, (store: PolicyRuleStore) => Promise<unknown>]> = [
      ["disable it", (store) => store.update("t1", "pol_bad", { expectedRevision: 1, enabled: false }, { allowWeaker: false })],
      ["delete it", (store) => store.delete("t1", "pol_bad", { allowWeaker: false })],
      ["repair it to the conditions it was meant to have",
        (store) => store.update("t1", "pol_bad", { expectedRevision: 1, conditions: { toolNames: ["typo"] } }, { allowWeaker: false })],
      ["move it below an allow rule", (store) => store.reorder("t1", ["pol_allow", "pol_bad"], { allowWeaker: false })]
    ];

    test.each(weaker)("%s needs step-up (WeakerChangeError without it)", async (_label, change) => {
      const { store } = await seededInvalid();
      await expect(change(store)).rejects.toBeInstanceOf(WeakerChangeError);
    });

    test("a patch without conditions keeps the stored JSON, so the rule stays unreadable and blocking", async () => {
      const { db, store } = await seededInvalid();

      const renamed = await store.update("t1", "pol_bad", { expectedRevision: 1, name: "renamed" }, { allowWeaker: false });

      expect(renamed).toMatchObject({ name: "renamed", conditions: {}, conditionsInvalid: true });
      expect(db.rows.find((row) => row.rule_id === "pol_bad")?.conditions_json).toEqual({ toolName: ["typo"] });
    });

    test("a repair that still blocks every action needs no step-up", async () => {
      const { store } = await seededInvalid();
      const repaired = await store.update("t1", "pol_bad",
        { expectedRevision: 1, effect: "block", conditions: {} }, { allowWeaker: false });
      expect(repaired).toMatchObject({ effect: "block", conditions: {} });
      expect(repaired).not.toHaveProperty("conditionsInvalid");
    });
  });
});

test("listForLint surfaces the raw conditions including unknown keys", async () => {
  const { db, store } = makeStore();
  db.rows.push({
    rule_id: "pol_lint",
    tenant_id: "t1",
    name: "lintme",
    priority: 0,
    enabled: true,
    conditions_json: { toolName: ["typo"] }, // singular typo the lint must see
    created_at: "2026-05-31T00:00:00.000Z",
    updated_at: "2026-05-31T00:00:00.000Z"
  });
  const lintable = await store.listForLint("t1");
  expect(lintable).toHaveLength(1);
  expect(lintable[0].conditions).toEqual({ toolName: ["typo"] });
});

test("update reads and writes the rule in one transaction under the tenant's rule lock", async () => {
  const db = new InMemoryRuleDatabase();
  const store = new PolicyRuleStore(db as unknown as Pool);
  const rule = await store.create("t1", { name: "r", effect: "block", conditions: {} }, null, ALLOW_WEAKER);
  db.statements.length = 0;

  await store.update("t1", rule.ruleId, { expectedRevision: 1, enabled: false }, ALLOW_WEAKER);

  // A read in one transaction and a write in another let a concurrent partial
  // update or reorder be lost between them.
  expect(db.statements).toEqual(["BEGIN", "lock:t1", "SELECT", "UPDATE", "COMMIT"]);
});

// The classification runs in the write's transaction, against the rules read
// under the lock (policy-weakening.ts decides "weaker"). A weaker change that
// the caller did not allow rolls back with no audit event.
describe("a change that makes the policy weaker", () => {
  async function seeded() {
    const { db, store } = makeStore();
    const block = await store.create("t1", { name: "block exports", effect: "block", priority: 10,
      conditions: { toolNames: ["export_customers"] } }, null, ALLOW_WEAKER);
    const allow = await store.create("t1", { name: "allow rest", effect: "allow", priority: 20 }, null, ALLOW_WEAKER);
    db.statements.length = 0;
    return { db, store, block, allow };
  }

  const weakerChanges: Array<[string, (store: PolicyRuleStore, ids: { block: string; allow: string },
    options: PolicyRuleWriteOptions<never>) => Promise<unknown>]> = [
    ["create: an allow rule before the block rule",
      (store, _ids, options) => store.create("t1", { name: "allow all", effect: "allow", priority: 0 }, null, options as never)],
    ["update: the block rule turned off", (store, ids, options) => store.update("t1", ids.block, { expectedRevision: 1, enabled: false }, options as never)],
    ["update: block becomes approval", (store, ids, options) => store.update("t1", ids.block, { expectedRevision: 1, effect: "require_approval" }, options as never)],
    ["delete: the block rule", (store, ids, options) => store.delete("t1", ids.block, options as never)],
    ["reorder: the allow rule first", (store, ids, options) => store.reorder("t1", [ids.allow, ids.block], options as never)]
  ];

  test.each(weakerChanges)("%s throws WeakerChangeError and rolls back without an audit event", async (_name, run) => {
    const { db, store, block, allow } = await seeded();
    const audit = vi.fn(() => AUDIT);
    await expect(run(store, { block: block.ruleId, allow: allow.ruleId }, { allowWeaker: false, audit })).rejects.toBeInstanceOf(WeakerChangeError);
    expect(db.statements.at(-1)).toBe("ROLLBACK");
    expect(audit).not.toHaveBeenCalled();
    expect(db.audits).toEqual([]);
  });

  test.each(weakerChanges)("%s with allowWeaker commits, with its audit event marked weaker in the transaction", async (_name, run) => {
    const { db, store, block, allow } = await seeded();
    const audit = vi.fn((_saved: unknown, weaker: boolean) => ({ ...AUDIT, payload: { weaker } }));
    await run(store, { block: block.ruleId, allow: allow.ruleId }, { allowWeaker: true, audit });
    expect(audit).toHaveBeenCalledWith(expect.anything(), true);
    expect(db.audits).toEqual([{ type: AUDIT.type, payload: { weaker: true } }]);
    expect(db.statements.slice(-2)).toEqual(["INSERT", "COMMIT"]);
  });

  test("a change that is not weaker commits without allowWeaker and says so to the audit event", async () => {
    const { db, store, block } = await seeded();
    const audit = vi.fn((_saved: unknown, weaker: boolean) => ({ ...AUDIT, payload: { weaker } }));
    await store.update("t1", block.ruleId, { expectedRevision: 1, name: "block customer exports" }, { allowWeaker: false, audit });
    await store.create("t1", { name: "block deletes", effect: "block", priority: 0 }, null, { allowWeaker: false, audit });
    expect(db.audits).toEqual([{ type: AUDIT.type, payload: { weaker: false } }, { type: AUDIT.type, payload: { weaker: false } }]);
  });
});

test.each([
  ["create", (store: PolicyRuleStore) => store.create("t1", { name: "r2", effect: "block", conditions: {} }, null, ALLOW_WEAKER)],
  ["delete", (store: PolicyRuleStore) => store.delete("t1", "missing", ALLOW_WEAKER)],
  ["reorder", (store: PolicyRuleStore, ruleId: string) => store.reorder("t1", [ruleId], ALLOW_WEAKER)]
])("%s takes the tenant's rule lock before it reads or writes", async (_name, run) => {
  const db = new InMemoryRuleDatabase();
  const store = new PolicyRuleStore(db as unknown as Pool);
  const rule = await store.create("t1", { name: "r", effect: "block", conditions: {} }, null, ALLOW_WEAKER);
  db.statements.length = 0;

  await run(store, rule.ruleId);

  expect(db.statements.slice(0, 2)).toEqual(["BEGIN", "lock:t1"]);
  expect(db.statements.filter((statement) => statement === "BEGIN")).toHaveLength(1);
});
