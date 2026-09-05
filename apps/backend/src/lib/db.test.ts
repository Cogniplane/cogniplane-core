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

function makeRecordingPool(options: { failOnSql?: string } = {}): {
  pool: Pool;
  queries: RecordedQuery[];
  releaseCount: () => number;
  releaseArgs: unknown[];
} {
  const queries: RecordedQuery[] = [];
  const releaseArgs: unknown[] = [];
  let releaseCount = 0;
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (options.failOnSql && text === options.failOnSql) {
        throw new Error(`injected failure: ${text}`);
      }
      return { rows: [], rowCount: 0 };
    },
    // `pg-pool` only destroys a client when release is called WITH an error, so
    // the argument is the observable signal for "this client must not go back
    // into the pool" — record it, don't just count calls.
    release(err?: unknown) {
      releaseCount += 1;
      releaseArgs.push(err);
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
    releaseArgs,
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
  // The transaction envelope: opens with BEGIN, scopes RLS via set_config, runs
  // the callback, commits — asserted structurally (a verbatim set_config SQL pin
  // only added rename-fragility; the tenant-binding + ordering checks below are
  // the real contract).
  expect(texts[0]).toBe("BEGIN");
  expect(texts.at(-1)).toBe("COMMIT");
  expect(texts.some((t) => t.includes("set_config") && t.includes("app.current_tenant_id"))).toBe(true);
  expect(texts).toContain(SENTINEL);

  // The tenant id is bound as the set_config value (the observable signal that
  // RLS is scoped to the right tenant).
  const setConfig = queries[1];
  expect(setConfig.values[0]).toBe("tenant-42");

  // set_config must run BEFORE any callback query, otherwise the callback could
  // read/write outside the tenant's RLS scope.
  expect(texts.findIndex((t) => t.includes("set_config"))).toBeLessThan(texts.indexOf(SENTINEL));

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

// ---------------------------------------------------------------------------
// Failed ROLLBACK — the client must be destroyed, not pooled
// ---------------------------------------------------------------------------
//
// pg-pool returns a still-queryable client to the pool unless release() is given
// an error; it does NOT notice an open transaction. If a failed ROLLBACK left a
// withTenantScope transaction open, the next borrower's BEGIN would be a no-op
// inside it and its queries would run under the PREVIOUS tenant's
// app.current_tenant_id — a cross-tenant read. These pin the destroy signal.

test("withTenantScope releases WITH an error when ROLLBACK fails, so the pool discards the client", async () => {
  const { pool, queries, releaseCount, releaseArgs } = makeRecordingPool({ failOnSql: "ROLLBACK" });

  const original = new Error("callback exploded");
  await expect(
    withTenantScope(pool, "tenant-42", async () => {
      throw original;
    })
  ).rejects.toBe(original); // the ROLLBACK failure must not mask the real error

  expect(queries.map((q) => q.text)).toContain("ROLLBACK");
  expect(releaseCount()).toBe(1);
  expect(releaseArgs[0]).toBeInstanceOf(Error);
  expect((releaseArgs[0] as Error).message).toMatch(/injected failure: ROLLBACK/);
});

test("withTransaction releases WITH an error when ROLLBACK fails", async () => {
  const { pool, releaseCount, releaseArgs } = makeRecordingPool({ failOnSql: "ROLLBACK" });

  const original = new Error("callback exploded");
  await expect(
    withTransaction(pool, async () => {
      throw original;
    })
  ).rejects.toBe(original);

  expect(releaseCount()).toBe(1);
  expect(releaseArgs[0]).toBeInstanceOf(Error);
});

test("a successful rollback releases the client back to the pool undamaged", async () => {
  const { pool, releaseCount, releaseArgs } = makeRecordingPool();

  await expect(
    withTenantScope(pool, "tenant-42", async () => {
      throw new Error("callback exploded");
    })
  ).rejects.toThrow("callback exploded");

  // ROLLBACK worked, so the connection is clean — destroying it here would
  // needlessly churn the pool on every ordinary query error.
  expect(releaseCount()).toBe(1);
  expect(releaseArgs[0]).toBeUndefined();
});
