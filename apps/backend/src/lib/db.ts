import { Pool, type PoolClient } from "pg";

import type { AppConfig } from "../config.js";

export { Pool } from "pg";

/**
 * Roll back without masking the error that caused the rollback, and report
 * whether the rollback itself failed.
 *
 * Two things are going on:
 *
 * 1. A bare `await client.query("ROLLBACK")` inside a catch throws when the
 *    connection itself is what broke — a common cause of the original failure —
 *    replacing the real error with an unhelpful "Connection terminated". So the
 *    rollback error is captured, never thrown.
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
 * The pool every route shares. pg's defaults are wrong for a multi-tenant API:
 *
 * - `max` defaults to 10 for the WHOLE process. The Deep Agents checkpointer got
 *   an explicit 20; this pool serves every request path, so it needs at least as
 *   much headroom.
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

export function createDatabase(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: POOL_MAX,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    statement_timeout: POOL_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: POOL_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    application_name: "cogniplane-backend"
  });
}

/**
 * The RLS-bypassing pool. It gets the same caps as the app pool for the same
 * reasons: it serves the WorkOS auth hook on every request and both background
 * workers, so pg's defaults (max 10, wait forever, no statement timeout) would
 * put an unbounded wait on the hottest path in the process. It is built here
 * rather than inline so the two pools cannot drift apart.
 *
 * `application_name` differs so the two are distinguishable in
 * `pg_stat_activity` — which is the first thing anyone looks at when
 * connections pile up.
 */
export function createPrivilegedDatabase(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: POOL_MAX,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    statement_timeout: POOL_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: POOL_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    application_name: "cogniplane-backend-privileged"
  });
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
