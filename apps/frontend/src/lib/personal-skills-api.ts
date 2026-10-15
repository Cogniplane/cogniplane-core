import {
  PersonalSkillDeleteResponseSchema, PersonalSkillHistoryResponseSchema,
  PersonalSkillResponseSchema, PersonalSkillsResponseSchema,
  type PersonalSkillAction, type PersonalSkillCreate, type PersonalSkillUpdate
} from "@cogniplane/shared-types";
import { request } from "./api-client";
import { parseResponse } from "./validate-response";

const path = "/me/skills";
const skillPath = (id: string) => `${path}/${encodeURIComponent(id)}`;

export async function getPersonalSkills() {
  return parseResponse(PersonalSkillsResponseSchema, await request<unknown>(path), `GET ${path}`);
}

export async function createPersonalSkill(input: PersonalSkillCreate) {
  return parseResponse(PersonalSkillResponseSchema,
    await request<unknown>(path, { method: "POST", body: JSON.stringify(input) }), `POST ${path}`);
}

export async function updatePersonalSkill(id: string, input: PersonalSkillUpdate) {
  const url = skillPath(id);
  return parseResponse(PersonalSkillResponseSchema,
    await request<unknown>(url, { method: "PUT", body: JSON.stringify(input) }), `PUT ${url}`);
}

export async function actOnPersonalSkill(id: string, input: PersonalSkillAction) {
  const url = `${skillPath(id)}/action`;
  return parseResponse(PersonalSkillResponseSchema,
    await request<unknown>(url, { method: "POST", body: JSON.stringify(input) }), `POST ${url}`);
}

export async function deletePersonalSkill(id: string, input: { scope: PersonalSkillAction["scope"]; version: number }) {
  const url = skillPath(id);
  return parseResponse(PersonalSkillDeleteResponseSchema,
    await request<unknown>(url, { method: "DELETE", body: JSON.stringify(input) }), `DELETE ${url}`);
}

export async function getPersonalSkillHistory(id: string) {
  const url = `${skillPath(id)}/history`;
  return parseResponse(PersonalSkillHistoryResponseSchema, await request<unknown>(url), `GET ${url}`);
}

export async function getPersonalSkill(id: string) {
  const url = skillPath(id);
  return parseResponse(PersonalSkillResponseSchema, await request<unknown>(url), `GET ${url}`);
}
