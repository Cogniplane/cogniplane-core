import type { PoolClient } from "pg";
import { projectRoleSql, requireProjectAccess } from "./project-access.js";

export class SessionUploadAccessError extends Error {
  constructor(readonly code = "session_not_found", readonly status = 404) {
    super(code === "session_changed"
      ? "The session changed while uploading. Retry the upload."
      : "This session is unavailable for uploads.");
  }
}

// Arguments are store-owned SQL expressions. This predicate also runs in the
// INSERT so organization departure after the earlier check cannot admit a file.
export function sessionUploadAccessSql(session: string, user: string): string {
  return `(${session}.status = 'active' AND (
    (${session}.project_id IS NULL AND ${session}.user_id = ${user}) OR
    EXISTS (SELECT 1 FROM projects upload_project
      WHERE upload_project.tenant_id = ${session}.tenant_id
        AND upload_project.project_id = ${session}.project_id
        AND upload_project.archived_at IS NULL
        AND ${projectRoleSql("upload_project", user)} IN ('owner', 'editor'))
  ))`;
}

export async function requireSessionUploadAccess(
  db: PoolClient,
  actor: { tenantId: string; sessionId: string; userId: string },
  lock = false,
): Promise<string | null> {
  const values = [actor.tenantId, actor.sessionId];
  const initial = await db.query(
    "SELECT project_id FROM sessions WHERE tenant_id=$1 AND session_id=$2",
    values,
  );
  if (!initial.rows[0]) throw new SessionUploadAccessError();
  const projectId = initial.rows[0].project_id as string | null;
  if (projectId) {
    await requireProjectAccess(db, { ...actor, projectId }, "editor", { lock, active: true });
  }
  // Match project assignment's project-before-session lock order. If an
  // unassigned session joined a project meanwhile, retry against that audience.
  const current = await db.query(
    `SELECT project_id FROM sessions WHERE tenant_id=$1 AND session_id=$2 ${lock ? "FOR UPDATE" : ""}`,
    values,
  );
  if (!current.rows[0]) throw new SessionUploadAccessError();
  if (current.rows[0].project_id !== projectId)
    throw new SessionUploadAccessError("session_changed", 409);
  const allowed = await db.query(
    `SELECT session_id FROM sessions s WHERE tenant_id=$1 AND session_id=$2
      AND ${sessionUploadAccessSql("s", "$3")}`,
    [...values, actor.userId],
  );
  if (!allowed.rows[0]) throw new SessionUploadAccessError();
  return projectId;
}
