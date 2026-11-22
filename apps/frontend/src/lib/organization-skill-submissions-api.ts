import {
  OrganizationSkillSubmissionResponseSchema,
  OrganizationSkillSubmissionUpdatesResponseSchema,
  OrganizationSkillSubmissionUpdateReadResponseSchema,
  OrganizationSkillSubmissionsResponseSchema,
  type OrganizationSkillSubmissionDetail,
  type AdminSkillReleaseSnapshot,
  type PersonalSkillScope
} from "@cogniplane/shared-types";
import { requestJson } from "./api-client";

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

export async function listMySkillSubmissions() {
  return await requestJson(memberPath, OrganizationSkillSubmissionsResponseSchema);
}
export async function getMySkillSubmission(id: string) {
  const path = submissionPath(memberPath, id);
  return await requestJson(path, OrganizationSkillSubmissionResponseSchema);
}
export async function listMySkillSubmissionUpdates(before?: string) {
  const path = `/me/skill-submission-updates?limit=20${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  return await requestJson(path, OrganizationSkillSubmissionUpdatesResponseSchema);
}
export async function readMySkillSubmissionUpdate(id: string, scope: PersonalSkillScope) {
  const path = `/me/skill-submission-updates/${encodeURIComponent(id)}/read`;
  return await requestJson(path, OrganizationSkillSubmissionUpdateReadResponseSchema, { method: "POST", body: JSON.stringify({ scope }) });
}
export async function submitPersonalSkill(input: {
  scope: PersonalSkillScope; personalSkillId: string; sourceRevision: number; note: string;
  targetOrganizationSkillId: string | null;
}) {
  return await requestJson(memberPath, OrganizationSkillSubmissionResponseSchema, { method: "POST", body: JSON.stringify(input) });
}
export async function withdrawSkillSubmission(id: string, input: { scope: PersonalSkillScope; version: number }) {
  const path = `${submissionPath(memberPath, id)}/withdraw`;
  return await requestJson(path, OrganizationSkillSubmissionResponseSchema, { method: "POST", body: JSON.stringify(input) });
}
export async function resubmitSkillSubmission(id: string, input: {
  scope: PersonalSkillScope; version: number; sourceRevision: number; note: string;
}) {
  const path = `${submissionPath(memberPath, id)}/resubmit`;
  return await requestJson(path, OrganizationSkillSubmissionResponseSchema, { method: "POST", body: JSON.stringify(input) });
}
export async function listAdminSkillSubmissions() {
  return await requestJson(adminPath, OrganizationSkillSubmissionsResponseSchema);
}
export async function getAdminSkillSubmission(id: string): Promise<{ scope: PersonalSkillScope; submission: OrganizationSkillSubmissionDetail }> {
  const path = submissionPath(adminPath, id);
  return await requestJson(path, OrganizationSkillSubmissionResponseSchema);
}
export async function decideSkillSubmission(id: string, input: SubmissionDecision) {
  const path = `${submissionPath(adminPath, id)}/decision`;
  return await requestJson(path, OrganizationSkillSubmissionResponseSchema, { method: "POST", body: JSON.stringify(input) });
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
  return await requestJson(path, OrganizationSkillSubmissionResponseSchema, { method: "POST", body: JSON.stringify(input) });
}
