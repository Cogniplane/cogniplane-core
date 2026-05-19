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

  // BEGIN, SET LOCAL app.current_tenant_id, the SELECT, COMMIT
  const sqlTexts = db.queries.map((q) => q.text);
  expect(sqlTexts.some((t) => t === "BEGIN")).toBeTruthy();
  expect(sqlTexts.some((t) => t.includes("set_config"))).toBeTruthy();
  expect(sqlTexts.some((t) => t.includes("FROM pii_scan_runs"))).toBeTruthy();
  expect(sqlTexts.some((t) => t === "COMMIT")).toBeTruthy();
});

test("getQueueStats targets pii_scan_jobs (not pii_scan_runs) and ignores range arguments", async () => {
  const db = new CaptureDatabase();
  const store = new PiiAnalyticsStore(db as unknown as Pool);

  await store.getQueueStats("tenant-1");

  const aggregateQuery = db.queries.find((q) => q.text.includes("FROM pii_scan_jobs"));
  expect(aggregateQuery).toBeTruthy();
  expect(aggregateQuery!.values).toEqual([]);
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
  // [from, to, actionTakenValues (without 'failed'), includeFailed=true, limit]
  expect(aggregateQuery!.values).toEqual([from, to, ["block"], true, 25]);
});
