import {
  ProjectSkillDeleteResponseSchema, ProjectSkillHistoryResponseSchema, ProjectSkillResponseSchema,
  ProjectSkillsResponseSchema, type ProjectSkillAction, type ProjectSkillCopy, type ProjectSkillCreate,
  type ProjectSkillDelete, type ProjectSkillSourceUpdate, type ProjectSkillUpdate
} from "@cogniplane/shared-types";
import { requestJson } from "./api-client";

const path = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/skills`;
const skillPath = (projectId: string, id: string) => `${path(projectId)}/${encodeURIComponent(id)}`;
const send = (method: string, input: unknown) => ({ method, body: JSON.stringify(input) });

export async function getProjectSkills(projectId: string) {
  return await requestJson(path(projectId), ProjectSkillsResponseSchema);
}

export async function createProjectSkill(projectId: string, input: ProjectSkillCreate) {
  return await requestJson(path(projectId), ProjectSkillResponseSchema, send("POST", input));
}

export async function copyPersonalSkillToProject(projectId: string, input: ProjectSkillCopy) {
  return await requestJson(`${path(projectId)}/from-personal`, ProjectSkillResponseSchema, send("POST", input));
}

export async function updateProjectSkill(projectId: string, id: string, input: ProjectSkillUpdate) {
  return await requestJson(skillPath(projectId, id), ProjectSkillResponseSchema, send("PUT", input));
}

export async function updateProjectSkillFromPersonal(projectId: string, id: string, input: ProjectSkillSourceUpdate) {
  return await requestJson(`${skillPath(projectId, id)}/from-personal`, ProjectSkillResponseSchema, send("POST", input));
}

export async function actOnProjectSkill(projectId: string, id: string, input: ProjectSkillAction) {
  return await requestJson(`${skillPath(projectId, id)}/action`, ProjectSkillResponseSchema, send("POST", input));
}

export async function deleteProjectSkill(projectId: string, id: string, input: ProjectSkillDelete) {
  return await requestJson(skillPath(projectId, id), ProjectSkillDeleteResponseSchema, send("DELETE", input));
}

export async function getProjectSkillHistory(projectId: string, id: string) {
  return await requestJson(`${skillPath(projectId, id)}/history`, ProjectSkillHistoryResponseSchema);
}
