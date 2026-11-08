// Migration 070 and the sign-in rules that depend on it, against a real
// Postgres with the production roles. See docs/architecture/auth.md:
// tenants.login_type is fixed at creation, users.email_key
// makes emails that differ only in case one identity, and WorkOS provisioning
// never adopts a row it does not already own.

import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  provisionTenantIdentity,
  WorkOsEmailConflictError,
  WrongLoginTypeError
} from "../services/auth/workos-tenant-provisioning.js";
import { TenantMemberStore } from "../services/tenant-member-store.js";
import { adminDatabaseUrl, maintenancePool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";
import { withStagedDatabase } from "./support/staged-migrations.js";

function provisionInput(overrides: Partial<Parameters<typeof provisionTenantIdentity>[1]> = {}) {
  const id = randomUUID();
  return {
    organizationId: `org_${id}`,
    organizationName: "Login type test",
    workosUserId: `user_${id}`,
    email: `${id}@example.test`,
    displayName: "Test member",
    workosRoleSlug: "member",
    ...overrides
  };
}

describe.skipIf(!adminDatabaseUrl())("tenant login type (migration 070)", () => {
  test("login_type cannot change after creation, also for the maintenance and migration roles", async () => {
    const tenantId = await seedTenant();
    expect((await superuserPool().query("SELECT login_type FROM tenants WHERE tenant_id = $1", [tenantId])).rows[0])
      .toEqual({ login_type: "workos" });

    for (const pool of [maintenancePool(), superuserPool()]) {
      await expect(pool.query("UPDATE tenants SET login_type = 'local' WHERE tenant_id = $1", [tenantId]))
        .rejects.toMatchObject({ code: "23514" });
    }
    // Other columns still change, and a no-op write of the same value passes.
    await superuserPool().query(
      "UPDATE tenants SET tenant_name = 'Renamed', login_type = 'workos' WHERE tenant_id = $1",
      [tenantId]
    );
    // A tenant can be created with the other type, and only known types exist.
    const localTenant = `tenant-local-${randomUUID()}`;
    await superuserPool().query(
      "INSERT INTO tenants (tenant_id, tenant_name, slug, login_type) VALUES ($1, $1, $1, 'local')",
      [localTenant]
    );
    await expect(superuserPool().query(
      "INSERT INTO tenants (tenant_id, tenant_name, slug, login_type) VALUES ($1, $1, $1, 'saml')",
      [`tenant-saml-${randomUUID()}`]
    )).rejects.toMatchObject({ code: "23514" });
  });

  test("emails that differ only in case or spaces are one identity", async () => {
    const id = randomUUID();
    await superuserPool().query("INSERT INTO users (user_id, email) VALUES ($1, $2)", [`a-${id}`, `Alice.${id}@Example.test`]);
    await expect(superuserPool().query(
      "INSERT INTO users (user_id, email) VALUES ($1, $2)",
      [`b-${id}`, ` alice.${id}@example.TEST `]
    )).rejects.toMatchObject({ code: "23505", constraint: "users_email_key_key" });

    const row = (await superuserPool().query("SELECT auth_source, email_key FROM users WHERE user_id = $1", [`a-${id}`])).rows[0];
    expect(row).toEqual({ auth_source: "workos", email_key: `alice.${id}@example.test` });
    await expect(superuserPool().query(
      "INSERT INTO users (user_id, email, auth_source) VALUES ($1, $2, 'saml')",
      [`c-${id}`, `c-${id}@example.test`]
    )).rejects.toMatchObject({ code: "23514" });
  });

  test("getAuthState reads role, login type, and login path through the maintenance role", async () => {
    const tenantId = await seedTenant();
    const userId = await seedUser();
    await seedMembership(tenantId, userId, "admin");
    const members = new TenantMemberStore(maintenancePool());

    expect(await members.getAuthState(tenantId, userId)).toEqual({
      role: "admin", loginType: "workos", authSource: "workos", localStatus: null, securityVersion: null
    });
    expect(await members.getAuthState(tenantId, await seedUser())).toBeNull();
  });

  test("WorkOS provisioning into a tenant of another login type writes nothing", async () => {
    const input = provisionInput();
    const tenantId = `tenant-local-${randomUUID()}`;
    await superuserPool().query(
      "INSERT INTO tenants (tenant_id, tenant_name, slug, workos_org_id, login_type) VALUES ($1, $1, $1, $2, 'local')",
      [tenantId, input.organizationId]
    );
    const before = (await superuserPool().query("SELECT updated_at FROM tenants WHERE tenant_id = $1", [tenantId])).rows[0];

    await expect(provisionTenantIdentity(maintenancePool(), input)).rejects.toBeInstanceOf(WrongLoginTypeError);

    // The tenant upsert rolled back, and no user or membership exists.
    expect((await superuserPool().query("SELECT updated_at FROM tenants WHERE tenant_id = $1", [tenantId])).rows[0]).toEqual(before);
    expect((await superuserPool().query("SELECT 1 FROM users WHERE workos_user_id = $1", [input.workosUserId])).rowCount).toBe(0);
    expect((await superuserPool().query("SELECT 1 FROM tenant_memberships WHERE tenant_id = $1", [tenantId])).rowCount).toBe(0);
  });

  // A row with no WorkOS id is never adopted, whatever the case of
  // the email, and a local row is never touched.
  test.each([
    ["a row with no WorkOS id", "workos"],
    ["a local user's row", "local"]
  ])("WorkOS provisioning refuses an email held by %s", async (_case, authSource) => {
    const id = randomUUID();
    const userId = `held-${id}`;
    await superuserPool().query(
      "INSERT INTO users (user_id, email, display_name, auth_source) VALUES ($1, $2, 'Original', $3)",
      [userId, `held.${id}@example.test`, authSource]
    );
    const input = provisionInput({ email: `HELD.${id}@Example.test` });

    await expect(provisionTenantIdentity(maintenancePool(), input)).rejects.toBeInstanceOf(WorkOsEmailConflictError);

    expect((await superuserPool().query("SELECT workos_user_id, display_name FROM users WHERE user_id = $1", [userId])).rows[0])
      .toEqual({ workos_user_id: null, display_name: "Original" });
    expect((await superuserPool().query("SELECT 1 FROM tenants WHERE workos_org_id = $1", [input.organizationId])).rowCount).toBe(0);
  });

  test("WorkOS provisioning finds its own row when the email case changes", async () => {
    const input = provisionInput({ email: `case.${randomUUID()}@example.test` });
    const first = await provisionTenantIdentity(maintenancePool(), input);
    const again = await provisionTenantIdentity(maintenancePool(), { ...input, email: input.email.toUpperCase() });
    expect(again).toMatchObject({ tenantId: first.tenantId, userId: first.userId });
  });

  test("the migration stops on emails that differ only in case, before changing the schema", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => Number.parseInt(file, 10) <= 69);
      await db.query("INSERT INTO users (user_id, email) VALUES ('u1', 'Dup@example.test'), ('u2', 'dup@example.test')");

      await expect(migrate((file) => Number.parseInt(file, 10) === 70)).rejects.toThrow(
        /more than one row for the email dup@example.test/
      );
      const column = await db.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email_key'"
      );
      expect(column.rowCount).toBe(0);
    });
  });
});
