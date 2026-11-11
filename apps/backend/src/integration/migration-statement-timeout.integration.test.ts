import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { describe, expect, test } from "vitest";

import type { AppConfig } from "../config.js";
import {
  createDatabase,
  createMaintenanceDatabase,
  createMigrationDatabase,
  createPrivilegedDatabase,
  operationalPoolOptions
} from "../lib/db.js";
import { applyMigrations } from "../scripts/migrate-lib.js";
import {
  adminDatabaseUrl,
  runAppUserUrl,
  runMaintenanceUrl,
  runSuperuserUrl,
  superuserPool
} from "./support/database.js";

// The serving pools stop a statement after 30 seconds. These tests use a much
// shorter comparison limit, and a statement that always takes longer than it,
// so that they run in about a second and do not depend on timing.
const SHORT_STATEMENT_TIMEOUT_MS = 200;
const LONG_STATEMENT = "SELECT pg_sleep(0.8)";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type SessionLimits = {
  statement_timeout: string;
  lock_timeout: string;
  idle_in_transaction_session_timeout: string;
  application_name: string;
};

const SESSION_LIMITS_SQL = `
  SELECT current_setting('statement_timeout') AS statement_timeout,
         current_setting('lock_timeout') AS lock_timeout,
         current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout,
         current_setting('application_name') AS application_name
`;

/** The limits that PostgreSQL applies to a new connection of the pool. */
async function sessionLimits(pool: pg.Pool): Promise<SessionLimits> {
  const { rows } = await pool.query<SessionLimits>(SESSION_LIMITS_SQL);
  return rows[0]!;
}

/** A serving pool whose statement limit is short enough for a fast test. */
function shortTimeoutPool(): pg.Pool {
  return new pg.Pool({
    ...operationalPoolOptions({
      connectionString: runSuperuserUrl(),
      applicationName: "cogniplane-it-short-statement-timeout",
      max: 1
    }),
    statement_timeout: SHORT_STATEMENT_TIMEOUT_MS
  });
}

/**
 * A migration that runs the long statement, then records the limits of its
 * own session in a table.
 */
function longMigration(table: string): string {
  return `${LONG_STATEMENT};
CREATE TABLE ${table} AS ${SESSION_LIMITS_SQL};
`;
}

async function withMigrationsDir(work: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "migration-statement-timeout-"));
  try {
    await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function dropProbe(table: string, versions: string[]): Promise<void> {
  const db = superuserPool();
  await db.query(`DROP TABLE IF EXISTS ${table}`);
  await db.query("DELETE FROM schema_migrations WHERE version = ANY($1)", [versions]);
}

describe.skipIf(!adminDatabaseUrl())("migration statement timeout", () => {
  test("PostgreSQL gives the migration pool no statement timeout and keeps 30 seconds on the serving pools", async () => {
    const migration = createMigrationDatabase(runSuperuserUrl());
    const serving = {
      "cogniplane-backend": createDatabase({ DATABASE_URL: runAppUserUrl() } as AppConfig),
      "cogniplane-backend-maintenance": createMaintenanceDatabase(runMaintenanceUrl()),
      "cogniplane-operator": createPrivilegedDatabase(runSuperuserUrl())
    };
    try {
      expect(await sessionLimits(migration)).toEqual({
        statement_timeout: "0",
        lock_timeout: "0",
        idle_in_transaction_session_timeout: "1min",
        application_name: "cogniplane-migrate"
      });
      for (const [applicationName, pool] of Object.entries(serving)) {
        expect(await sessionLimits(pool)).toEqual({
          statement_timeout: "30s",
          lock_timeout: "0",
          idle_in_transaction_session_timeout: "1min",
          application_name: applicationName
        });
      }
    } finally {
      await Promise.all([migration, ...Object.values(serving)].map((pool) => pool.end()));
    }
  });

  test("the migration command applies a statement that a serving pool stops, and keeps the checksum", async () => {
    const table = "migration_statement_timeout_probe";
    const version = "999993_long_statement.sql";
    const sql = longMigration(table);
    const comparison = shortTimeoutPool();
    const migration = createMigrationDatabase(runSuperuserUrl());
    try {
      await withMigrationsDir(async (dir) => {
        // Control: the statement is longer than the comparison limit.
        await expect(comparison.query(LONG_STATEMENT)).rejects.toMatchObject({
          code: "57014",
          message: "canceling statement due to statement timeout"
        });

        await writeFile(path.join(dir, version), sql);
        await expect(applyMigrations(migration, dir, () => {})).resolves.toEqual([version]);

        const db = superuserPool();
        expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([{
          statement_timeout: "0",
          lock_timeout: "10s",
          idle_in_transaction_session_timeout: "1min",
          application_name: "cogniplane-migrate"
        }]);
        expect((await db.query("SELECT checksum FROM schema_migrations WHERE version = $1", [version])).rows)
          .toEqual([{ checksum: sha256(sql) }]);

        // An edit to the applied file still stops the run before any SQL.
        await writeFile(path.join(dir, version), `${sql}-- edited\n`);
        await expect(applyMigrations(migration, dir, () => {})).rejects.toThrow(
          `Migration ${version} changed after this database applied it`
        );
      });
    } finally {
      await Promise.all([comparison.end(), migration.end()]);
      await dropProbe(table, [version]);
    }
  });

  test("a migration outlasts the statement timeout that its connection inherited, and the pool keeps that timeout", async () => {
    const table = "migration_inherited_timeout_probe";
    const version = "999994_inherited_timeout.sql";
    // The old runner built its pool like this, with a 30-second limit.
    const inherited = shortTimeoutPool();
    try {
      await withMigrationsDir(async (dir) => {
        await writeFile(path.join(dir, version), longMigration(table));

        await expect(applyMigrations(inherited, dir, () => {})).resolves.toEqual([version]);

        const probe = await superuserPool().query<SessionLimits>(`SELECT * FROM ${table}`);
        expect(probe.rows[0]).toMatchObject({ statement_timeout: "0", lock_timeout: "10s" });
        // The runner destroyed its connection, so the session limits stayed in
        // the migration. The next connection gets the pool's limit again.
        expect(inherited.totalCount).toBe(0);
        expect((await sessionLimits(inherited)).statement_timeout).toBe(`${SHORT_STATEMENT_TIMEOUT_MS}ms`);
      });
    } finally {
      await inherited.end();
      await dropProbe(table, [version]);
    }
  });

  test("with no statement timeout, a lock wait still stops the migration, which rolls back", async () => {
    const table = "migration_lock_wait_probe";
    const blockedVersion = "999995_blocked_ddl.sql";
    const laterVersion = "999996_after_blocked.sql";
    const laterTable = "migration_lock_wait_later";
    const db = superuserPool();
    const migration = createMigrationDatabase(runSuperuserUrl());
    const blocker = await db.connect();
    try {
      await db.query(`CREATE TABLE ${table} (id integer)`);
      await withMigrationsDir(async (dir) => {
        await writeFile(path.join(dir, blockedVersion), `ALTER TABLE ${table} ADD COLUMN added integer;`);
        await writeFile(path.join(dir, laterVersion), `CREATE TABLE ${laterTable} (id integer);`);
        // An open transaction that read the table holds a lock that ALTER
        // TABLE must wait for.
        await blocker.query("BEGIN");
        await blocker.query(`SELECT * FROM ${table}`);

        // Only lock_timeout can end the wait: the session has no statement timeout.
        await expect(applyMigrations(migration, dir, () => {})).rejects.toMatchObject({
          code: "55P03",
          message: "canceling statement due to lock timeout"
        });
        expect(migration.totalCount).toBe(0);
      });
      await blocker.query("ROLLBACK");

      const recorded = await db.query(
        "SELECT version FROM schema_migrations WHERE version = ANY($1)",
        [[blockedVersion, laterVersion]]
      );
      expect(recorded.rowCount).toBe(0);
      const columns = await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name",
        [table]
      );
      expect(columns.rows).toEqual([{ column_name: "id" }]);
      expect((await db.query("SELECT to_regclass($1) AS later", [laterTable])).rows[0]?.later).toBeNull();
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await migration.end();
      await db.query(`DROP TABLE IF EXISTS ${laterTable}`);
      await dropProbe(table, [blockedVersion, laterVersion]);
    }
  }, 20_000);
});
