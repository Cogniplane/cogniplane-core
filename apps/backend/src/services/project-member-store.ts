import { AuditEventStore } from "./audit-event-store.js";
import type { AuditEventType } from "./audit-event-types.js";
import { z } from "zod";
import { ProjectRoleSchema as roleSchema, ProjectSharingUpdateSchema as sharingSchema } from "@cogniplane/shared-types";
import { withTenantScope, type Pool } from "../lib/db.js";
import type { PoolClient } from "pg";
import { ProjectAccessError, requireProjectAccess, projectRoleSql, type ProjectActor } from "./project-access.js";

export class ProjectMemberStore {
  constructor(private readonly pool: Pool) {}

  private async lockActorMembership(db: PoolClient, actor: ProjectActor) {
    // Hold organization membership until the change and its audit commit.
    // Project locking then protects the actor's explicit project role.
    const member = await db.query("SELECT user_id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE",
      [actor.tenantId, actor.userId]);
    if (!member.rowCount) throw new ProjectAccessError("project_not_found", "This project is unavailable.", 404);
  }

  async listOwnerless(tenantId: string, userId: string) {
    return withTenantScope(this.pool, tenantId, async (db) => {
      const admin = await db.query(`SELECT user_id FROM tenant_memberships
        WHERE tenant_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE`, [tenantId, userId]);
      if (!admin.rowCount) throw new ProjectAccessError("organization_admin_required", "Organization administrator access is required.");
      const projects = await db.query(`SELECT p.project_id, p.name FROM projects p
        WHERE p.tenant_id=$1 AND NOT EXISTS (
          SELECT 1 FROM project_memberships pm JOIN tenant_memberships tm
            ON tm.tenant_id=pm.tenant_id AND tm.user_id=pm.user_id
          WHERE pm.tenant_id=p.tenant_id AND pm.project_id=p.project_id AND pm.role='owner'
        ) ORDER BY p.created_at, p.project_id`, [tenantId]);
      return projects.rows.map(row => ({ projectId: String(row.project_id), name: String(row.name) }));
    });
  }

  private async audit(db: PoolClient, actor: ProjectActor, event: AuditEventType, payload: Record<string, unknown>) {
    await AuditEventStore.createInTransaction(db, {
      tenantId: actor.tenantId, userId: actor.userId, sessionId: null,
      type: event, payload: { projectId: actor.projectId, ...payload },
    });
  }

  async list(actor: ProjectActor) {
    return withTenantScope(this.pool, actor.tenantId, async (db) => {
      const access = await requireProjectAccess(db, actor, "owner");
      const result = await db.query(
        `SELECT pm.user_id, pm.role, u.display_name, u.email FROM project_memberships pm
         JOIN tenant_memberships tm ON tm.tenant_id=pm.tenant_id AND tm.user_id=pm.user_id
         JOIN users u ON u.user_id=pm.user_id
         WHERE pm.tenant_id=$1 AND pm.project_id=$2 ORDER BY pm.created_at, pm.user_id`,
        [actor.tenantId, actor.projectId],
      );
      return { visibility: access.visibility, organizationRole: access.organizationRole,
        members: result.rows.map((row) => ({ userId: String(row.user_id), role: roleSchema.parse(row.role),
          displayName: row.display_name as string | null, email: row.email as string | null })) };
    });
  }

  async setSharing(actor: ProjectActor, input: z.input<typeof sharingSchema>) {
    const parsed = sharingSchema.safeParse(input);
    if (!parsed.success) throw new ProjectAccessError("invalid_project_sharing", "Choose a valid sharing setting.", 400);
    const value = parsed.data;
    return withTenantScope(this.pool, actor.tenantId, async (db) => {
      await this.lockActorMembership(db, actor);
      const access = await requireProjectAccess(db, actor, "owner", { lock: true, active: true });
      if (value.visibility === "organization" &&
          (access.visibility !== "organization" || access.organizationRole !== value.organizationRole) && !value.confirmAudience)
        throw new ProjectAccessError("project_audience_confirmation_required",
          "Confirm that existing sessions, files, and drafts will be shared with the organization.", 409);
      await db.query(
        `UPDATE projects SET visibility=$3, organization_role=$4, updated_at=NOW()
         WHERE tenant_id=$1 AND project_id=$2`,
        [actor.tenantId, actor.projectId, value.visibility, value.organizationRole],
      );
      await this.audit(db, actor, "project_sharing_changed", {
        previousVisibility: access.visibility, previousOrganizationRole: access.organizationRole,
        visibility: value.visibility, organizationRole: value.organizationRole,
      });
    });
  }

  async setMember(actor: ProjectActor, userId: string, role: z.infer<typeof roleSchema> | null,
    options: { confirmRetainedRole?: "viewer" | "editor" } = {}) {
    if (role !== null && !roleSchema.safeParse(role).success)
      throw new ProjectAccessError("invalid_project_role", "Choose a valid project role.", 400);
    return withTenantScope(this.pool, actor.tenantId, async (db) => {
      // Members can remove their explicit role without an owner. Changes use the same lock
      // as file mutations so revocation cannot race a protected database write.
      const selfRemoval = userId === actor.userId && role === null;
      await this.lockActorMembership(db, actor);
      const access = await requireProjectAccess(db, actor, selfRemoval ? "viewer" : "owner", { lock: true });
      const previous = await db.query(
        `SELECT role FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3`,
        [actor.tenantId, actor.projectId, userId],
      );
      const oldRole = previous.rows[0]?.role as string | undefined;
      if (selfRemoval && !oldRole)
        throw new ProjectAccessError("project_no_explicit_membership",
          "There is no explicit membership to remove. Organization sharing still grants access.", 409);
      const member = await db.query(
        `SELECT user_id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE`,
        [actor.tenantId, userId],
      );
      if (role !== null && !member.rows[0])
        throw new ProjectAccessError("organization_member_not_found", "Choose a current organization member.", 404);
      const retainsOrganizationAccess = Boolean(member.rows[0]) && access.visibility === "organization" &&
        (role === null || (role === "viewer" && access.organizationRole === "editor"));
      if (retainsOrganizationAccess && options.confirmRetainedRole !== access.organizationRole)
        throw new ProjectAccessError("project_organization_access_retained",
          `Organization sharing will still grant ${access.organizationRole} access after this explicit role is changed or removed. Confirm the retained access to continue.`, 409);
      const rank: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
      if (access.archivedAt && role !== null && rank[role]! > (rank[oldRole ?? ""] ?? 0))
        throw new ProjectAccessError("project_archived", "Restore the project before granting access.", 409);
      if (role === null) {
        await db.query(`DELETE FROM project_memberships WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3`,
          [actor.tenantId, actor.projectId, userId]);
      } else {
        await db.query(
          `INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id,project_id,user_id) DO UPDATE SET role=EXCLUDED.role, updated_at=NOW()`,
          [actor.tenantId, actor.projectId, userId, role],
        );
      }
      const current = await db.query(
        `SELECT ${projectRoleSql("p", "$3")} AS role FROM projects p WHERE p.tenant_id=$1 AND p.project_id=$2`,
        [actor.tenantId, actor.projectId, userId],
      );
      const effectiveRole = roleSchema.nullable().parse(current.rows[0]?.role ?? null);
      await this.audit(db, actor, "project_member_changed", {
        memberUserId: userId, previousRole: oldRole ?? null, role, effectiveRole,
      });
      return { role, effectiveRole };
    });
  }

  async recoverOwner(actor: ProjectActor, userId: string) {
    return withTenantScope(this.pool, actor.tenantId, async (db) => {
      const admin = await db.query(
        `SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE`,
        [actor.tenantId, actor.userId],
      );
      if (!admin.rows[0]) throw new ProjectAccessError("organization_admin_required", "Organization administrator access is required.");
      const project = await db.query(`SELECT project_id FROM projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE`,
        [actor.tenantId, actor.projectId]);
      if (!project.rows[0]) throw new ProjectAccessError("project_not_found", "This project is unavailable.", 404);
      const owners = await db.query(
        `SELECT pm.user_id FROM project_memberships pm JOIN tenant_memberships tm
         ON tm.tenant_id=pm.tenant_id AND tm.user_id=pm.user_id
         WHERE pm.tenant_id=$1 AND pm.project_id=$2 AND pm.role='owner'`,
        [actor.tenantId, actor.projectId],
      );
      if (owners.rows.length) throw new ProjectAccessError("project_has_owner", "This project already has an owner.", 409);
      const target = await db.query(`SELECT user_id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE`,
        [actor.tenantId, userId]);
      if (!target.rows[0]) throw new ProjectAccessError("organization_member_not_found", "Choose a current organization member.", 404);
      await db.query(
        `INSERT INTO project_memberships (tenant_id,project_id,user_id,role) VALUES ($1,$2,$3,'owner')
         ON CONFLICT (tenant_id,project_id,user_id) DO UPDATE SET role='owner', updated_at=NOW()`,
        [actor.tenantId, actor.projectId, userId],
      );
      await this.audit(db, actor, "project_owner_recovered", { memberUserId: userId });
    });
  }
}
