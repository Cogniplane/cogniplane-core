import {
  ProjectSchema,
  ProjectInstructionsStatusSchema,
  ProjectsResponseSchema,
  ProjectDetailSchema,
  SessionEnvelopeSchema,
  SessionsListResponseSchema,
  SESSION_TRASH_RETENTION_DAYS,
  ProjectMembersResponseSchema,
  ProjectMemberUpdateResponseSchema
} from "@cogniplane/shared-types";
import { ProjectCapabilitiesSchema, type ProjectCapabilitiesUpdate } from "@cogniplane/shared-types";
import { ArtifactsListResponseSchema } from "@cogniplane/shared-types";
import type { ProjectAgentFileMode, ProjectApprovalMode, ProjectSharingUpdate } from "@cogniplane/shared-types";
import { requestJson, requestEmpty } from "./api-client";
import type { SessionList } from "./session-api";
const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;
export async function getProjectCapabilities(id: string) {
  return await requestJson(`${projectPath(id)}/capabilities`, ProjectCapabilitiesSchema);
}
export async function updateProjectCapabilities(id: string, input: ProjectCapabilitiesUpdate) {
  return await requestJson(`${projectPath(id)}/capabilities`, ProjectCapabilitiesSchema, {
      method: "PUT", body: JSON.stringify(input)
    });
}
export async function listProjectSessions(id: string, options: {
  status: "active" | "archived" | "deleted";
  cursor?: string;
  signal?: AbortSignal;
}): Promise<SessionList> {
  const query = new URLSearchParams({ status: options.status });
  if (options.cursor) query.set("cursor", options.cursor);
  const response = await requestJson(`${projectPath(id)}/sessions?${query}`, SessionsListResponseSchema, { signal: options.signal });
  return { ...response, trashRetentionDays: response.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS };
}
export async function listProjects(options: { archived?: boolean; q?: string } = {}) {
  const query = new URLSearchParams({
    archived: String(options.archived ?? false)
  });
  if (options.q?.trim()) query.set("q", options.q.trim());
  return (await requestJson(`/projects?${query}`, ProjectsResponseSchema)).projects;
}
export async function createProject(name: string) {
  return await requestJson("/projects", ProjectSchema, { method: "POST", body: JSON.stringify({ name }) });
}
export async function getProject(id: string) {
  return await requestJson(projectPath(id), ProjectDetailSchema);
}
export async function listProjectArtifacts(id: string, signal?: AbortSignal) {
  return (await requestJson(projectPath(id) + "/artifacts", ArtifactsListResponseSchema, { signal })).artifacts;
}
export async function renameProject(id: string, name: string) {
  return await requestJson(projectPath(id), ProjectSchema, { method: "PUT", body: JSON.stringify({ name }) });
}
export async function setProjectSession(id: string, sessionId: string) {
  await requestEmpty(projectPath(id) + "/sessions", {
    method: "PUT",
    body: JSON.stringify({ sessionId, confirmAudience: true })
  });
}
export async function createProjectSession(id: string, name = "New session") {
  return (await requestJson(projectPath(id) + "/sessions", SessionEnvelopeSchema, {
      method: "POST",
      body: JSON.stringify({ name })
    })).session;
}

export async function archiveProject(id: string, archived: boolean) {
  await requestEmpty(projectPath(id) + "/archive", {
    method: "PUT",
    body: JSON.stringify({ archived })
  });
}
export async function getProjectInstructionsStatus(id: string) {
  return await requestJson(projectPath(id) + "/instructions/status", ProjectInstructionsStatusSchema);
}
export async function updateProjectInstructions(id: string, instructions: string, expectedRevision: number) {
  return await requestJson(projectPath(id) + "/instructions", ProjectSchema, {
    method: "PUT", body: JSON.stringify({ instructions, expectedRevision })
  });
}
export async function updateProjectApprovalMode(id: string, approvalMode: ProjectApprovalMode) {
  return await requestJson(projectPath(id) + "/approval-mode", ProjectSchema, {
    method: "PUT", body: JSON.stringify({ approvalMode })
  });
}
export async function updateProjectAgentFileMode(id: string, agentFileMode: ProjectAgentFileMode) {
  return await requestJson(projectPath(id) + "/agent-file-mode", ProjectSchema, {
    method: "PUT", body: JSON.stringify({ agentFileMode })
  });
}

export async function getProjectAccess(id: string) {
  return await requestJson(projectPath(id) + "/members", ProjectMembersResponseSchema);
}

/** `input.expected` is the saved access that the owner saw and confirmed. The
 *  backend returns 409 `project_sharing_conflict` when the saved access is different. */
export async function updateProjectSharing(id: string, input: ProjectSharingUpdate) {
  await requestEmpty(projectPath(id) + "/sharing", {
    method: "PUT",
    body: JSON.stringify({ ...input, confirmAudience: input.confirmAudience ?? false })
  });
}

/** Sets the explicit role of a member, or removes it with a null role. A member
 *  can remove their own role. `confirmRetainedRole` confirms the access that
 *  organization sharing still gives afterwards. The last owner can leave or
 *  lose the role only with `confirmNoOwner: true`, after the caller warns.
 *  Without it, the backend counts the current owners and returns 409
 *  `project_no_owner_confirmation_required` when none stays. */
export async function updateProjectMember(id: string, userId: string, input: {
  role: "owner" | "editor" | "viewer" | null;
  confirmRetainedRole?: "viewer" | "editor";
  confirmNoOwner?: boolean;
}) {
  return await requestJson(`${projectPath(id)}/members/${encodeURIComponent(userId)}`, ProjectMemberUpdateResponseSchema, {
      method: "PUT",
      body: JSON.stringify(input)
    });
}
