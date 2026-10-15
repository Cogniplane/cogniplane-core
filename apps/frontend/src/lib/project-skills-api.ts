import {
  ProjectSkillDeleteResponseSchema, ProjectSkillHistoryResponseSchema, ProjectSkillResponseSchema,
  ProjectSkillsResponseSchema, type ProjectSkillAction, type ProjectSkillCopy, type ProjectSkillCreate,
  type ProjectSkillDelete, type ProjectSkillSourceUpdate, type ProjectSkillUpdate
} from "@cogniplane/shared-types";
import { request } from "./api-client";
import { parseResponse } from "./validate-response";

const path = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/skills`;
const skillPath = (projectId: string, id: string) => `${path(projectId)}/${encodeURIComponent(id)}`;
const send = (method: string, input: unknown) => ({ method, body: JSON.stringify(input) });

export async function getProjectSkills(projectId: string) {
  return parseResponse(ProjectSkillsResponseSchema, await request<unknown>(path(projectId)), "GET /projects/:id/skills");
}

export async function createProjectSkill(projectId: string, input: ProjectSkillCreate) {
  return parseResponse(ProjectSkillResponseSchema,
    await request<unknown>(path(projectId), send("POST", input)), "POST /projects/:id/skills");
}

export async function copyPersonalSkillToProject(projectId: string, input: ProjectSkillCopy) {
  return parseResponse(ProjectSkillResponseSchema,
    await request<unknown>(`${path(projectId)}/from-personal`, send("POST", input)), "POST /projects/:id/skills/from-personal");
}

export async function updateProjectSkill(projectId: string, id: string, input: ProjectSkillUpdate) {
  return parseResponse(ProjectSkillResponseSchema,
    await request<unknown>(skillPath(projectId, id), send("PUT", input)), "PUT /projects/:id/skills/:skillId");
}

export async function updateProjectSkillFromPersonal(projectId: string, id: string, input: ProjectSkillSourceUpdate) {
  return parseResponse(ProjectSkillResponseSchema,
    await request<unknown>(`${skillPath(projectId, id)}/from-personal`, send("POST", input)),
    "POST /projects/:id/skills/:skillId/from-personal");
}

export async function actOnProjectSkill(projectId: string, id: string, input: ProjectSkillAction) {
  return parseResponse(ProjectSkillResponseSchema,
    await request<unknown>(`${skillPath(projectId, id)}/action`, send("POST", input)), "POST /projects/:id/skills/:skillId/action");
}

export async function deleteProjectSkill(projectId: string, id: string, input: ProjectSkillDelete) {
  return parseResponse(ProjectSkillDeleteResponseSchema,
    await request<unknown>(skillPath(projectId, id), send("DELETE", input)), "DELETE /projects/:id/skills/:skillId");
}

export async function getProjectSkillHistory(projectId: string, id: string) {
  return parseResponse(ProjectSkillHistoryResponseSchema,
    await request<unknown>(`${skillPath(projectId, id)}/history`), "GET /projects/:id/skills/:skillId/history");
}
