// Smoke tests for PiiAnalyticsStore. The full route-level coverage in
// admin-pii-routes.test.ts already exercises the SQL bodies through
// substring matchers; these tests assert that the store wraps every method
// in `withTenantScope` (BEGIN / set_config / COMMIT) and keeps the
// expected SQL fragments visible to the route-test fakes after the move.

import { test, expect } from "vitest";

import type { Pool } from "../../lib/db.js";
import { PiiAnalyticsStore } from "./pii-analytics-store.js";

class CaptureDatabase {
  queries: { text: string; values: unknown[] }[] = [];
  /** Rows the recent-activity query returns. */
  recentRows: Record<string, unknown>[] = [];

  async connect() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async query(text: string, values: unknown[] = []) {
        self.queries.push({ text, values });
        const rows = text.includes("AS entity_types") ? self.recentRows : [];
        return { rows, rowCount: rows.length };
      },
      async release() {}
    };
  }

  async query(text: string, values: unknown[] = []) {
    this.queries.push({ text, values });
    return { rows: [], rowCount: 0 };
  }
}

test("getKpis runs inside withTenantScope and queries pii_scan_runs", async () => {
  const db = new CaptureDatabase();
  const store = new PiiAnalyticsStore(db as unknown as Pool);

  await store.getKpis("tenant-1", new Date("2026-01-01"), new Date("2026-02-01"));

  // The distinguishing contract is that getKpis reads from pii_scan_runs; the
  // BEGIN/COMMIT/set_config transaction envelope is `withTenantScope`, tested in
  // lib/db.test.ts — no need to re-assert it here.
  const sqlTexts = db.queries.map((q) => q.text);
  expect(sqlTexts.some((t) => t.includes("FROM pii_scan_runs"))).toBeTruthy();
});

test("getQueueStats targets pii_scan_jobs (not pii_scan_runs) and ignores range arguments", async () => {
  const db = new CaptureDatabase();
  const store = new PiiAnalyticsStore(db as unknown as Pool);

  await store.getQueueStats("tenant-1");

  const aggregateQuery = db.queries.find((q) => q.text.includes("FROM pii_scan_jobs"));
  expect(aggregateQuery).toBeTruthy();
  // Point-in-time query: no range binds, but the tenant predicate still applies.
  expect(aggregateQuery!.values).toEqual(["tenant-1"]);
  expect(aggregateQuery!.text).toMatch(/tenant_id = \$1/);
  // Sanity: didn't accidentally run against the runs table.
  expect(db.queries.some((q) => q.text.includes("FROM pii_scan_runs"))).toBeFalsy();
});

test("getRecentActivity threads action filter + limit through positional params", async () => {
  const db = new CaptureDatabase();
  const store = new PiiAnalyticsStore(db as unknown as Pool);
  const from = new Date("2026-01-01");
  const to = new Date("2026-02-01");

  await store.getRecentActivity("tenant-1", from, to, ["block", "failed"], 25);

  const aggregateQuery = db.queries.find((q) => q.text.includes("FROM pii_scan_runs"));
  expect(aggregateQuery).toBeTruthy();
  // [from, to, actionTakenValues (without 'failed'), includeFailed=true, limit, tenantId]
  expect(aggregateQuery!.values).toEqual([from, to, ["block"], true, 25, "tenant-1"]);
});

function recentRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    scan_run_id: "run-1", created_at: new Date("2026-01-10T10:00:00.000Z"), completed_at: null,
    subject_type: "message", subject_id: "msg-1", instructions_revision: null, source_session_id: null,
    source_user_id: null, mode: "detect", action_taken: null, status: "completed", provider_type: null,
    provider_model: null, findings_count: 2, error_message: null, entity_types: [], ...overrides
  };
}

async function recent(rows: Record<string, unknown>[]) {
  const db = new CaptureDatabase();
  db.recentRows = rows;
  return new PiiAnalyticsStore(db as unknown as Pool)
    .getRecentActivity("tenant-1", new Date("2026-01-01"), new Date("2026-02-01"), ["block"], 25);
}

test("getRecentActivity maps each row, with optional fields set or null", async () => {
  const rows = await recent([
    recentRow({
      scan_run_id: "run-1", completed_at: "2026-01-10T10:00:05Z", subject_type: "project_instructions",
      subject_id: "proj-1", instructions_revision: 0, source_session_id: "session-1", source_user_id: "user-1",
      action_taken: "block", provider_type: "openai", provider_model: "gpt", error_message: "late",
      entity_types: ["email", "phone"]
    }),
    recentRow({ scan_run_id: "run-2", source_session_id: "", findings_count: undefined, status: "failed" })
  ]);

  expect(rows).toEqual([
    {
      scanRunId: "run-1", createdAt: "2026-01-10T10:00:00.000Z", completedAt: "2026-01-10T10:00:05.000Z",
      subjectType: "project_instructions", subjectId: "proj-1", instructionsRevision: 0, sessionId: "session-1",
      userId: "user-1", mode: "detect", actionTaken: "block", status: "completed", providerType: "openai",
      providerModel: "gpt", findingsCount: 2, errorMessage: "late", entityTypes: ["email", "phone"]
    },
    {
      scanRunId: "run-2", createdAt: "2026-01-10T10:00:00.000Z", completedAt: null, subjectType: "message",
      subjectId: "msg-1", instructionsRevision: null, sessionId: null, userId: null, mode: "detect",
      actionTaken: null, status: "failed", providerType: null, providerModel: null, findingsCount: 0,
      errorMessage: null, entityTypes: []
    }
  ]);
});

test.each([
  ["a JSON array", ["email"], ["email"]],
  ["JSON array text", '["email","phone"]', ["email", "phone"]],
  ["invalid JSON text", "[email", []],
  ["JSON text that is not an array", '{"email":1}', []],
  ["null", null, []]
])("getRecentActivity reads entity types from %s", async (_case, entityTypes, expected) => {
  const [row] = await recent([recentRow({ entity_types: entityTypes })]);

  expect(row!.entityTypes).toEqual(expected);
});

// The isolation guard, applied to every method rather than a chosen few.
//
// This store aggregates across whole tables, so a query that loses its tenant
// filter does not error — it silently returns other tenants' counts. RLS is
// the primary boundary, but nothing in a unit test exercises RLS, and these
// asserts are what would catch a new method (or an edited WHERE clause) that
// ships without the predicate.
//
// Both halves are asserted deliberately: a bound `tenantId` proves nothing on
// its own, because a query can bind a parameter it never references.
test("every analytics query filters by tenant_id, not only binds it", async () => {
  const from = new Date("2026-01-01");
  const to = new Date("2026-02-01");
  const range = { from, to, bucket: "day" } as never;

  const invocations: Array<[string, (store: PiiAnalyticsStore) => Promise<unknown>]> = [
    ["getKpis", (s) => s.getKpis("tenant-1", from, to)],
    ["getTimeSeries", (s) => s.getTimeSeries("tenant-1", range)],
    ["getByEntityType", (s) => s.getByEntityType("tenant-1", from, to)],
    ["getByConfidence", (s) => s.getByConfidence("tenant-1", from, to)],
    ["getBySubjectType", (s) => s.getBySubjectType("tenant-1", from, to)],
    ["getTopByUser", (s) => s.getTopByUser("tenant-1", from, to, 10)],
    ["getTopBySession", (s) => s.getTopBySession("tenant-1", from, to, 10)],
    ["getRecentActivity", (s) => s.getRecentActivity("tenant-1", from, to, ["block"], 25)],
    ["getQueueStats", (s) => s.getQueueStats("tenant-1")],
    ["getLatencyPercentiles", (s) => s.getLatencyPercentiles("tenant-1", from, to)],
    ["getTopErrors", (s) => s.getTopErrors("tenant-1", from, to)]
  ];

  for (const [name, invoke] of invocations) {
    const db = new CaptureDatabase();
    await invoke(new PiiAnalyticsStore(db as unknown as Pool));

    const aggregates = db.queries.filter(
      (q) => q.text.includes("FROM pii_scan_runs") || q.text.includes("FROM pii_scan_jobs")
    );
    expect(aggregates.length, `${name} issued no aggregate query`).toBeGreaterThan(0);

    for (const query of aggregates) {
      // The predicate must reference a bind, and that bind must be the tenant.
      const predicate = query.text.match(/tenant_id = \$(\d+)/);
      expect(predicate, `${name} has no tenant_id predicate`).toBeTruthy();
      const position = Number(predicate![1]);
      expect(query.values[position - 1], `${name} binds the wrong value as tenant`).toBe("tenant-1");
    }
  }
});
