import { Pool, type PoolClient, type PoolConfig } from "pg";

import type { AppConfig } from "../config.js";

export { Pool } from "pg";

/**
 * Roll back without masking the error that caused the rollback, and report
 * whether the rollback itself failed.
 *
 * Two things are going on:
 *
 * 1. A bare `await client.query("ROLLBACK")` inside a catch throws when the
 *    connection itself is what broke. That replaces the real error with an
 *    unhelpful "Connection terminated". So this helper captures the rollback
 *    error and never throws it.
 *
 * 2. The returned error MUST be handed to `client.release(err)`. `pg-pool` only
 *    destroys a client when release is given an error (or the client is already
 *    non-queryable); it does NOT detect an open transaction. A still-queryable
 *    client whose ROLLBACK failed would therefore go back into the shared pool
 *    with its transaction — and its `SET LOCAL app.current_tenant_id` — still
 *    live. The next borrower's `BEGIN` would be a no-op inside that transaction,
 *    so its queries would run under the PREVIOUS tenant's RLS context. That is a
 *    cross-tenant read, which is why this returns the error instead of
 *    swallowing it outright.
 */
async function rollbackQuietly(client: PoolClient): Promise<Error | null> {
  try {
    await client.query("ROLLBACK");
    return null;
  } catch (rollbackError) {
    // Deliberately not rethrown — the caller rethrows the original error.
    return rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
  }
}

export async function withTransaction<T>(
  db: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await db.connect();
  // Set when ROLLBACK failed, so `release` destroys the client rather than
  // returning an open transaction to the pool. See rollbackQuietly.
  let rollbackError: Error | null = null;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    rollbackError = await rollbackQuietly(client);
    throw error;
  } finally {
    client.release(rollbackError ?? undefined);
  }
}

/**
 * Limits for every pool that serves requests, workers, or agent turns. pg's
 * defaults are wrong for a multi-tenant API:
 *
 * - `max` defaults to 10 for the WHOLE process. The app pool serves every
 *   request path, so it needs more headroom.
 * - `connectionTimeoutMillis` defaults to 0 = wait forever. Under pool
 *   exhaustion that turns into unbounded request latency instead of a fast,
 *   visible failure.
 * - `statement_timeout` / `idle_in_transaction_session_timeout` default to
 *   disabled server-side, so one wedged query inside `withTenantScope` holds a
 *   connection (and its RLS transaction) indefinitely. These are the only thing
 *   that breaks such a slot loose without a process restart. The statement cap
 *   sits above the slowest legitimate query (admin analytics aggregates) and far
 *   below any turn-level timeout, so it never trips a healthy request.
 */
const POOL_MAX = 20;
const POOL_CONNECTION_TIMEOUT_MS = 10_000;
const POOL_STATEMENT_TIMEOUT_MS = 30_000;
const POOL_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/** The properties that keep one pool apart from the others. */
export type PoolIdentity = {
  connectionString: string;
  /** Shows the pool's connections in `pg_stat_activity`. */
  applicationName: string;
  max: number;
};

/**
 * Pool options for a request, worker, or agent-turn pool. `createOperationalPool`
 * applies them, so that no such pool gets pg's unbounded defaults.
 */
export function operationalPoolOptions(identity: PoolIdentity): PoolConfig {
  return {
    connectionString: identity.connectionString,
    max: identity.max,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    statement_timeout: POOL_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: POOL_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    application_name: identity.applicationName
  };
}

/** Receives the errors of idle pool connections. The Fastify logger fits. */
export type PoolErrorLogger = {
  error(meta: object, msg: string): void;
};

// For operator scripts, which have no Fastify logger. Same line format as
// lib/redis.ts.
const defaultPoolErrorLogger: PoolErrorLogger = {
  error(meta, msg) {
    console.error(JSON.stringify({ level: "error", msg, ...meta }));
  }
};

/**
 * Build a request, worker, or agent-turn pool: the operational limits and an
 * `error` listener. Use this for every such pool.
 *
 * When an idle client loses its connection, pg-pool removes the client and
 * emits `error` on the pool. A Postgres restart or failover, a dropped NAT
 * entry or pg_terminate_backend causes this. With no listener, the event
 * throws, and server.ts stops the process on the uncaught exception. Every
 * in-flight turn on the replica then stops, although the pool opens a new
 * connection on the next checkout.
 *
 * The log line holds the pool name, the error code and the message. It never
 * holds the error object. pg-pool puts the client in `err.client`, and the
 * client holds the connection parameters: user, host, password and TLS key
 * material.
 */
export function createOperationalPool(
  identity: PoolIdentity,
  logger: PoolErrorLogger = defaultPoolErrorLogger
): Pool {
  const pool = new Pool(operationalPoolOptions(identity));
  pool.on("error", (error) => {
    const code = (error as { code?: unknown }).code;
    logger.error(
      {
        pool: identity.applicationName,
        ...(typeof code === "string" ? { code } : {}),
        err: error.message
      },
      "idle database connection failed"
    );
  });
  return pool;
}

/** The pool every route shares. */
export function createDatabase(config: AppConfig, logger?: PoolErrorLogger): Pool {
  return createOperationalPool({
    connectionString: config.DATABASE_URL,
    applicationName: "cogniplane-backend",
    max: POOL_MAX
  }, logger);
}

/**
 * The RLS-bypassing pool. It gets the same caps as the app pool for the same
 * reasons: it serves the WorkOS auth hook on every request and both background
 * workers, so pg's defaults (max 10, wait forever, no statement timeout) would
 * put an unbounded wait on the hottest path in the process. It is built here
 * rather than inline so the two pools cannot drift apart.
 *
 * `application_name` differs, so `pg_stat_activity` shows the two pools apart.
 */
export function createMaintenanceDatabase(connectionString: string, logger?: PoolErrorLogger): Pool {
  return createOperationalPool(
    { connectionString, applicationName: "cogniplane-backend-maintenance", max: POOL_MAX },
    logger
  );
}

// Reserved for explicit operator commands such as tenant offboarding.
export function createPrivilegedDatabase(connectionString: string, logger?: PoolErrorLogger): Pool {
  return createOperationalPool({ connectionString, applicationName: "cogniplane-operator", max: POOL_MAX }, logger);
}

export async function withTenantScope<T>(
  db: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await db.connect();
  // Critical here specifically: this transaction carries `SET LOCAL
  // app.current_tenant_id`. A client released back into the pool with that
  // transaction still open would serve the NEXT borrower under this tenant's RLS
  // context. See rollbackQuietly.
  let rollbackError: Error | null = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    rollbackError = await rollbackQuietly(client);
    throw error;
  } finally {
    client.release(rollbackError ?? undefined);
  }
}

// Escape LIKE/ILIKE wildcards (%, _, \) so a user-supplied query is always
// matched literally when interpolated into a bound `%...%` pattern.
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function ensureUser(db: Pool, userId: string): Promise<void> {
  await db.query(
    `
      INSERT INTO users (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );
}
