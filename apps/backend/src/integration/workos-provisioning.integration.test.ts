// WorkOS provisioning against a real Postgres: a login never writes the role
// of an existing membership, so an in-app role change that commits while the
// login runs is kept (Beads f93g). Before the fix, provisioning read the role
// and wrote it back, and the change was lost.

import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { provisionTenantIdentity } from "../services/auth/workos-tenant-provisioning.js";
import { adminDatabaseUrl, maintenancePool, superuserPool } from "./support/database.js";

function login(organizationId: string, workosUserId: string, email: string, workosRoleSlug: string | null = "member") {
  return provisionTenantIdentity(maintenancePool(), {
    organizationId, organizationName: "Race Org", workosUserId, email, displayName: "Test", workosRoleSlug
  });
}

async function roleOf(tenantId: string, userId: string): Promise<string | null> {
  const result = await superuserPool().query(`SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  return result.rows[0]?.role ?? null;
}

/** A WorkOS tenant with an owner, and a second user with `role`. */
async function tenantWith(role: "member" | "admin") {
  const organizationId = `org_${randomUUID()}`;
  const owner = await login(organizationId, `user_${randomUUID()}`, `${randomUUID()}@example.test`);
  const email = `${randomUUID()}@example.test`;
  const workosUserId = `user_${randomUUID()}`;
  const second = await login(organizationId, workosUserId, email, role);
  expect(owner.role).toBe("owner");
  expect(second.role).toBe(role);
  return { organizationId, tenantId: second.tenantId, userId: second.userId, workosUserId, email };
}

/**
 * Runs `change` in a transaction and holds it open until the login is
 * blocked by it (Postgres shows the wait), then commits. So the login surely
 * runs its membership statement against a change that commits under it.
 */
async function loginDuring<T>(change: string, params: unknown[], start: () => Promise<T>): Promise<T> {
  const holder = await superuserPool().connect();
  try {
    await holder.query("BEGIN");
    await holder.query(change, params);
    const holderPid = (await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
    const pending = start();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const blocked = await superuserPool().query(
        `SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query ILIKE '%tenant_memberships%'`,
        [holderPid]
      );
      if (blocked.rowCount) break;
      if (Date.now() > deadline) throw new Error("The login never waited for the open change.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await holder.query("COMMIT");
    return await pending;
  } finally {
    holder.release();
  }
}

describe.skipIf(!adminDatabaseUrl())("WorkOS provisioning and concurrent role changes", () => {
  test("a promotion that commits during a login is kept", async () => {
    const t = await tenantWith("member");
    const result = await loginDuring(
      `UPDATE tenant_memberships SET role = 'admin', updated_at = now() WHERE tenant_id = $1 AND user_id = $2`,
      [t.tenantId, t.userId],
      () => login(t.organizationId, t.workosUserId, t.email, "member")
    );
    expect(await roleOf(t.tenantId, t.userId)).toBe("admin");
    expect(result.role).toBe("admin");
  });

  test("a demotion that commits during a login is kept, whatever WorkOS says", async () => {
    const t = await tenantWith("admin");
    const result = await loginDuring(
      `UPDATE tenant_memberships SET role = 'member', updated_at = now() WHERE tenant_id = $1 AND user_id = $2`,
      [t.tenantId, t.userId],
      () => login(t.organizationId, t.workosUserId, t.email, "admin")
    );
    expect(await roleOf(t.tenantId, t.userId)).toBe("member");
    expect(result.role).toBe("member");
  });

  test("a member removed during a login comes back as a new member with the WorkOS role, as after the removal", async () => {
    const t = await tenantWith("admin");
    const result = await loginDuring(
      `DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [t.tenantId, t.userId],
      () => login(t.organizationId, t.workosUserId, t.email, "member")
    );
    // Not the old admin role: a new membership, seeded from WorkOS.
    expect(result).toMatchObject({ role: "member", previousRole: undefined });
    expect(await roleOf(t.tenantId, t.userId)).toBe("member");
  });

  test("a login keeps the existing role and reports it as unchanged", async () => {
    const t = await tenantWith("member");
    await superuserPool().query(`UPDATE tenant_memberships SET role = 'admin' WHERE tenant_id = $1 AND user_id = $2`, [t.tenantId, t.userId]);
    const again = await login(t.organizationId, t.workosUserId, t.email, "member");
    expect(again).toMatchObject({ role: "admin", previousRole: "admin" });
    expect(await roleOf(t.tenantId, t.userId)).toBe("admin");
  });

  test("a first login creates the membership from the WorkOS role", async () => {
    const t = await tenantWith("member");
    const newcomer = await login(t.organizationId, `user_${randomUUID()}`, `${randomUUID()}@example.test`, "admin");
    expect(newcomer).toMatchObject({ role: "admin", previousRole: undefined });
  });
});
