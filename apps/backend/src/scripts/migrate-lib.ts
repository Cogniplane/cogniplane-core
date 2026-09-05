import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Pool, PoolClient } from "pg";

import { DEEP_AGENTS_CHECKPOINT_SCHEMA } from "../services/deep-agents/deep-agents-checkpointer.js";

/**
 * Reject two migrations sharing a numeric prefix (e.g. two `005_` files).
 *
 * Migrations are tracked by full filename, so duplicates DO apply correctly —
 * but the version number is what humans reason about when asking "did this land
 * before that?", and two files claiming the same one makes the ordering
 * ambiguous on sight. Failing the migration run is the only way this stays true
 * over time; it's a cheap check on a directory listing.
 */
export function assertUniqueVersionPrefixes(files: string[]): void {
  const seen = new Map<string, string>();
  for (const file of files) {
    const prefix = /^(\d+)/.exec(file)?.[1];
    if (!prefix) continue;
    const existing = seen.get(prefix);
    if (existing) {
      throw new Error(
        `Duplicate migration version prefix "${prefix}": ${existing} and ${file}. ` +
          "Renumber one of them so version order is unambiguous."
      );
    }
    seen.set(prefix, file);
  }
}

/**
 * Applies pending migrations from `migrationsDir` in sorted filename order.
 *
 * All statements run on ONE client held for the whole loop. Issuing
 * BEGIN/SQL/COMMIT through pool.query would let each statement check out a
 * different connection, so a migration could run in autocommit outside its
 * transaction, apply without being recorded, and re-apply on the next run.
 *
 * Returns the list of migration files applied in this run.
 */
export async function applyMigrations(
  db: Pool,
  migrationsDir: string,
  log: (message: string) => void = console.log
): Promise<string[]> {
  const client = await db.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    assertUniqueVersionPrefixes(files);
    const applied: string[] = [];

    for (const file of files) {
      const alreadyApplied = await client.query(
        "SELECT version FROM schema_migrations WHERE version = $1 LIMIT 1",
        [file]
      );

      if (alreadyApplied.rowCount) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`Applied migration ${file}`);
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return applied;
  } finally {
    client.release();
  }
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // C0 control chars (0x00-0x1F) and DEL (0x7F) cannot be safely
    // interpolated into the DO block below.
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function escapeAppUserPassword(password: string): string {
  if (password.includes("$$") || hasControlCharacter(password)) {
    throw new Error(
      "APP_USER_PASSWORD contains characters that cannot be safely interpolated " +
        "into the migrations DO block ($$ or control chars). Use a different password."
    );
  }
  return password.replace(/'/g, "''");
}

/** The unprivileged role production connects as. */
export const DEFAULT_APP_ROLE = "app_user";

/**
 * Role names are interpolated (CREATE ROLE takes no bind parameters), so the
 * only accepted shape is a plain lowercase identifier. That rules out quoting
 * and injection without needing to reason about either.
 */
function assertSafeRoleName(role: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error(
      `Invalid role name "${role}". Expected a lowercase identifier ` +
        "([a-z_][a-z0-9_]*, max 63 chars) — role names are interpolated, not bound."
    );
  }
}

/**
 * Create or update the unprivileged `app_user` role and (re-)apply its grants.
 *
 * Lives here rather than inline in `migrate.ts` so the integration harness
 * runs the SAME role and grant setup production migrations do. That sharing is
 * the point: a harness with its own copy of the grants can pass while
 * production migration is broken. Drop the `deep_agents` grant from one copy
 * and the checkpointer test still succeeds against the other, which is exactly
 * the class of failure the harness exists to catch.
 *
 * Idempotent, and safe to re-run: the role may be absent if migrations were
 * previously applied without it, and the grants must be re-applied every time
 * because a later migration can add tables the earlier grant never covered.
 *
 * Runs on ONE pinned client. `pool.query()` checks out a connection per call,
 * so a separate `SET standard_conforming_strings` could land on a different
 * connection than the DO block and the quote-doubling below would then be
 * interpreted wrong.
 */
export async function ensureAppUserRole(
  client: PoolClient,
  password: string,
  role: string = DEFAULT_APP_ROLE
): Promise<void> {
  assertSafeRoleName(role);
  const escaped = escapeAppUserPassword(password);

  // `role` is a parameter only so the integration harness can use a per-run
  // role. Postgres roles are CLUSTER-wide, not per-database: a harness that
  // reused `app_user` would reset the password of the role a locally running
  // backend is connected as, even though it created its own throwaway
  // database. Production always passes the default.
  //
  // CREATE/ALTER ROLE reject parameterized passwords; force ON so the
  // single-quote-doubling in escapeAppUserPassword is interpreted correctly.
  await client.query("SET standard_conforming_strings = on");
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role} LOGIN PASSWORD '${escaped}';
      ELSE
        ALTER ROLE ${role} WITH LOGIN PASSWORD '${escaped}';
      END IF;
    END
    $$
  `);

  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  // The runtime Deep Agents checkpointer connects as this role; its tables live
  // in a dedicated schema (superuser-owned). No RLS there — tenant→thread
  // ownership is enforced at the app layer (see
  // services/deep-agents/deep-agents-checkpointer.ts).
  await client.query(`GRANT USAGE ON SCHEMA ${DEEP_AGENTS_CHECKPOINT_SCHEMA} TO ${role}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${DEEP_AGENTS_CHECKPOINT_SCHEMA} TO ${role}`
  );
  await client.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${DEEP_AGENTS_CHECKPOINT_SCHEMA} TO ${role}`
  );
}
