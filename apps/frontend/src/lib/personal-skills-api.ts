import {
  PersonalSkillDeleteResponseSchema, PersonalSkillHistoryResponseSchema,
  PersonalSkillResponseSchema, PersonalSkillsResponseSchema,
  type PersonalSkillAction, type PersonalSkillCreate, type PersonalSkillUpdate
} from "@cogniplane/shared-types";
import { requestJson } from "./api-client";

const path = "/me/skills";
const skillPath = (id: string) => `${path}/${encodeURIComponent(id)}`;

export async function getPersonalSkills() {
  return await requestJson(path, PersonalSkillsResponseSchema);
}

export async function createPersonalSkill(input: PersonalSkillCreate) {
  return await requestJson(path, PersonalSkillResponseSchema, { method: "POST", body: JSON.stringify(input) });
}

export async function updatePersonalSkill(id: string, input: PersonalSkillUpdate) {
  const url = skillPath(id);
  return await requestJson(url, PersonalSkillResponseSchema, { method: "PUT", body: JSON.stringify(input) });
}

export async function actOnPersonalSkill(id: string, input: PersonalSkillAction) {
  const url = `${skillPath(id)}/action`;
  return await requestJson(url, PersonalSkillResponseSchema, { method: "POST", body: JSON.stringify(input) });
}

export async function deletePersonalSkill(id: string, input: { scope: PersonalSkillAction["scope"]; version: number }) {
  const url = skillPath(id);
  return await requestJson(url, PersonalSkillDeleteResponseSchema, { method: "DELETE", body: JSON.stringify(input) });
}

export async function getPersonalSkillHistory(id: string) {
  const url = `${skillPath(id)}/history`;
  return await requestJson(url, PersonalSkillHistoryResponseSchema);
}

export async function getPersonalSkill(id: string) {
  const url = skillPath(id);
  return await requestJson(url, PersonalSkillResponseSchema);
}
