import type { PoolClient } from "pg";

export type ProjectRole = "owner" | "editor" | "viewer";
export type ProjectActor = { tenantId: string; projectId: string; userId: string };

export class ProjectAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) {
    super(message);
  }
}

// Arguments are SQL expressions supplied by stores, never request values.
export function projectRoleSql(project: string, user: string): string {
  return `(SELECT CASE
    WHEN pm.role = 'owner' THEN 'owner'
    WHEN pm.role = 'editor' OR (${project}.visibility = 'organization' AND ${project}.organization_role = 'editor') THEN 'editor'
    WHEN pm.role = 'viewer' OR ${project}.visibility = 'organization' THEN 'viewer'
    ELSE NULL END
    FROM tenant_memberships tm LEFT JOIN project_memberships pm
      ON pm.tenant_id = tm.tenant_id AND pm.user_id = tm.user_id AND pm.project_id = ${project}.project_id
    WHERE tm.tenant_id = ${project}.tenant_id AND tm.user_id = ${user})`;
}

export async function requireProjectAccess(
  db: PoolClient, actor: ProjectActor,
  minimum: ProjectRole = "viewer", options: { lock?: boolean; active?: boolean } = {},
) {
  // Lock before reading membership. A separate statement gets a fresh snapshot
  // after waiting for a concurrent membership change to commit.
  if (options.lock) await db.query(
    `SELECT project_id FROM projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE`,
    [actor.tenantId, actor.projectId],
  );
  const result = await db.query(
    `SELECT p.archived_at, p.visibility, p.organization_role, ${projectRoleSql("p", "$3")} AS role
     FROM projects p WHERE p.tenant_id=$1 AND p.project_id=$2`,
    [actor.tenantId, actor.projectId, actor.userId],
  );
  const row = result.rows[0];
  if (!row?.role) throw new ProjectAccessError("project_not_found", "This project is unavailable.", 404);
  const role = row.role as ProjectRole;
  if ((minimum === "owner" && role !== "owner") || (minimum === "editor" && role === "viewer"))
    throw new ProjectAccessError("project_role_required", "Your project role does not allow this action.");
  if (options.active && row.archived_at)
    throw new ProjectAccessError("project_archived", "Restore the project before changing it.", 409);
  return { role, archivedAt: row.archived_at, visibility: row.visibility as "private" | "organization",
    organizationRole: row.organization_role as "viewer" | "editor" };
}
