import { projectRoleSql } from "./project-access.js";

// SQL expressions come from stores, never from request values. Once assigned,
// a session follows project membership even when its creator loses access.
// Callers must not use access_project or access_session as outer aliases.
// Separate calls in sibling subqueries have independent alias scopes.
function projectSessionReadAccessSql(session: string, user: string): string {
  return `EXISTS (SELECT 1 FROM projects access_project
    WHERE access_project.tenant_id = ${session}.tenant_id
      AND access_project.project_id = ${session}.project_id
      AND ${projectRoleSql("access_project", user)} IS NOT NULL)`;
}

export function sessionReadAccessSql(session: string, user: string): string {
  return `(${session}.status <> 'deleted' AND (
    (${session}.project_id IS NULL AND ${session}.user_id = ${user}) OR
    ${projectSessionReadAccessSql(session, user)}
  ))`;
}

export function sessionTrashAccessSql(session: string, user: string): string {
  return `(${session}.status = 'deleted' AND (
    (${session}.project_id IS NULL AND ${session}.user_id = ${user}) OR
    EXISTS (SELECT 1 FROM projects trash_project
      WHERE trash_project.tenant_id = ${session}.tenant_id
        AND trash_project.project_id = ${session}.project_id
        AND ${projectRoleSql("trash_project", user)} IN ('owner', 'editor'))
  ))`;
}

export function canBrowseSessionContent(session: {
  status: "active" | "archived" | "deleted";
  projectId?: string | null;
}): boolean {
  return session.status === "active" || (session.status === "archived" && Boolean(session.projectId));
}

export function sessionContentReadAccessSql(content: string, user: string): string {
  return `EXISTS (SELECT 1 FROM sessions access_session
    WHERE access_session.tenant_id = ${content}.tenant_id
      AND access_session.session_id = ${content}.session_id
      AND ${sessionReadAccessSql("access_session", user)})`;
}

// Personal artifacts survive chat deletion. Project artifacts follow the
// session lifecycle and remain unavailable while their session is deleted.
export function artifactReadAccessSql(artifact: string, user: string): string {
  return `EXISTS (SELECT 1 FROM sessions access_session
    WHERE access_session.tenant_id = ${artifact}.tenant_id
      AND access_session.session_id = ${artifact}.session_id
      AND ((access_session.project_id IS NULL AND access_session.user_id = ${user})
        OR (access_session.status <> 'deleted' AND ${projectSessionReadAccessSql("access_session", user)})))`;
}
