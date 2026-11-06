import type { Pool, PoolClient } from "pg";
import { test, expect } from "vitest";

import type { AppConfig } from "../config.js";
import { createDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import {
  createDatabase,
  createMaintenanceDatabase,
  createPrivilegedDatabase,
  operationalPoolOptions,
  withTenantScope,
  withTransaction
} from "./db.js";

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

// ---------------------------------------------------------------------------
// Serving pool limits
// ---------------------------------------------------------------------------

const OPERATIONAL_LIMITS = {
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 60_000
};

type ServingPool = {
  name: string;
  url: string;
  applicationName: string;
  open(url: string): { pool: Pool; close(): Promise<void> };
};

function plainPool(pool: Pool) {
  return { pool, close: () => pool.end() };
}

// Every pool that serves requests, workers, or agent turns. Add each new
// serving pool here, so that it cannot ship with pg's unbounded defaults.
// Constructing a pool opens no connection.
const SERVING_POOLS: ServingPool[] = [
  {
    name: "app",
    url: "postgres://app_user:app-secret@db.test:5432/cogniplane",
    applicationName: "cogniplane-backend",
    open: (url) => plainPool(createDatabase({ DATABASE_URL: url } as AppConfig))
  },
  {
    name: "maintenance",
    url: "postgres://maintenance_user:maint-secret@db.test:5432/cogniplane",
    applicationName: "cogniplane-backend-maintenance",
    open: (url) => plainPool(createMaintenanceDatabase(url))
  },
  {
    name: "operator",
    url: "postgres://postgres:operator-secret@db.test:5432/cogniplane",
    applicationName: "cogniplane-operator",
    open: (url) => plainPool(createPrivilegedDatabase(url))
  },
  {
    name: "Deep Agents checkpointer",
    url: "postgres://app_user:checkpoint-secret@checkpoints.test:5432/cogniplane",
    applicationName: "cogniplane-deep-agents-checkpointer",
    open: (url) => {
      const saver = createDeepAgentsCheckpointer(url);
      // PostgresSaver keeps the injected pool in a private field.
      return { pool: (saver as unknown as { pool: Pool }).pool, close: () => saver.end() };
    }
  }
];

test("operationalPoolOptions adds the operational limits to the pool identity", () => {
  const identity = { connectionString: "postgres://db.test/cogniplane", applicationName: "cogniplane-test", max: 7 };

  expect(operationalPoolOptions(identity)).toEqual({
    connectionString: "postgres://db.test/cogniplane",
    application_name: "cogniplane-test",
    max: 7,
    ...OPERATIONAL_LIMITS
  });
  expect(identity).toEqual({ connectionString: "postgres://db.test/cogniplane", applicationName: "cogniplane-test", max: 7 });
});

test.each(SERVING_POOLS)("the $name pool keeps its identity and gets the operational limits", async (serving) => {
  const { pool, close } = serving.open(serving.url);
  try {
    expect(pool.options).toMatchObject({
      connectionString: serving.url,
      application_name: serving.applicationName,
      max: 20,
      ...OPERATIONAL_LIMITS
    });
    for (const limit of Object.keys(OPERATIONAL_LIMITS) as Array<keyof typeof OPERATIONAL_LIMITS>) {
      expect(pool.options[limit]).toBeGreaterThan(0);
    }
  } finally {
    await close();
  }
});

test("each serving pool is a separate pool with its own name", async () => {
  const opened = SERVING_POOLS.map((serving) => serving.open(serving.url));
  try {
    expect(new Set(opened.map(({ pool }) => pool)).size).toBe(SERVING_POOLS.length);
    expect(new Set(opened.map(({ pool }) => pool.options.application_name)).size).toBe(SERVING_POOLS.length);
  } finally {
    await Promise.all(opened.map(({ close }) => close()));
  }
});
