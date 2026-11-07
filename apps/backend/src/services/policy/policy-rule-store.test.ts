import { describe, test, expect, vi } from "vitest";

import type { Pool } from "../../lib/db.js";

import { PolicyRuleStore, PolicyReorderMismatchError, type PolicyRuleWriteOptions } from "./policy-rule-store.js";
import { WeakerChangeError } from "../weaker-change-error.js";
import type { AuditEventInput } from "../audit-event-store.js";

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
        created_at: now,
        updated_at: now
      };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes("UPDATE policy_rule SET priority = $3")) {
      // reorder single-row update
      const row = ofTenant().find((r) => r.rule_id === params[1]);
      if (row) {
        row.priority = Number(params[2]);
        row.updated_at = this.nextTimestamp();
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("UPDATE policy_rule SET")) {
      const row = ofTenant().find((r) => r.rule_id === params[1]);
      if (!row) return { rows: [], rowCount: 0 };
      row.name = params[2];
      row.description = params[3];
      row.priority = Number(params[4]);
      row.enabled = Boolean(params[5]);
      row.effect = params[6];
      row.conditions_json = JSON.parse(String(params[7]));
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

  const updated = await store.update("t1", created.ruleId, { name: "renamed" }, ALLOW_WEAKER);
  expect(updated).not.toBeNull();
  expect(updated!.name).toBe("renamed");
  expect(updated!.effect).toBe("block");
  expect(updated!.description).toBe("d");
  expect(updated!.reason).toBe("r");
  expect(updated!.conditions).toEqual({ toolNames: ["x"] });
});

test("update can null out a description explicitly", async () => {
  const { store } = makeStore();
  const created = await store.create("t1", { name: "n", effect: "allow", description: "keep" }, null, ALLOW_WEAKER);
  const updated = await store.update("t1", created.ruleId, { description: null }, ALLOW_WEAKER);
  expect(updated!.description).toBe(null);
});

test("update returns null for a missing rule", async () => {
  const { store } = makeStore();
  expect(await store.update("t1", "pol_nope", { name: "x" }, ALLOW_WEAKER)).toBe(null);
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

test("mapRow normalizes malformed condition dimensions to a clean shape", async () => {
  const { db, store } = makeStore();
  // Seed a row directly with messy JSONB: non-string entries and an empty array.
  db.rows.push({
    rule_id: "pol_seed",
    tenant_id: "t1",
    name: "seeded",
    description: null,
    priority: 0,
    enabled: true,
    effect: "block",
    conditions_json: { toolNames: ["ok", 5, null], categories: [], unknownKey: ["dropped"] },
    reason: null,
    created_by: null,
    created_at: "2026-05-31T00:00:00.000Z",
    updated_at: "2026-05-31T00:00:00.000Z"
  });

  const rule = await store.get("t1", "pol_seed");
  // Non-strings filtered out, empty dimension dropped, unknown key not surfaced.
  expect(rule!.conditions).toEqual({ toolNames: ["ok"] });
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

  await store.update("t1", rule.ruleId, { enabled: false }, ALLOW_WEAKER);

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
    ["update: the block rule turned off", (store, ids, options) => store.update("t1", ids.block, { enabled: false }, options as never)],
    ["update: block becomes approval", (store, ids, options) => store.update("t1", ids.block, { effect: "require_approval" }, options as never)],
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
    await store.update("t1", block.ruleId, { name: "block customer exports" }, { allowWeaker: false, audit });
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
