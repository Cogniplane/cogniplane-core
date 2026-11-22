import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";

import type { SecurityChange } from "./auth/security-change.js";
import type { IntegrationRegistry } from "./integrations/integration-registry.js";

// A member removal lasts. The tenant table decides membership after the first
// sign-in, as it decides roles: WorkOS can admit a user once, and a removal by
// an owner or admin wins over the WorkOS organization from then on. See
// docs/architecture/auth.md#roles.
//
// Two callers remove a member: the removal route
// (DELETE /tenant/members/:userId) and the WorkOS membership revalidation
// (services/auth/workos-membership-revalidation.ts). Each one owns its
// authorization, its locks, its audit event and its cleanup after the commit.
// Both call removeTenantMember for the writes of the removal, in their
// transaction, after the tenant's membership lock (services/member-authority.ts).
// WorkOS sign-in takes the same lock before it calls assertMemberNotRemoved,
// so a sign-in either commits before the removal starts, and the removal then
// deletes its membership, or it waits and finds the removal.

/** WorkOS sign-in found a removal of this user by the tenant. */
export class MemberRemovedError extends Error {
  constructor(readonly tenantId: string) {
    super("The tenant removed this member.");
    this.name = "MemberRemovedError";
  }
}

/**
 * The writes of a member removal, in the caller's security change
 * (`withSecurityChange`). The caller holds the tenant's membership lock, the
 * locks of the member's chats (`lockChatsBeforeMembership`) and the lock of
 * the membership row, in that order, and has made its authorization checks.
 *
 * - Disables the member's scheduled jobs, first: the update locks the job
 *   rows, so a claim of a due job (`UserSettingsStore.claimJob`) waits and
 *   then finds the job disabled, and writes no run for it. The claim also
 *   requires the membership, but the pause lasts: `next_run_at = NULL` keeps
 *   the job out of the due-job query, and the pause reason makes the owner
 *   review each job before it runs again, if a future re-admission brings
 *   the member back.
 * - Runs `afterJobsPaused`, when given: what the caller ends with the
 *   membership, for example the local account.
 * - Ends the membership (endTenantMembership).
 * - After the commit, the member's active work stops, and the sandboxes of
 *   the member's chats are killed (services/auth/security-change.ts). A
 *   WorkOS member has no security version; its work stops all the same.
 *
 * Returns the number of project roles deleted, for the caller's audit event.
 */
export async function removeTenantMember(
  change: SecurityChange,
  input: { userId: string; removedBy: string; afterJobsPaused?: () => Promise<void> }
): Promise<{ projectRolesRemoved: number }> {
  const { client, tenantId } = change;
  await client.query(
    `UPDATE scheduled_jobs
     SET enabled = FALSE, next_run_at = NULL, paused_reason = 'security_change', updated_at = NOW()
     WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, input.userId]
  );
  await input.afterJobsPaused?.();
  const removed = await endTenantMembership(client, { tenantId, userId: input.userId, removedBy: input.removedBy });
  change.endActiveWork(input.userId);
  return removed;
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

/**
 * Revokes the stored connections of a removed member, for each integration
 * that has a connection probe. Call it after the removal commits: each
 * connection service opens its own `withTenantScope` and writes an audit
 * event, so it cannot join the removal transaction. A crash in the gap leaves
 * connection rows for a user who is no longer a member. They are unreachable:
 * the membership is gone, and WorkOS sign-in refuses the removed user.
 *
 * The integration registry drives the list, so the integrations of a private
 * overlay are covered too. One failing integration does not stop the others;
 * the failure is logged.
 */
export async function revokeMemberConnections(
  integrations: Pick<IntegrationRegistry, "list">,
  input: { tenantId: string; userId: string },
  log: Pick<FastifyBaseLogger, "error">
): Promise<void> {
  for (const descriptor of integrations.list()) {
    const revoke = descriptor.connectionProbe?.deleteConnection;
    if (!revoke) continue;
    try {
      await revoke.call(descriptor.connectionProbe, input.tenantId, input.userId);
    } catch (error) {
      log.error(
        { err: error, integrationId: descriptor.id, tenantId: input.tenantId, userId: input.userId },
        "member removal: failed to revoke integration connection"
      );
    }
  }
}
