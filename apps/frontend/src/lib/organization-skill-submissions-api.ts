import {
  OrganizationSkillSubmissionResponseSchema,
  OrganizationSkillSubmissionUpdatesResponseSchema,
  OrganizationSkillSubmissionUpdateReadResponseSchema,
  OrganizationSkillSubmissionsResponseSchema,
  type OrganizationSkillSubmissionDetail,
  type AdminSkillReleaseSnapshot,
  type PersonalSkillScope
} from "@cogniplane/shared-types";
import { request } from "./api-client";
import { parseResponse } from "./validate-response";

const memberPath = "/me/skill-submissions";
const adminPath = "/admin/skill-submissions";
const submissionPath = (path: string, id: string) => `${path}/${encodeURIComponent(id)}`;

export type SubmissionDecision = {
  scope: PersonalSkillScope;
  version: number;
  action: "request_changes" | "decline" | "accept";
  reason: string | null;
  organizationSkillId: string | null;
  organizationSkillName: string | null;
  expectedOrganizationVersion: number | null;
};

function parseList(raw: unknown, context: string) {
  return parseResponse(OrganizationSkillSubmissionsResponseSchema, raw, context);
}
function parseDetail(raw: unknown, context: string) {
  return parseResponse(OrganizationSkillSubmissionResponseSchema, raw, context);
}

export async function listMySkillSubmissions() {
  return parseList(await request<unknown>(memberPath), `GET ${memberPath}`);
}
export async function getMySkillSubmission(id: string) {
  const path = submissionPath(memberPath, id);
  return parseDetail(await request<unknown>(path), `GET ${path}`);
}
export async function listMySkillSubmissionUpdates(before?: string) {
  const path = `/me/skill-submission-updates?limit=20${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  return parseResponse(OrganizationSkillSubmissionUpdatesResponseSchema, await request<unknown>(path), `GET ${path}`);
}
export async function readMySkillSubmissionUpdate(id: string, scope: PersonalSkillScope) {
  const path = `/me/skill-submission-updates/${encodeURIComponent(id)}/read`;
  return parseResponse(OrganizationSkillSubmissionUpdateReadResponseSchema,
    await request<unknown>(path, { method: "POST", body: JSON.stringify({ scope }) }), `POST ${path}`);
}
export async function submitPersonalSkill(input: {
  scope: PersonalSkillScope; personalSkillId: string; sourceRevision: number; note: string;
  targetOrganizationSkillId: string | null;
}) {
  return parseDetail(await request<unknown>(memberPath, { method: "POST", body: JSON.stringify(input) }), `POST ${memberPath}`);
}
export async function withdrawSkillSubmission(id: string, input: { scope: PersonalSkillScope; version: number }) {
  const path = `${submissionPath(memberPath, id)}/withdraw`;
  return parseDetail(await request<unknown>(path, { method: "POST", body: JSON.stringify(input) }), `POST ${path}`);
}
export async function resubmitSkillSubmission(id: string, input: {
  scope: PersonalSkillScope; version: number; sourceRevision: number; note: string;
}) {
  const path = `${submissionPath(memberPath, id)}/resubmit`;
  return parseDetail(await request<unknown>(path, { method: "POST", body: JSON.stringify(input) }), `POST ${path}`);
}
export async function listAdminSkillSubmissions() {
  return parseList(await request<unknown>(adminPath), `GET ${adminPath}`);
}
export async function getAdminSkillSubmission(id: string): Promise<{ scope: PersonalSkillScope; submission: OrganizationSkillSubmissionDetail }> {
  const path = submissionPath(adminPath, id);
  return parseDetail(await request<unknown>(path), `GET ${path}`);
}
export async function decideSkillSubmission(id: string, input: SubmissionDecision) {
  const path = `${submissionPath(adminPath, id)}/decision`;
  return parseDetail(await request<unknown>(path, { method: "POST", body: JSON.stringify(input) }), `POST ${path}`);
}
export async function releaseSkillSubmission(id: string, input: {
  scope: PersonalSkillScope;
  expectedOrganizationVersion: number;
  expectedActiveRevisionId: number | null;
  expectedDraftRevisionId: number;
  audience: "test-users" | "members";
  expectedSnapshot: AdminSkillReleaseSnapshot;
}) {
  const path = `${submissionPath(adminPath, id)}/release`;
  return parseDetail(await request<unknown>(path, { method: "POST", body: JSON.stringify(input) }), `POST ${path}`);
}
