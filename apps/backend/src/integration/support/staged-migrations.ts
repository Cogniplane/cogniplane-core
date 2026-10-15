// A throwaway database that a test migrates in steps. The suite database
// already has every migration applied, so a test that needs data from before
// a migration builds its own database, applies the earlier files, writes the
// old rows, then applies the rest.

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { applyMigrations } from "../../scripts/migrate-lib.js";
import { adminDatabaseUrl, dropRunDatabase } from "./database.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

export interface StagedDatabase {
  db: pg.Pool;
  /**
   * Applies the migration files that match and that an earlier call has not
   * applied. Throws when no file matches, so a wrong cut-off cannot pass as a
   * no-op.
   */
  migrate(include: (file: string) => boolean): Promise<void>;
}

/** Runs `work` on a new empty database, then drops the database. */
export async function withStagedDatabase(work: (staged: StagedDatabase) => Promise<void>): Promise<void> {
  const suffix = randomUUID().replace(/-/g, "");
  const database = `cogniplane_it_${suffix}`;
  const admin = new pg.Pool({ connectionString: adminDatabaseUrl(), max: 1 });
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const url = new URL(adminDatabaseUrl()!);
  url.pathname = `/${database}`;
  const db = new pg.Pool({ connectionString: url.toString(), max: 2 });
  const dir = await mkdtemp(path.join(tmpdir(), "staged-migrations-"));
  const linked = new Set<string>();
  try {
    await work({
      db,
      async migrate(include) {
        const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql") && include(file));
        if (files.length === 0) throw new Error("No migration file matches.");
        for (const file of files.filter((name) => !linked.has(name))) {
          await symlink(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
          linked.add(file);
        }
        await applyMigrations(db, dir, () => {});
      }
    });
  } finally {
    await db.end();
    await rm(dir, { recursive: true, force: true });
    await dropRunDatabase(database, `cogniplane_it_role_${suffix}`);
  }
}
