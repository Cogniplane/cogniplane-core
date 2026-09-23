import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";

import { applyMigrations, assertUniqueVersionPrefixes } from "./migrate-lib.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const realMigrationsDir = path.resolve(dirname, "../../db/migrations");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type LoggedQuery = { clientId: number; sql: string; params: unknown[] };

class FakeMigrationPool {
  readonly queries: LoggedQuery[] = [];
  connectCount = 0;
  releaseCount = 0;
  destroyed = false;

  // Applied version → recorded checksum (null for a row from before checksums).
  readonly appliedVersions: Map<string, string | null>;

  constructor(
    appliedVersions: Iterable<string> | Map<string, string | null> = [],
    private readonly failOnSqlIncluding: string | null = null
  ) {
    this.appliedVersions = appliedVersions instanceof Map
      ? appliedVersions
      : new Map([...appliedVersions].map((version) => [version, null]));
  }

  async connect() {
    this.connectCount += 1;
    const clientId = this.connectCount;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        this.queries.push({ clientId, sql, params });
        if (this.failOnSqlIncluding && sql.includes(this.failOnSqlIncluding)) {
          throw new Error(`Injected failure for: ${this.failOnSqlIncluding}`);
        }
        if (sql.startsWith("SELECT checksum FROM schema_migrations")) {
          const version = String(params[0]);
          return this.appliedVersions.has(version)
            ? { rows: [{ checksum: this.appliedVersions.get(version) }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("INSERT INTO schema_migrations") || sql.startsWith("UPDATE schema_migrations")) {
          this.appliedVersions.set(String(params[0]), String(params[1]));
        }
        return { rows: [], rowCount: 0 };
      },
      release: (destroy: boolean) => {
        this.releaseCount += 1;
        this.destroyed = destroy;
      }
    };
  }
}

test("assertUniqueVersionPrefixes rejects two migrations claiming the same version", () => {
  expect(() =>
    assertUniqueVersionPrefixes(["005_alpha.sql", "005_beta.sql"])
  ).toThrow(/Duplicate migration version prefix "005".*005_alpha\.sql.*005_beta\.sql/s);

  // Distinct prefixes, zero-padding differences, and unprefixed files are fine.
  expect(() =>
    assertUniqueVersionPrefixes(["001_a.sql", "010_b.sql", "README.md"])
  ).not.toThrow();
});

test("the real migrations directory has no duplicate version prefixes", async () => {
  const realFiles = (await readdir(realMigrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  expect(() => assertUniqueVersionPrefixes(realFiles)).not.toThrow();
});

test("applyMigrations runs the real migration files on a single held client, each in its own transaction", async () => {
  const pool = new FakeMigrationPool();

  const applied = await applyMigrations(pool as unknown as Pool, realMigrationsDir, () => {});

  const realFiles = (await readdir(realMigrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  expect(realFiles.length).toBeGreaterThan(0);
  expect(applied).toEqual(realFiles);

  // Every statement — table creation, version checks, BEGIN/SQL/INSERT/COMMIT —
  // must go through the one held client. pool.query has no same-connection
  // guarantee, which is exactly the bug this guards against.
  expect(pool.connectCount).toBe(1);
  expect(pool.releaseCount).toBe(1);
  expect(pool.destroyed).toBe(true);
  expect(pool.queries[0]?.sql).toBe("SET lock_timeout = '10s'");
  expect(pool.queries[1]?.sql).toBe("SELECT pg_advisory_lock(1129270862, 1)");
  expect(pool.queries.every((q) => q.clientId === 1)).toBe(true);

  // Each migration's SQL and its schema_migrations record share a transaction.
  const firstFileSql = await readFile(path.join(realMigrationsDir, realFiles[0]!), "utf8");
  const sqls = pool.queries.map((q) => q.sql);
  const beginIndex = sqls.indexOf("BEGIN");
  expect(sqls[beginIndex + 1]).toBe(firstFileSql);
  expect(sqls[beginIndex + 2]).toMatch(/^INSERT INTO schema_migrations/);
  expect(pool.queries[beginIndex + 2]!.params).toEqual([realFiles[0], sha256(firstFileSql)]);
  expect(sqls[beginIndex + 3]).toBe("COMMIT");
  expect(sqls.filter((s) => s === "BEGIN")).toHaveLength(realFiles.length);
  expect(sqls.filter((s) => s === "COMMIT")).toHaveLength(realFiles.length);
});

test("applyMigrations skips already-applied versions", async () => {
  const realFiles = (await readdir(realMigrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const pool = new FakeMigrationPool(realFiles.slice(0, 2));

  const applied = await applyMigrations(pool as unknown as Pool, realMigrationsDir, () => {});

  expect(applied).toEqual(realFiles.slice(2));
});

test("deployment setup runs under the migration lock and releases it on failure", async () => {
  const realFiles = (await readdir(realMigrationsDir)).filter((f) => f.endsWith(".sql"));
  const pool = new FakeMigrationPool(new Set(realFiles));
  await expect(applyMigrations(pool as unknown as Pool, realMigrationsDir, () => {}, async (client) => {
    expect(pool.releaseCount).toBe(0);
    await client.query("deployment setup");
    throw new Error("setup failed");
  })).rejects.toThrow("setup failed");
  expect(pool.queries.at(-1)?.sql).toBe("deployment setup");
  expect(pool.destroyed).toBe(true);
});

test("applyMigrations records a checksum for rows applied before checksums existed", async () => {
  const realFiles = (await readdir(realMigrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const firstFileSql = await readFile(path.join(realMigrationsDir, realFiles[0]!), "utf8");
  const pool = new FakeMigrationPool([realFiles[0]!]);

  await applyMigrations(pool as unknown as Pool, realMigrationsDir, () => {});

  expect(pool.appliedVersions.get(realFiles[0]!)).toBe(sha256(firstFileSql));
});

test("applyMigrations fails when an applied migration file changed", async () => {
  const realFiles = (await readdir(realMigrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const pool = new FakeMigrationPool(new Map([[realFiles[0]!, sha256("the old contents")]]));

  await expect(
    applyMigrations(pool as unknown as Pool, realMigrationsDir, () => {})
  ).rejects.toThrow(new RegExp(`Migration ${realFiles[0]} changed after this database applied it`));
  // Nothing was applied, and the client was released.
  expect(pool.queries.some((q) => q.sql === "BEGIN")).toBe(false);
  expect(pool.releaseCount).toBe(1);
});

test("applyMigrations rolls back the failing migration, rethrows, and releases the client", async () => {
  const realFiles = (await readdir(realMigrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const secondFileSql = await readFile(path.join(realMigrationsDir, realFiles[1]!), "utf8");
  // Fail on a fragment unique to the second migration's body.
  const pool = new FakeMigrationPool([], secondFileSql.slice(0, 40));

  await expect(
    applyMigrations(pool as unknown as Pool, realMigrationsDir, () => {})
  ).rejects.toThrow(/Injected failure/);

  const sqls = pool.queries.map((q) => q.sql);
  expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
  expect(pool.releaseCount).toBe(1);
  expect(pool.destroyed).toBe(true);
  // The first migration committed; the failed one was never recorded.
  expect(sqls.filter((s) => s === "COMMIT")).toHaveLength(1);
  expect(
    pool.queries.filter((q) => q.sql.startsWith("INSERT INTO schema_migrations")).map((q) => q.params[0])
  ).toEqual([realFiles[0]]);
});
