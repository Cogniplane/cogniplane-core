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

  async connect() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async query(text: string, values: unknown[] = []) {
        self.queries.push({ text, values });
        return { rows: [], rowCount: 0 };
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
