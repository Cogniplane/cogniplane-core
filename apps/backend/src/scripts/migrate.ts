import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.js";
import { createDatabase } from "../lib/db.js";

import { applyMigrations, ensureAppUserRole } from "./migrate-lib.js";
import {
  DEEP_AGENTS_CHECKPOINT_SCHEMA,
  setupDeepAgentsCheckpointer
} from "../services/deep-agents/deep-agents-checkpointer.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(dirname, "../../db/migrations");

// Migrations require superuser access to CREATE ROLE, ALTER TABLE, etc.
// If MIGRATION_DATABASE_URL is set, use it; otherwise fall back to DATABASE_URL.
//
// skipRuntimeChecks: migrations only need a DB connection. They must not fail
// because E2B / PII / gateway env vars aren't present in the CI or deploy step
// that runs `pnpm db:migrate` — those validations only matter when the backend
// serves agent traffic.
// DATABASE_URL defaults to the restricted `app_user` role, which cannot run
// DDL or CREATE ROLE — so with no MIGRATION_DATABASE_URL, fall back to the
// local superuser DSN rather than failing halfway through the first migration.
const DEFAULT_LOCAL_SUPERUSER_URL = "postgres://postgres:postgres@localhost:5432/cogniplane";
const config = loadConfig(process.env, undefined, { skipRuntimeChecks: true });
const migrationConfig = {
  ...config,
  DATABASE_URL:
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_LOCAL_SUPERUSER_URL
};
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

  // Deep Agents checkpointer DDL (schema + tables + the library's internal
  // migrations). Runs here — superuser, alongside the SQL migrations — so the
  // backend never executes DDL at serve time. Idempotent by construction.
  await setupDeepAgentsCheckpointer(migrationConfig.DATABASE_URL);
  console.log(`Ensured Deep Agents checkpointer schema "${DEEP_AGENTS_CHECKPOINT_SCHEMA}" is up to date.`);

  // Role + grants. Shared with the integration harness via migrate-lib so the
  // two cannot drift — see ensureAppUserRole's header.
  const appUserPassword = process.env.APP_USER_PASSWORD || extractPassword(config.DATABASE_URL);
  if (appUserPassword) {
    const client = await db.connect();
    try {
      await ensureAppUserRole(client, appUserPassword);
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
