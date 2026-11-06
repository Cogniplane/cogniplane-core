import type { PoolClient } from "pg";

import type { LocalAccountStatus, TenantMembershipRole } from "./tenant-member-store.js";

// One place for the rules on who may change whose membership or account, used
// by the role and removal routes (routes/tenant.ts) and by every manager
// action on local accounts (LocalAccountService). See docs/ARCHITECTURE.md,
// "Authentication".
//
// The middleware reads the caller's role when the request starts. So every
// membership or account change by a manager runs in one transaction that:
//
//   1. takes the tenant's membership lock (lockTenantMembership) before any
//      other lock, so manager changes in one tenant run one at a time;
//   2. reads the caller's role with currentRole, and decides with it.
//
// A role change or removal takes the same lock, so a demotion either commits
// before the change reads the role (and wins) or waits until the change has
// committed. Without the lock, a change could read the role, wait on another
// lock while a demotion commits, and then finish with the old role. One lock,
// always first, also leaves no lock cycle between these paths.

export type ManagerRightsError = "cannot_manage_self" | "cannot_manage_owner" | "only_owner_can_manage_admin" | "not_a_manager";

/**
 * SQL of the tenant's membership lock; exported for tests that hold it.
 *
 * The two-integer form, (namespace, tenant), as model-spending-store.ts uses.
 * Postgres keeps the two-integer key space apart from the single-key space
 * that the email locks use (`hashtext('users:email_key:...')`), so a hash
 * collision between a tenant and an email cannot make them one lock and
 * deadlock two requests.
 */
export const TENANT_MEMBERSHIP_LOCK_SQL =
  `SELECT pg_advisory_xact_lock(hashtext('tenant_membership_changes'), hashtext($1))`;

/**
 * Serialises every manager change of memberships and local accounts in one
 * tenant. Call it first in the transaction; it is released at commit.
 */
export async function lockTenantMembership(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(TENANT_MEMBERSHIP_LOCK_SQL, [tenantId]);
}

/**
 * The caller of a manager change: the user id, and for a local session the
 * security version it carries. A factor or password change of the caller
 * increments that version; an action whose session is older must not finish
 * (its step-up was checked against the older state).
 */
export type ManagerActor = string | { userId: string; securityVersion?: number };

export function actorIdOf(actor: ManagerActor): string {
  return typeof actor === "string" ? actor : actor.userId;
}

/**
 * The member's role as committed now, read in the caller's transaction. With
 * a session version, a local caller whose account moved past it has no role:
 * the change is refused. FOR SHARE waits for an uncommitted change of the
 * caller's account, so the check sees it.
 */
export async function currentRole(client: PoolClient, tenantId: string, actor: ManagerActor): Promise<TenantMembershipRole | null> {
  const userId = actorIdOf(actor);
  const expectedVersion = typeof actor === "string" ? undefined : actor.securityVersion;
  if (expectedVersion !== undefined) {
    const identity = await client.query<{ security_version: number }>(
      `SELECT security_version FROM local_identities WHERE tenant_id = $1 AND user_id = $2 FOR SHARE`,
      [tenantId, userId]
    );
    if (identity.rows[0]?.security_version !== expectedVersion) return null;
  }
  const result = await client.query<{ actor_role: string }>(
    `SELECT role AS actor_role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId]
  );
  const role = result.rows[0]?.actor_role;
  return role === "owner" || role === "admin" || role === "member" ? role : null;
}

export function isManager(role: TenantMembershipRole | null | undefined): role is "owner" | "admin" {
  return role === "owner" || role === "admin";
}

/**
 * Manager actions on another member's account: reset, disable, enable, sign
 * out. Nobody acts on themselves or on an owner; only an owner acts on an admin.
 */
export function managerMayAct(
  actor: { userId: string; role: TenantMembershipRole | null | undefined },
  target: { userId: string; role: TenantMembershipRole }
): ManagerRightsError | null {
  if (actor.userId === target.userId) return "cannot_manage_self";
  if (!isManager(actor.role)) return "not_a_manager";
  if (target.role === "owner") return "cannot_manage_owner";
  if (target.role === "admin" && actor.role !== "owner") return "only_owner_can_manage_admin";
  return null;
}

/**
 * Giving a role, at creation or by a role change: only an owner gives admin or
 * owner. An admin who could mint admins could entrench accomplices the owner
 * cannot remove in one action.
 */
export function mayAssignRole(
  actorRole: TenantMembershipRole | null | undefined,
  role: TenantMembershipRole
): "not_a_manager" | "only_owner_can_assign_admin" | "only_owner_can_assign_owner" | null {
  if (!isManager(actorRole)) return "not_a_manager";
  if (role === "owner" && actorRole !== "owner") return "only_owner_can_assign_owner";
  if (role === "admin" && actorRole !== "owner") return "only_owner_can_assign_admin";
  return null;
}

/**
 * A manager gives the owner role only to an active local account, at creation
 * or by a role change. Nobody can reset, enable, demote, or remove an owner,
 * so an owner account that is not active stays locked, and only the operator
 * command auth:recover-owner can open it. A new account is pending_setup, so
 * a manager cannot create an owner: the person becomes an owner after setup.
 * The operator commands (auth:bootstrap, auth:recover-owner) do not use this
 * rule. A member with no local account (null) has no setup to finish.
 */
export function ownerRoleRefusal(
  role: TenantMembershipRole,
  localStatus: LocalAccountStatus | null
): "account_not_active" | null {
  return role === "owner" && localStatus !== null && localStatus !== "active" ? "account_not_active" : null;
}
