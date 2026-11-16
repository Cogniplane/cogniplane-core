import type { WorkOS } from "@workos-inc/node";

import type { Pool } from "../../lib/db.js";
import { AuditEventStore } from "../audit-event-store.js";
import { lockTenantMembership } from "../member-authority.js";
import { endTenantMembership } from "../tenant-member-removal.js";
import { type AfterSecurityChange, withSecurityChange } from "./security-change.js";

/** Rechecks WorkOS before refresh, including a cached rotation result. */
export class WorkOsMembershipRevalidation {
  constructor(private readonly deps: {
    lookupDb: Pool;
    db: Pool;
    workos: WorkOS;
    afterSecurityChange: AfterSecurityChange;
    /**
     * Runs after a removal commits, as after a removal in People: it revokes
     * the member's stored integration connections (revokeMemberConnections).
     */
    afterRemoval?: (input: { tenantId: string; userId: string }) => Promise<void>;
  }) {}

  async revalidate(tenantId: string, userId: string): Promise<boolean> {
    // Refresh has no tenant context yet. The maintenance-pool read keeps
    // tenant and user predicates; all removal writes below use app_user.
    const identity = await this.deps.lookupDb.query<{ workos_user_id: string; workos_org_id: string }>(
      `SELECT u.workos_user_id, t.workos_org_id
       FROM tenant_memberships tm
       JOIN users u ON u.user_id = tm.user_id
       JOIN tenants t ON t.tenant_id = tm.tenant_id
       WHERE tm.tenant_id = $1 AND tm.user_id = $2`,
      [tenantId, userId]
    );
    const row = identity.rows[0];
    if (!row) return false;
    if (!row.workos_user_id || !row.workos_org_id) throw new Error("WorkOS identity identifiers are missing.");

    const memberships = await this.deps.workos.userManagement.listOrganizationMemberships({
      userId: row.workos_user_id,
      organizationId: row.workos_org_id,
      statuses: ["active"]
    });
    if (memberships.data.some((membership) =>
      membership.userId === row.workos_user_id &&
      membership.organizationId === row.workos_org_id &&
      membership.status === "active"
    )) return true;

    // A confirmed provider removal uses the same lasting removal as People.
    // A WorkOS outage throws above and never removes a local membership.
    let removed = false;
    await withSecurityChange(this.deps.db, tenantId, this.deps.afterSecurityChange, async (client, change) => {
      removed = false;
      await lockTenantMembership(client, tenantId);
      await change.lockChatsBeforeMembership(userId);
      const target = await client.query<{ role: string; user_auth_source: string }>(
        `SELECT role, user_auth_source FROM tenant_memberships
         WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [tenantId, userId]
      );
      if (!target.rows[0]) return;
      if (target.rows[0].user_auth_source !== "workos") throw new Error("The membership is not a WorkOS identity.");
      await client.query(
        `UPDATE scheduled_jobs
         SET enabled = FALSE, next_run_at = NULL, paused_reason = 'security_change', updated_at = NOW()
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      const { projectRolesRemoved } = await endTenantMembership(client, { tenantId, userId, removedBy: userId });
      change.endActiveWork(userId);
      await AuditEventStore.createInTransaction(client, {
        tenantId,
        userId,
        sessionId: null,
        type: "tenant.member.removed",
        payload: { targetUserId: userId, previousRole: target.rows[0].role, projectRolesRemoved, reason: "workos_membership_inactive" }
      });
      removed = true;
    });
    if (removed) await this.deps.afterRemoval?.({ tenantId, userId });
    return false;
  }
}
