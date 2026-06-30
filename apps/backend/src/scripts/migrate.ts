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

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // C0 control chars (0x00-0x1F) and DEL (0x7F) cannot be safely
    // interpolated into the migrations DO block.
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function escapeAppUserPassword(password: string): string {
  if (password.includes("$$") || hasControlCharacter(password)) {
    throw new Error(
      "APP_USER_PASSWORD contains characters that cannot be safely interpolated " +
        "into the migrations DO block ($$ or control chars). Use a different password."
    );
  }
  return password.replace(/'/g, "''");
}

async function run() {
  await applyMigrations(db, migrationsDir);

  // Ensure app_user exists with the correct password from DATABASE_URL. The
  // role may be absent if migrations were previously applied without it (the
  // old 19-migration sequence); this block is idempotent and safe to re-run.
  const appUserPassword = process.env.APP_USER_PASSWORD || extractPassword(config.DATABASE_URL);
  if (appUserPassword) {
    const escaped = escapeAppUserPassword(appUserPassword);
    // CREATE/ALTER ROLE reject parameterized passwords; force ON so the
    // single-quote-doubling in escapeAppUserPassword is interpreted correctly.
    // Pin one connection: pool.query() checks out a connection per call, so a
    // separate SET could land on a different connection than the DO block.
    const client = await db.connect();
    try {
      await client.query("SET standard_conforming_strings = on");
      await client.query(`
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
      await client.query(`GRANT USAGE ON SCHEMA public TO app_user`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user`);
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user`);
    } finally {
      client.release();
    }
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
