import type { PoolClient } from "pg";

import { escapeAppUserPassword } from "./migrate-lib.js";

export const DEFAULT_MAINTENANCE_ROLE = "maintenance_user";

// Only queries executed through the cross-tenant pool belong here. Tenant
// workers use app_user again after claiming a tenant's work.
export const MAINTENANCE_GRANTS = {
  "SELECT, INSERT, UPDATE": ["tenants", "users", "tenant_memberships"],
  "SELECT": ["tenant_org_settings", "artifacts", "pii_scan_runs", "projects", "project_memberships"],
  "SELECT, UPDATE": [
    "scheduled_jobs", "scheduled_job_runs", "pii_scan_jobs", "approvals",
    "artifact_download_tokens", "message_tool_results"
  ],
  "SELECT, UPDATE, DELETE": ["sessions", "session_executions", "messages", "project_files"],
  "SELECT, DELETE": ["runtime_sessions", "project_file_versions"],
  "SELECT, INSERT, UPDATE, DELETE": ["project_file_storage_gc", "session_storage_gc", "session_runtime_gc"],
  "INSERT": ["audit_events"]
} as const;

export async function ensureMaintenanceRole(
  client: PoolClient,
  password: string,
  role = DEFAULT_MAINTENANCE_ROLE
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error("Invalid maintenance role name.");
  const escaped = escapeAppUserPassword(password);
  // Refuse to repurpose an existing owner or group member. Changing such a
  // role could affect other databases on the same server.
  const existing = await client.query<{ unsafe: boolean }>(`
    SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
      OR EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
        AND refobjid = r.oid AND deptype = 'o') AS unsafe
    FROM pg_roles r WHERE rolname = $1
  `, [role]);
  if (existing.rows[0]?.unsafe) throw new Error("Refusing to repurpose an unsafe maintenance role.");

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL standard_conforming_strings = on");
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role} LOGIN;
      END IF;
      ALTER ROLE ${role} LOGIN PASSWORD '${escaped}' BYPASSRLS
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
    END $$`);
    // Reapply the explicit list on each migration run. No default grants to
    // future tables, and no access to checkpoint or migration metadata.
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public, deep_agents FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, deep_agents FROM ${role}`);
    await client.query(`REVOKE ALL ON SCHEMA public, deep_agents FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    for (const [privileges, tables] of Object.entries(MAINTENANCE_GRANTS)) {
      await client.query(`GRANT ${privileges} ON ${tables.map(table => `public.${table}`).join(", ")} TO ${role}`);
    }
    await client.query(`GRANT USAGE ON SEQUENCE public.audit_events_id_seq TO ${role}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
