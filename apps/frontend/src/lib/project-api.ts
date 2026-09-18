import {
  ProjectSchema,
  ProjectInstructionsStatusSchema,
  ProjectsResponseSchema,
  ProjectDetailSchema,
  SessionEnvelopeSchema,
  ProjectMembersResponseSchema
} from "@cogniplane/shared-types";
import type { ProjectAgentFileMode, ProjectApprovalMode } from "@cogniplane/shared-types";
import { request } from "./api-client";
import { parseResponse } from "./validate-response";
const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;
export async function listProjects(options: { archived?: boolean; q?: string } = {}) {
  const query = new URLSearchParams({
    archived: String(options.archived ?? false)
  });
  if (options.q?.trim()) query.set("q", options.q.trim());
  return parseResponse(
    ProjectsResponseSchema,
    await request<unknown>(`/projects?${query}`),
    "GET /projects"
  ).projects;
}
export async function createProject(name: string) {
  return parseResponse(
    ProjectSchema,
    await request<unknown>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
    "POST /projects"
  );
}
export async function getProject(id: string) {
  return parseResponse(
    ProjectDetailSchema,
    await request<unknown>(projectPath(id)),
    "GET /projects/:id"
  );
}
export async function renameProject(id: string, name: string) {
  return parseResponse(
    ProjectSchema,
    await request<unknown>(projectPath(id), { method: "PUT", body: JSON.stringify({ name }) }),
    "PUT /projects/:id"
  );
}
export async function setProjectSession(id: string, sessionId: string) {
  await request(projectPath(id) + "/sessions", {
    method: "PUT",
    body: JSON.stringify({ sessionId, confirmAudience: true })
  });
}
export async function createProjectSession(id: string, name = "New session") {
  return parseResponse(
    SessionEnvelopeSchema,
    await request<unknown>(projectPath(id) + "/sessions", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
    "POST /projects/:id/sessions"
  ).session;
}

export async function archiveProject(id: string, archived: boolean) {
  await request(projectPath(id) + "/archive", {
    method: "PUT",
    body: JSON.stringify({ archived })
  });
}
export async function getProjectInstructionsStatus(id: string) {
  return parseResponse(ProjectInstructionsStatusSchema, await request<unknown>(projectPath(id) + "/instructions/status"),
    "GET /projects/:id/instructions/status");
}
export async function updateProjectInstructions(id: string, instructions: string, expectedRevision: number) {
  return parseResponse(ProjectSchema, await request<unknown>(projectPath(id) + "/instructions", {
    method: "PUT", body: JSON.stringify({ instructions, expectedRevision })
  }), "PUT /projects/:id/instructions");
}
export async function updateProjectApprovalMode(id: string, approvalMode: ProjectApprovalMode) {
  return parseResponse(ProjectSchema, await request<unknown>(projectPath(id) + "/approval-mode", {
    method: "PUT", body: JSON.stringify({ approvalMode })
  }), "PUT /projects/:id/approval-mode");
}
export async function updateProjectAgentFileMode(id: string, agentFileMode: ProjectAgentFileMode) {
  return parseResponse(ProjectSchema, await request<unknown>(projectPath(id) + "/agent-file-mode", {
    method: "PUT", body: JSON.stringify({ agentFileMode })
  }), "PUT /projects/:id/agent-file-mode");
}

export async function getProjectAccess(id: string) {
  return parseResponse(
    ProjectMembersResponseSchema,
    await request<unknown>(projectPath(id) + "/members"),
    "GET /projects/:id/members"
  );
}

export async function updateProjectSharing(id: string, input: {
  visibility: "private" | "organization";
  organizationRole: "viewer" | "editor";
  confirmAudience?: boolean;
}) {
  await request(projectPath(id) + "/sharing", {
    method: "PUT",
    body: JSON.stringify({ ...input, confirmAudience: input.confirmAudience ?? false })
  });
}
