import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test, expect } from "vitest";

import type { Pool } from "../lib/db.js";

import { applyMigrations } from "./migrate-lib.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const realMigrationsDir = path.resolve(dirname, "../../db/migrations");

type LoggedQuery = { clientId: number; sql: string; params: unknown[] };

class FakeMigrationPool {
  readonly queries: LoggedQuery[] = [];
  connectCount = 0;
  releaseCount = 0;

  constructor(
    private readonly appliedVersions: Set<string> = new Set(),
    private readonly failOnSqlIncluding: string | null = null
  ) {}

  async connect() {
    this.connectCount += 1;
    const clientId = this.connectCount;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        this.queries.push({ clientId, sql, params });
        if (this.failOnSqlIncluding && sql.includes(this.failOnSqlIncluding)) {
          throw new Error(`Injected failure for: ${this.failOnSqlIncluding}`);
        }
        if (sql.startsWith("SELECT version FROM schema_migrations")) {
          const version = String(params[0]);
          return this.appliedVersions.has(version)
            ? { rows: [{ version }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("INSERT INTO schema_migrations")) {
          this.appliedVersions.add(String(params[0]));
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        this.releaseCount += 1;
      }
    };
  }
}

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
  expect(pool.queries.every((q) => q.clientId === 1)).toBe(true);

  // Each migration's SQL and its schema_migrations record share a transaction.
  const firstFileSql = await readFile(path.join(realMigrationsDir, realFiles[0]!), "utf8");
  const sqls = pool.queries.map((q) => q.sql);
  const beginIndex = sqls.indexOf("BEGIN");
  expect(sqls[beginIndex + 1]).toBe(firstFileSql);
  expect(sqls[beginIndex + 2]).toMatch(/^INSERT INTO schema_migrations/);
  expect(pool.queries[beginIndex + 2]!.params).toEqual([realFiles[0]]);
  expect(sqls[beginIndex + 3]).toBe("COMMIT");
  expect(sqls.filter((s) => s === "BEGIN")).toHaveLength(realFiles.length);
  expect(sqls.filter((s) => s === "COMMIT")).toHaveLength(realFiles.length);
});

test("applyMigrations skips already-applied versions", async () => {
  const realFiles = (await readdir(realMigrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const pool = new FakeMigrationPool(new Set(realFiles.slice(0, 2)));

  const applied = await applyMigrations(pool as unknown as Pool, realMigrationsDir, () => {});

  expect(applied).toEqual(realFiles.slice(2));
});

test("applyMigrations rolls back the failing migration, rethrows, and releases the client", async () => {
  const realFiles = (await readdir(realMigrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const secondFileSql = await readFile(path.join(realMigrationsDir, realFiles[1]!), "utf8");
  // Fail on a fragment unique to the second migration's body.
  const pool = new FakeMigrationPool(new Set(), secondFileSql.slice(0, 40));

  await expect(
    applyMigrations(pool as unknown as Pool, realMigrationsDir, () => {})
  ).rejects.toThrow(/Injected failure/);

  const sqls = pool.queries.map((q) => q.sql);
  expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
  expect(pool.releaseCount).toBe(1);
  // The first migration committed; the failed one was never recorded.
  expect(sqls.filter((s) => s === "COMMIT")).toHaveLength(1);
  expect(
    pool.queries.filter((q) => q.sql.startsWith("INSERT INTO schema_migrations")).map((q) => q.params[0])
  ).toEqual([realFiles[0]]);
});
