import type { Pool, PoolClient } from "pg";
import { test, expect, vi } from "vitest";

import type { AppConfig } from "../config.js";
import { createDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import {
  createDatabase,
  createMaintenanceDatabase,
  createMigrationDatabase,
  createPrivilegedDatabase,
  operationalPoolOptions,
  type PoolErrorLogger,
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

// A failed ROLLBACK must destroy the client. It must not return it to the pool.
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

const OPERATIONAL_LIMITS = {
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 60_000
};

type ServingPool = {
  name: string;
  url: string;
  /** The password in `url`. It must never reach a log line. */
  password: string;
  applicationName: string;
  open(url: string, logger?: PoolErrorLogger): { pool: Pool; close(): Promise<void> };
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
    password: "app-secret",
    applicationName: "cogniplane-backend",
    open: (url, logger) => plainPool(createDatabase({ DATABASE_URL: url } as AppConfig, logger))
  },
  {
    name: "maintenance",
    url: "postgres://maintenance_user:maint-secret@db.test:5432/cogniplane",
    password: "maint-secret",
    applicationName: "cogniplane-backend-maintenance",
    open: (url, logger) => plainPool(createMaintenanceDatabase(url, logger))
  },
  {
    name: "operator",
    url: "postgres://postgres:operator-secret@db.test:5432/cogniplane",
    password: "operator-secret",
    applicationName: "cogniplane-operator",
    open: (url, logger) => plainPool(createPrivilegedDatabase(url, logger))
  },
  {
    name: "Deep Agents checkpointer",
    url: "postgres://app_user:checkpoint-secret@checkpoints.test:5432/cogniplane",
    password: "checkpoint-secret",
    applicationName: "cogniplane-deep-agents-checkpointer",
    open: (url, logger) => {
      const saver = createDeepAgentsCheckpointer(url, logger);
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

// When an idle client loses its connection, pg-pool removes the client and emits
// `error` on the pool. An `error` event with no listener throws, and server.ts
// stops the process on an uncaught exception. So each serving pool must log the
// error instead. pool-idle-error.integration.test.ts lets PostgreSQL drop a real
// connection.

const TERMINATED = "terminating connection due to administrator command";

/**
 * Emit what `makeIdleListener` in pg-pool emits for an idle client error. The
 * error gets the client in `err.client`, and the client holds the connection
 * parameters.
 */
function emitIdleConnectionError(pool: Pool, url: string, code?: string): void {
  const client = { connectionParameters: { connectionString: url, password: new URL(url).password } };
  const error = Object.assign(new Error(code ? TERMINATED : "Connection terminated unexpectedly"), { client }, code ? { code } : {});
  pool.emit("error", error, client);
}

function recordingPoolLogger(): { logger: PoolErrorLogger; logged: Array<{ meta: object; msg: string }> } {
  const logged: Array<{ meta: object; msg: string }> = [];
  return { logger: { error: (meta, msg) => { logged.push({ meta, msg }); } }, logged };
}

// The migration command is not a serving pool. A 30-second statement cap would
// stop a long schema validation or backfill, and the next run would fail in
// the same way. applyMigrations sets the session limits of the migration
// itself: no statement timeout, and a 10-second lock timeout.
const MIGRATION_URL = "postgres://postgres:migrate-secret@db.test:5432/cogniplane";

test("the migration pool has its own identity, one connection and no statement timeout", async () => {
  const pool = createMigrationDatabase(MIGRATION_URL);
  try {
    expect(pool.options).toMatchObject({
      connectionString: MIGRATION_URL,
      application_name: "cogniplane-migrate",
      max: 1,
      connectionTimeoutMillis: 10_000,
      idle_in_transaction_session_timeout: 60_000
    });
    expect(pool.options.statement_timeout).toBeUndefined();
  } finally {
    await pool.end();
  }
});

test("the migration pool logs an idle connection error and does not throw", async () => {
  const { logger, logged } = recordingPoolLogger();
  const pool = createMigrationDatabase(MIGRATION_URL, logger);
  try {
    expect(() => emitIdleConnectionError(pool, MIGRATION_URL, "57P01")).not.toThrow();
    expect(logged).toEqual([{
      msg: "idle database connection failed",
      meta: { pool: "cogniplane-migrate", code: "57P01", err: TERMINATED }
    }]);
    expect(JSON.stringify(logged)).not.toContain("migrate-secret");
  } finally {
    await pool.end();
  }
});

test.each(SERVING_POOLS)("the $name pool logs an idle connection error and does not throw", async (serving) => {
  const { logger, logged } = recordingPoolLogger();
  const { pool, close } = serving.open(serving.url, logger);
  try {
    expect(() => emitIdleConnectionError(pool, serving.url, "57P01")).not.toThrow();

    // The line holds only the pool name, the error code and the message. It
    // never holds the error object, because `err.client` holds the connection
    // parameters.
    expect(logged).toEqual([{
      msg: "idle database connection failed",
      meta: { pool: serving.applicationName, code: "57P01", err: TERMINATED }
    }]);
    expect(JSON.stringify(logged)).not.toContain(serving.password);
  } finally {
    await close();
  }
});

test("an idle connection error with no code logs no code field", async () => {
  const { logger, logged } = recordingPoolLogger();
  const pool = createDatabase({ DATABASE_URL: SERVING_POOLS[0].url } as AppConfig, logger);
  try {
    emitIdleConnectionError(pool, SERVING_POOLS[0].url);

    expect(logged).toEqual([{
      msg: "idle database connection failed",
      meta: { pool: "cogniplane-backend", err: "Connection terminated unexpectedly" }
    }]);
  } finally {
    await pool.end();
  }
});

// Operator scripts such as migrate, delete-tenant and auth-bootstrap pass no
// logger.
test("without a logger, a pool writes the idle connection error as one JSON line", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const url = "postgres://postgres:operator-secret@db.test:5432/cogniplane";
  const pool = createPrivilegedDatabase(url);
  try {
    expect(() => emitIdleConnectionError(pool, url, "57P01")).not.toThrow();

    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      level: "error",
      msg: "idle database connection failed",
      pool: "cogniplane-operator",
      code: "57P01",
      err: TERMINATED
    });
    expect(line).not.toContain("operator-secret");
  } finally {
    consoleError.mockRestore();
    await pool.end();
  }
});
