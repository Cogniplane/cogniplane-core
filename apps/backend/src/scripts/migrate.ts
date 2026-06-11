import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.js";
import { createDatabase } from "../lib/db.js";

import { applyMigrations } from "./migrate-lib.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(dirname, "../../db/migrations");

// Migrations require superuser access to CREATE ROLE, ALTER TABLE, etc.
// If MIGRATION_DATABASE_URL is set, use it; otherwise fall back to DATABASE_URL.
//
// skipRuntimeChecks: migrations only need a DB connection. They must not fail
// because E2B / PII / gateway env vars aren't present in the CI or deploy step
// that runs `pnpm db:migrate` — those validations only matter when the backend
// serves agent traffic.
const config = loadConfig(process.env, undefined, { skipRuntimeChecks: true });
const migrationConfig = process.env.MIGRATION_DATABASE_URL
  ? { ...config, DATABASE_URL: process.env.MIGRATION_DATABASE_URL }
  : config;
const db = createDatabase(migrationConfig);

// Extract the app_user password from DATABASE_URL so we can set it on the
// role after migrations run. The role is created without a password in SQL
// (no hardcoded secret in the repo); the password comes from the operator's
// DATABASE_URL at runtime.
function extractPassword(databaseUrl: string): string | null {
  try {
    return new URL(databaseUrl).password || null;
  } catch {
    return null;
  }
}

async function run() {
  await applyMigrations(db, migrationsDir);

  // Ensure app_user exists and has the correct password from DATABASE_URL.
  // The role may not exist if migrations were previously applied without it
  // (e.g. the old 19-migration sequence). This is idempotent and safe to re-run.
  // ALTER ROLE does not accept parameterized queries, so we escape the password
  // by replacing every single-quote with two single-quotes (standard SQL escaping).
  const appUserPassword = process.env.APP_USER_PASSWORD || extractPassword(config.DATABASE_URL);
  if (appUserPassword) {
    const escaped = appUserPassword.replace(/'/g, "''");
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
          CREATE ROLE app_user LOGIN PASSWORD '${escaped}';
        ELSE
          ALTER ROLE app_user WITH LOGIN PASSWORD '${escaped}';
        END IF;
      END
      $$
    `);
    // Re-apply grants every time — idempotent and required if the role was
    // just created outside of the normal migration flow.
    await db.query(`GRANT USAGE ON SCHEMA public TO app_user`);
    await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user`);
    await db.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user`);
    console.log("Ensured app_user role exists with correct password and grants.");
  } else {
    console.warn(
      "Warning: no password found in DATABASE_URL — app_user will have no password set."
    );
  }
}

try {
  await run();
} finally {
  await db.end();
}
