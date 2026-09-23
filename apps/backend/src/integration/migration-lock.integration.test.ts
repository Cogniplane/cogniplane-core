import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { describe, expect, test } from "vitest";

import { applyMigrations } from "../scripts/migrate-lib.js";
import { setupDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import { adminDatabaseUrl, runSuperuserUrl, superuserPool } from "./support/database.js";

describe.skipIf(!adminDatabaseUrl())("migration serialization", () => {
  test("the migration lock timeout also bounds a contended advisory lock", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "migration-timeout-test-"));
    const blocker = await superuserPool().connect();
    const runner = new pg.Pool({ connectionString: runSuperuserUrl(), max: 1 });
    try {
      await blocker.query("SELECT pg_advisory_lock(1129270862, 1)");
      await expect(applyMigrations(runner, dir, () => {})).rejects.toMatchObject({
        code: "55P03",
        message: "canceling statement due to lock timeout"
      });
      expect(runner.totalCount).toBe(0);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(1129270862, 1)");
      blocker.release();
      await runner.end();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("checkpointer setup completes while the migration pool's only connection is held", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "migration-checkpointer-test-"));
    const runner = new pg.Pool({
      connectionString: runSuperuserUrl(),
      max: 1,
      connectionTimeoutMillis: 1_000
    });
    try {
      await applyMigrations(runner, dir, () => {}, async (client) => {
        expect(runner.totalCount).toBe(1);
        expect(runner.idleCount).toBe(0);
        await setupDeepAgentsCheckpointer(runSuperuserUrl());
        expect(runner.totalCount).toBe(1);
        expect(runner.waitingCount).toBe(0);
        const result = await client.query("SELECT to_regclass('deep_agents.checkpoints') AS checkpoints");
        expect(result.rows[0]?.checkpoints).toBe("deep_agents.checkpoints");
      });
      expect(runner.totalCount).toBe(0);
    } finally {
      await runner.end();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("concurrent runners apply a pending migration exactly once", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "migration-lock-test-"));
    const version = "999999_lock_regression.sql";
    const db = superuserPool();
    try {
      await writeFile(path.join(dir, version), "CREATE TABLE migration_lock_regression (id integer);");
      const results = await Promise.all([
        applyMigrations(db, dir, () => {}),
        applyMigrations(db, dir, () => {})
      ]);
      expect(results.flat()).toEqual([version]);
      expect((await db.query("SELECT version FROM schema_migrations WHERE version = $1", [version])).rowCount).toBe(1);
    } finally {
      await db.query("DROP TABLE IF EXISTS migration_lock_regression");
      await db.query("DELETE FROM schema_migrations WHERE version = $1", [version]);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
