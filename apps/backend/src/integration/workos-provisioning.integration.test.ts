// WorkOS provisioning against a real Postgres. A login never writes the role
// of an existing membership. So provisioning keeps an in-app role change that
// commits while the login runs. A member removal lasts: a login that overlaps
// with a removal never leaves a membership behind it.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, test } from "vitest";

import { withTenantScope } from "../lib/db.js";
import { provisionTenantIdentity } from "../services/auth/workos-tenant-provisioning.js";
import { lockTenantMembership, TENANT_MEMBERSHIP_LOCK_SQL } from "../services/member-authority.js";
import { endTenantMembership, MemberRemovedError } from "../services/tenant-member-removal.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";

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
  return { organizationId, tenantId: second.tenantId, userId: second.userId, ownerId: owner.userId, workosUserId, email };
}

/**
 * Runs `change` in a transaction and holds it open until the login is
 * blocked by it (Postgres shows the wait), then commits. So the login surely
 * runs its membership statement against a change that commits under it.
 */
async function loginDuring<T>(change: string, params: unknown[], start: () => Promise<T>): Promise<T> {
  const holder = await superuserPool().connect();
  let settled: Promise<unknown> = Promise.resolve();
  try {
    await holder.query("BEGIN");
    await holder.query(change, params);
    const pending = start();
    settled = Promise.allSettled([pending]);
    await waitUntilBlockedBy(holder, 1);
    await holder.query("COMMIT");
    return await pending;
  } finally {
    await releaseHolder(holder, settled);
  }
}

/**
 * Ends the holder's transaction, then returns the connection and waits for
 * the statements that waited for it. After a COMMIT, the ROLLBACK does
 * nothing. After a failed step, it releases the locks, so the waiting
 * statements end before the next test, and the pool gets no open transaction.
 * A connection whose ROLLBACK failed is destroyed.
 */
async function releaseHolder(holder: pg.PoolClient, settled: Promise<unknown>): Promise<void> {
  let rollbackError: Error | undefined;
  try {
    await holder.query("ROLLBACK");
  } catch (error) {
    rollbackError = error as Error;
    throw error;
  } finally {
    holder.release(rollbackError);
    await settled;
  }
}

/**
 * Waits until `count` other sessions wait for a lock that `holder` holds, on
 * a statement about memberships (the membership row or the tenant's
 * membership lock).
 */
async function waitUntilBlockedBy(holder: { query: pg.PoolClient["query"] }, count: number): Promise<void> {
  const holderPid = (await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const blocked = await superuserPool().query(
      `SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query ILIKE '%tenant_membership%'`,
      [holderPid]
    );
    if ((blocked.rowCount ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error("The statement never waited for the open transaction.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The removal route's database steps, after the lock it takes first (routes/tenant.ts). */
function removal(tenantId: string, userId: string, removedBy: string) {
  return withTenantScope(appPool(), tenantId, async (client) => {
    await lockTenantMembership(client, tenantId);
    await endTenantMembership(client, { tenantId, userId, removedBy });
  });
}

async function removalOf(tenantId: string, userId: string): Promise<boolean> {
  const result = await superuserPool().query(
    `SELECT 1 FROM tenant_member_removals WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  return result.rowCount === 1;
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

  test("a membership row deleted outside a removal during a login comes back with the WorkOS role", async () => {
    // A bare DELETE records no removal, so it is not one: the login waits for
    // the row and inserts a new membership, seeded from WorkOS.
    const t = await tenantWith("admin");
    const result = await loginDuring(
      `DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [t.tenantId, t.userId],
      () => login(t.organizationId, t.workosUserId, t.email, "member")
    );
    expect(result).toMatchObject({ role: "member", previousRole: undefined });
    expect(await roleOf(t.tenantId, t.userId)).toBe("member");
  });

  test("a login after a removal is refused, whatever WorkOS says, and writes nothing", async () => {
    const t = await tenantWith("admin");
    await removal(t.tenantId, t.userId, t.ownerId);

    await expect(login(t.organizationId, t.workosUserId, t.email, "admin")).rejects.toBeInstanceOf(MemberRemovedError);
    expect(await roleOf(t.tenantId, t.userId)).toBeNull();
    expect(await removalOf(t.tenantId, t.userId)).toBe(true);
  });

  // The removal holds the tenant's membership lock until it commits. The login
  // waits for that lock, then sees the removal. Without the lock, the login
  // would read no removal, wait for the deleted row, and insert the
  // membership again after the commit.
  test("a login that starts while a removal is open waits for it, then is refused", async () => {
    const t = await tenantWith("admin");
    const holder = await appPool().connect();
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [t.tenantId]);
      await lockTenantMembership(holder, t.tenantId);
      await endTenantMembership(holder, { tenantId: t.tenantId, userId: t.userId, removedBy: t.ownerId });
      // Settles in both cases: the outcome is checked after the commit.
      pending = login(t.organizationId, t.workosUserId, t.email, "admin").then(
        () => "admitted", (error: unknown) => error);
      await waitUntilBlockedBy(holder, 1);
      await holder.query("COMMIT");
    } finally {
      await releaseHolder(holder, pending);
    }
    expect(await pending).toBeInstanceOf(MemberRemovedError);
    expect(await roleOf(t.tenantId, t.userId)).toBeNull();
  });

  // A login and a removal that both wait for the lock run one at a time, in
  // either order. Either way the removal is the last word: no membership, and
  // the removal is recorded.
  test("a login and a removal that wait for the same lock end with the member removed", async () => {
    const t = await tenantWith("member");
    const holder = await superuserPool().connect();
    let outcomes: unknown[];
    const started: Promise<unknown>[] = [];
    try {
      await holder.query("BEGIN");
      await holder.query(TENANT_MEMBERSHIP_LOCK_SQL, [t.tenantId]);
      const signIn = login(t.organizationId, t.workosUserId, t.email, "admin").then(
        (identity) => identity.role, (error: unknown) => error);
      started.push(signIn);
      await waitUntilBlockedBy(holder, 1);
      const remove = removal(t.tenantId, t.userId, t.ownerId).then(() => "removed");
      started.push(remove);
      await waitUntilBlockedBy(holder, 2);
      await holder.query("COMMIT");
      outcomes = await Promise.all([signIn, remove]);
    } finally {
      await releaseHolder(holder, Promise.allSettled(started));
    }
    // The login queued first, so it ran first and kept the member's role.
    expect(outcomes).toEqual(["member", "removed"]);
    expect(await roleOf(t.tenantId, t.userId)).toBeNull();
    expect(await removalOf(t.tenantId, t.userId)).toBe(true);
    await expect(login(t.organizationId, t.workosUserId, t.email, "member")).rejects.toBeInstanceOf(MemberRemovedError);
  });

  test("a removal in one tenant does not refuse the same person in another tenant", async () => {
    const t = await tenantWith("member");
    const other = await tenantWith("member");
    // The same WorkOS person also belongs to the other organization.
    const there = await login(other.organizationId, t.workosUserId, t.email, "member");
    expect(there.userId).toBe(t.userId);
    await removal(t.tenantId, t.userId, t.ownerId);

    await expect(login(t.organizationId, t.workosUserId, t.email, "member")).rejects.toBeInstanceOf(MemberRemovedError);
    expect(await login(other.organizationId, t.workosUserId, t.email, "member")).toMatchObject({ tenantId: other.tenantId, role: "member" });
    expect(await removalOf(other.tenantId, t.userId)).toBe(false);
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
