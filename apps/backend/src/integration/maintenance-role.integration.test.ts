import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { assertApplicationRole, assertMaintenanceRole } from "../lib/maintenance-db.js";
import { provisionTenantIdentity } from "../services/auth/workos-tenant-provisioning.js";
import { TenantMemberStore } from "../services/tenant-member-store.js";
import { ensureMaintenanceRole } from "../scripts/maintenance-role.js";
import {
  adminDatabaseUrl, appPool, maintenancePool, superuserPool, runRoleName, APP_USER_PASSWORD
} from "./support/database.js";

describe.skipIf(!adminDatabaseUrl())("runtime maintenance authority", () => {
  test("provisions and authenticates identities across tenants without migration authority", async () => {
    await assertMaintenanceRole(maintenancePool());
    await assertApplicationRole(appPool());
    const members = new TenantMemberStore(maintenancePool());
    const identities = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      const input = {
        organizationId: `org_${id}`, organizationName: "Permission test",
        workosUserId: `user_${id}`, email: `${id}@example.test`,
        displayName: "Test member", workosRoleSlug: "member"
      };
      const identity = await provisionTenantIdentity(maintenancePool(), input);
      expect(await provisionTenantIdentity(maintenancePool(), input)).toMatchObject({ tenantId: identity.tenantId, userId: identity.userId, role: identity.role });
      expect(await members.getRole(identity.tenantId, identity.userId)).toBe("owner");
      identities.push(identity);
    }
    expect(await members.getRole(identities[0]!.tenantId, identities[1]!.userId)).toBeNull();
  });

  test.each([
    "CREATE ROLE maintenance_escape",
    "CREATE SCHEMA maintenance_escape",
    "CREATE TABLE public.maintenance_escape (id integer)",
    "ALTER TABLE public.sessions ADD COLUMN maintenance_escape integer",
    "ALTER TABLE public.sessions DISABLE ROW LEVEL SECURITY",
    "DROP TABLE public.schema_migrations",
    "TRUNCATE public.sessions CASCADE",
    "SET ROLE postgres",
    "SELECT * FROM public.schema_migrations",
    "UPDATE public.tenant_org_settings SET updated_at=NOW()",
    "DELETE FROM public.tenants",
    "SELECT * FROM deep_agents.checkpoints"
  ])("denies %s", async sql => {
    const client = await maintenancePool().connect();
    try {
      await client.query("BEGIN");
      await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("cannot grant its table access to PUBLIC", async () => {
    const client = await maintenancePool().connect();
    try {
      await client.query("BEGIN");
      const before = await client.query("SELECT relacl::text FROM pg_class WHERE oid='public.sessions'::regclass");
      await client.query("GRANT SELECT ON public.sessions TO PUBLIC");
      const after = await client.query("SELECT relacl::text FROM pg_class WHERE oid='public.sessions'::regclass");
      expect(after.rows).toEqual(before.rows);
      expect((await client.query("SELECT has_table_privilege(current_user, 'public.sessions', 'SELECT WITH GRANT OPTION') AS can_grant")).rows[0].can_grant).toBe(false);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("rejects app and migration roles at the runtime boundary", async () => {
    await expect(assertApplicationRole(superuserPool())).rejects.toThrow("RLS-constrained");
    await expect(assertApplicationRole(maintenancePool())).rejects.toThrow("RLS-constrained");
    await expect(assertMaintenanceRole(appPool())).rejects.toThrow("dedicated BYPASSRLS");
    await expect(assertMaintenanceRole(superuserPool())).rejects.toThrow("dedicated BYPASSRLS");
  });

  test("rejects schema owners and membership even with NOINHERIT", async () => {
    const role = runRoleName().replace("_role_", "_maint_");
    await superuserPool().query(`GRANT ${runRoleName()} TO ${role}`);
    try {
      await expect(assertMaintenanceRole(maintenancePool())).rejects.toThrow("role memberships");
    } finally {
      await superuserPool().query(`REVOKE ${runRoleName()} FROM ${role}`);
    }
    await superuserPool().query(`CREATE SCHEMA maintenance_owned AUTHORIZATION ${role}`);
    try {
      await expect(assertMaintenanceRole(maintenancePool())).rejects.toThrow("object ownership");
    } finally {
      await superuserPool().query("DROP SCHEMA maintenance_owned");
    }
  });

  test("PUBLIC creation grants are rejected and new tables get no maintenance grants", async () => {
    await superuserPool().query("CREATE SCHEMA maintenance_public");
    try {
      await superuserPool().query("GRANT CREATE ON SCHEMA maintenance_public TO PUBLIC");
      await expect(assertMaintenanceRole(maintenancePool())).rejects.toThrow("schema CREATE");
    } finally {
      await superuserPool().query("DROP SCHEMA maintenance_public");
    }
    await superuserPool().query("CREATE TABLE public.maintenance_future (id integer)");
    const client = await superuserPool().connect();
    try {
      await ensureMaintenanceRole(client, APP_USER_PASSWORD, runRoleName().replace("_role_", "_maint_"));
      await expect(maintenancePool().query("SELECT * FROM public.maintenance_future")).rejects.toMatchObject({ code: "42501" });
      await assertMaintenanceRole(maintenancePool());
    } finally {
      client.release();
      await superuserPool().query("DROP TABLE public.maintenance_future");
    }
  });
});
