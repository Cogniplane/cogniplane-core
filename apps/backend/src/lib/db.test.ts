import type { Pool, PoolClient } from "pg";
import { test, expect } from "vitest";

import { withTenantScope, withTransaction } from "./db.js";

/**
 * The shared `FakePool` (test-helpers/fake-pool.ts) returns a client whose
 * `release()` is a no-op and whose `query()` swallows BEGIN/COMMIT/ROLLBACK/
 * set_config. That makes it impossible to observe ROLLBACK ordering or count
 * releases, which is exactly what these RLS-critical tests must assert. So we
 * build a recording fake Pool here: every client.query() is logged in order,
 * and client.release() bumps a counter.
 */
type RecordedQuery = { text: string; values: unknown[] };

function makeRecordingPool(): {
  pool: Pool;
  queries: RecordedQuery[];
  releaseCount: () => number;
} {
  const queries: RecordedQuery[] = [];
  let releaseCount = 0;
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    release() {
      releaseCount += 1;
    }
  };
  const pool = {
    async connect() {
      return client as unknown as PoolClient;
    }
  };
  return {
    pool: pool as unknown as Pool,
    queries,
    releaseCount: () => releaseCount
  };
}

const SENTINEL = "SELECT 'callback-sentinel'";

// ---------------------------------------------------------------------------
// withTenantScope
// ---------------------------------------------------------------------------

test("withTenantScope wraps the callback in BEGIN/set_config/COMMIT and commits on success", async () => {
  const { pool, queries, releaseCount } = makeRecordingPool();

  const result = await withTenantScope(pool, "tenant-42", async (client) => {
    await client.query(SENTINEL);
    return "done";
  });

  expect(result).toBe("done");

  const texts = queries.map((q) => q.text);
  expect(texts).toEqual([
    "BEGIN",
    "SELECT set_config('app.current_tenant_id', $1, true)",
    SENTINEL,
    "COMMIT"
  ]);

  // The tenant id is bound as the set_config value (the observable signal that
  // RLS is scoped to the right tenant).
  const setConfig = queries[1];
  expect(setConfig.values[0]).toBe("tenant-42");

  // set_config must run BEFORE any callback query, otherwise the callback could
  // read/write outside the tenant's RLS scope.
  expect(texts.indexOf("SELECT set_config('app.current_tenant_id', $1, true)")).toBeLessThan(
    texts.indexOf(SENTINEL)
  );

  expect(releaseCount()).toBe(1);
});

test("withTenantScope rejects with the same error, issues ROLLBACK (not COMMIT), and releases once", async () => {
  const { pool, queries, releaseCount } = makeRecordingPool();
  const boom = new Error("callback exploded");

  await expect(
    withTenantScope(pool, "tenant-42", async (client) => {
      await client.query(SENTINEL);
      throw boom;
    })
  ).rejects.toBe(boom);

  const texts = queries.map((q) => q.text);
  expect(texts).toContain("BEGIN");
  expect(texts).toContain("ROLLBACK");
  expect(texts).not.toContain("COMMIT");

  // The failing callback query ran, then ROLLBACK undid it.
  expect(texts.indexOf(SENTINEL)).toBeLessThan(texts.indexOf("ROLLBACK"));

  expect(releaseCount()).toBe(1);
});

// ---------------------------------------------------------------------------
// withTransaction
// ---------------------------------------------------------------------------

test("withTransaction wraps the callback in BEGIN/COMMIT and commits on success", async () => {
  const { pool, queries, releaseCount } = makeRecordingPool();

  const result = await withTransaction(pool, async (client) => {
    await client.query(SENTINEL);
    return 7;
  });

  expect(result).toBe(7);

  const texts = queries.map((q) => q.text);
  expect(texts).toEqual(["BEGIN", SENTINEL, "COMMIT"]);

  expect(releaseCount()).toBe(1);
});

test("withTransaction rejects with the same error, issues ROLLBACK (not COMMIT), and releases once", async () => {
  const { pool, queries, releaseCount } = makeRecordingPool();
  const boom = new Error("transaction exploded");

  await expect(
    withTransaction(pool, async (client) => {
      await client.query(SENTINEL);
      throw boom;
    })
  ).rejects.toBe(boom);

  const texts = queries.map((q) => q.text);
  expect(texts).toContain("BEGIN");
  expect(texts).toContain("ROLLBACK");
  expect(texts).not.toContain("COMMIT");

  expect(texts.indexOf(SENTINEL)).toBeLessThan(texts.indexOf("ROLLBACK"));

  expect(releaseCount()).toBe(1);
});
