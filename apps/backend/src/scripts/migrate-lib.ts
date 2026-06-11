import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "../lib/db.js";

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
