import { test, expect } from "vitest";

import { POLICY_DECISIONS_MAX_LIMIT, POLICY_DECISIONS_PAGE_SIZE } from "@cogniplane/shared-types";

import type { Pool } from "../../lib/db.js";

import { PolicyDecisionStore, type PolicyDecisionInput } from "./policy-decision-store.js";

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };

// In-memory fake of `policy_decision`. The store builds dynamic WHERE clauses
// and pagination, so the fake captures the last page-query params and lets each
// test assert against the seeded rows it filters itself — we only need to model
// enough SQL shape for record/list/get to round-trip.
class InMemoryDecisionDatabase {
  rows: Record<string, unknown>[] = [];
  lastPageSql = "";
  lastPageParams: unknown[] = [];
  private clock = 0;

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.query(sql, params),
      release: () => {}
    };
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SELECT set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO policy_decision")) {
      const now = new Date(Date.UTC(2026, 4, 31, 0, 0, this.clock++)).toISOString();
      const row: Record<string, unknown> = {
        decision_id: params[0],
        tenant_id: params[1],
        session_id: params[2],
        user_id: params[3],
        runtime_id: params[4],
        tool_name: params[5],
        tool_category: params[6],
        severity: params[7],
        server_id: params[8],
        matched_rule_id: params[9],
        outcome: params[10],
        enforced: params[11],
        explanation: params[12],
        action_snapshot_json: JSON.parse(String(params[13])),
        created_at: now
      };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes("SELECT COUNT(*)")) {
      return { rows: [{ total: this.rows.length }], rowCount: 1 };
    }

    if (sql.includes("SELECT * FROM policy_decision") && sql.includes("decision_id = $2")) {
      const row = this.rows.find((r) => r.tenant_id === params[0] && r.decision_id === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("SELECT * FROM policy_decision")) {
      // page query — capture the LIMIT/OFFSET (last two params) for assertions
      this.lastPageSql = sql;
      this.lastPageParams = params;
      return { rows: this.rows.slice(), rowCount: this.rows.length };
    }

    throw new Error(`Unexpected query in test: ${sql}`);
  }
}

function baseInput(overrides: Partial<PolicyDecisionInput> = {}): PolicyDecisionInput {
  return {
    sessionId: "sess-1",
    userId: "user-1",
    runtimeId: "rt-1",
    toolName: "write_artifact",
    toolCategory: "managed-session-context",
    severity: "write",
    serverId: "managed-session-context",
    matchedRuleId: "pol_1",
    outcome: "allow",
    enforced: true,
    explanation: "matched rule pol_1",
    actionSnapshot: { foo: "bar" },
    ...overrides
  };
}

function makeStore() {
  const db = new InMemoryDecisionDatabase();
  return { db, store: new PolicyDecisionStore(db as unknown as Pool) };
}

test("record persists a decision and returns the mapped row", async () => {
  const { store } = makeStore();
  const decision = await store.record("t1", baseInput());
  expect(decision.decisionId).toMatch(/^pdc_/);
  expect(decision.toolName).toBe("write_artifact");
  expect(decision.outcome).toBe("allow");
  expect(decision.enforced).toBe(true);
  expect(decision.severity).toBe("write");
});

test("list returns decisions with total and paging metadata", async () => {
  const { store } = makeStore();
  await store.record("t1", baseInput());
  await store.record("t1", baseInput({ toolName: "read_text_artifact", outcome: "block" }));

  const result = await store.list("t1");
  expect(result.total).toBe(2);
  expect(result.decisions).toHaveLength(2);
  expect(result.limit).toBe(POLICY_DECISIONS_PAGE_SIZE);
  expect(result.offset).toBe(0);
  expect(result.hasMore).toBe(false);
});

test("list clamps an over-large limit to the max", async () => {
  const { db, store } = makeStore();
  await store.record("t1", baseInput());
  const result = await store.list("t1", { limit: 99999 });
  expect(result.limit).toBe(POLICY_DECISIONS_MAX_LIMIT);
  // The clamped limit is the second-to-last positional param of the page query.
  expect(db.lastPageParams.at(-2)).toBe(POLICY_DECISIONS_MAX_LIMIT);
});

test("list clamps a negative offset to 0", async () => {
  const { store } = makeStore();
  await store.record("t1", baseInput());
  const result = await store.list("t1", { offset: -5 });
  expect(result.offset).toBe(0);
});

test("list short-circuits an inverted date range without querying", async () => {
  const { db, store } = makeStore();
  await store.record("t1", baseInput());
  db.lastPageSql = "";
  const result = await store.list("t1", { from: "2026-06-01", to: "2026-05-01" });
  expect(result.total).toBe(0);
  expect(result.decisions).toEqual([]);
  // No page query ran.
  expect(db.lastPageSql).toBe("");
});

test("list builds filter predicates for outcomes, tool names and severities", async () => {
  const { db, store } = makeStore();
  await store.record("t1", baseInput());
  await store.list("t1", {
    outcomes: ["block"],
    toolNames: ["write_artifact"],
    severities: ["write"],
    enforced: true,
    sessionId: "sess-1"
  });
  expect(db.lastPageSql).toContain("outcome = ANY");
  expect(db.lastPageSql).toContain("tool_name = ANY");
  expect(db.lastPageSql).toContain("severity = ANY");
  expect(db.lastPageSql).toContain("enforced =");
  expect(db.lastPageSql).toContain("session_id =");
});

test("get re-redacts secrets in the action snapshot on read", async () => {
  const { store } = makeStore();
  const recorded = await store.record(
    "t1",
    baseInput({ actionSnapshot: { authorization: "Bearer sk-secret-value", path: "/x" } })
  );

  const detail = await store.get("t1", recorded.decisionId);
  expect(detail).not.toBeNull();
  // The redactor scrubs the auth value; the benign field survives.
  expect(JSON.stringify(detail!.actionSnapshot)).not.toContain("sk-secret-value");
  expect(detail!.actionSnapshot.path).toBe("/x");
});

test("get returns null for a missing decision", async () => {
  const { store } = makeStore();
  expect(await store.get("t1", "pdc_missing")).toBe(null);
});
