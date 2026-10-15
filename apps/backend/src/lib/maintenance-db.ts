import type { Pool, PoolClient } from "pg";

// Check effective authority, including PUBLIC grants and SET ROLE membership.
// A different DSN alone does not establish a separate security boundary.
type Database = Pick<Pool | PoolClient, "query">;

async function hasRuntimeAuthority(db: Database, bypassRls: boolean): Promise<boolean> {
  const { rows } = await db.query<{ allowed: boolean }>(`
    SELECT r.rolbypassrls = $1 AND session_user = current_user
      AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
      AND NOT EXISTS (
        SELECT 1 FROM pg_shdepend d
        WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid
          AND d.deptype = 'o'
      )
      AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_namespace n
        WHERE n.nspname !~ '^pg_temp_' AND n.nspname !~ '^pg_toast_temp_'
          AND has_schema_privilege(current_user, n.oid, 'CREATE')
      ) AS allowed
    FROM pg_roles r WHERE r.rolname = current_user
  `, [bypassRls]);
  return rows[0]?.allowed === true;
}

export async function assertApplicationRole(db: Database): Promise<void> {
  if (!await hasRuntimeAuthority(db, false)) {
    throw new Error(
      "DATABASE_URL must use an RLS-constrained application role without administrative " +
      "privileges, role memberships, object ownership, or schema CREATE privileges."
    );
  }
}

export async function assertMaintenanceRole(db: Database): Promise<void> {
  if (!await hasRuntimeAuthority(db, true)) {
    throw new Error(
      "MAINTENANCE_DATABASE_URL must use a dedicated BYPASSRLS role without superuser, " +
      "CREATEDB, CREATEROLE, REPLICATION, role memberships, object ownership, or schema CREATE privileges."
    );
  }
}
