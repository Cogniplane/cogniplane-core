import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.js";
import { createDatabase } from "../lib/db.js";

import { ensureMaintenanceRole, DEFAULT_MAINTENANCE_ROLE } from "./maintenance-role.js";
import { applyMigrations, ensureAppUserRole, resolveAppUserPassword } from "./migrate-lib.js";
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

function extractPassword(databaseUrl: string): string | null {
  try {
    return decodeURIComponent(new URL(databaseUrl).password) || null;
  } catch {
    return null;
  }
}

async function run() {
  if (!config.MAINTENANCE_DATABASE_URL) {
    throw new Error("MAINTENANCE_DATABASE_URL is required to provision the runtime maintenance role.");
  }
  const maintenanceUrl = new URL(config.MAINTENANCE_DATABASE_URL);
  const maintenancePassword = extractPassword(config.MAINTENANCE_DATABASE_URL);
  if (decodeURIComponent(maintenanceUrl.username) !== DEFAULT_MAINTENANCE_ROLE || !maintenancePassword) {
    throw new Error("MAINTENANCE_DATABASE_URL must name maintenance_user and include its password.");
  }
  // Before any migration runs, so that a missing password changes nothing.
  // loadConfig has already read apps/backend/.env into process.env.
  const appUserPassword = resolveAppUserPassword(process.env);
  await applyMigrations(db, migrationsDir, console.log, async (client) => {
    // Checkpointer DDL and role setup share the numbered migrations' lock.
    await setupDeepAgentsCheckpointer(migrationConfig.DATABASE_URL);
    console.log(`Ensured Deep Agents checkpointer schema "${DEEP_AGENTS_CHECKPOINT_SCHEMA}" is up to date.`);

    await ensureMaintenanceRole(client, maintenancePassword);
    console.log("Ensured maintenance_user with explicit runtime grants.");

    await ensureAppUserRole(client, appUserPassword);
    console.log("Ensured app_user role exists with correct password and grants.");
  });
}

try {
  await run();
} finally {
  await db.end();
}
