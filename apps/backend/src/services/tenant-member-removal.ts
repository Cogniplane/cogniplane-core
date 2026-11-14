import type { PoolClient } from "pg";

// A member removal lasts. The tenant table decides membership after the first
// sign-in, as it decides roles: WorkOS can admit a user once, and a removal by
// an owner or admin wins over the WorkOS organization from then on. See
// docs/architecture/auth.md#roles.
//
// The removal route (DELETE /tenant/members/:userId) calls
// endTenantMembership in its transaction, after the tenant's membership lock
// (services/member-authority.ts). WorkOS sign-in takes the same lock before it
// calls assertMemberNotRemoved, so a sign-in either commits before the removal
// starts, and the removal then deletes its membership, or it waits and finds
// the removal.

/** WorkOS sign-in found a removal of this user by the tenant. */
export class MemberRemovedError extends Error {
  constructor(readonly tenantId: string) {
    super("The tenant removed this member.");
    this.name = "MemberRemovedError";
  }
}

/**
 * Ends the user's membership of the tenant, in the caller's transaction (in
 * the tenant's scope):
 *
 * - deletes the user's explicit project roles: a project role must not come
 *   back with a later membership. A project that loses its last owner is
 *   listed in Admin > Project owners;
 * - deletes the membership;
 * - records the removal (tenant_member_removals). WorkOS sign-in then refuses
 *   the user, and admission refuses every session that started before now.
 *
 * Returns the number of project roles deleted, for the audit event.
 */
export async function endTenantMembership(
  client: Pick<PoolClient, "query">,
  input: { tenantId: string; userId: string; removedBy: string }
): Promise<{ projectRolesRemoved: number }> {
  const projectRoles = await client.query(
    `DELETE FROM project_memberships WHERE tenant_id = $1 AND user_id = $2`,
    [input.tenantId, input.userId]
  );
  await client.query(
    `DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
    [input.tenantId, input.userId]
  );
  // A second removal (after a future re-admission) moves the time forward:
  // the latest removal is the one that ends the sessions before it.
  await client.query(
    `INSERT INTO tenant_member_removals (tenant_id, user_id, removed_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET removed_at = NOW(), removed_by = EXCLUDED.removed_by`,
    [input.tenantId, input.userId, input.removedBy]
  );
  return { projectRolesRemoved: projectRoles.rowCount ?? 0 };
}

/**
 * Throws MemberRemovedError when the tenant removed the user. Call it while
 * the transaction holds the tenant's membership lock, before it writes the
 * membership.
 */
export async function assertMemberNotRemoved(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  userId: string
): Promise<void> {
  const removal = await client.query(
    `SELECT 1 FROM tenant_member_removals WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId]
  );
  if (removal.rowCount) throw new MemberRemovedError(tenantId);
}
