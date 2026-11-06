import type { OrganizationSkillSubmissionDetail, PersonalSkillScope, SkillRevision } from "@cogniplane/shared-types";

export type AcceptedSkillDraft = {
  scope: PersonalSkillScope;
  submissionId: string;
  submissionVersion: number;
  attempt: number;
  acceptedRevisionId: number;
  skillId: string;
  organizationVersion: number;
  activeRevisionId: number | null;
  draftRevisionId: number;
  content: { name: string; description: string; instructions: string };
};

export function acceptedSkillDraft(detail: OrganizationSkillSubmissionDetail, scope: PersonalSkillScope): AcceptedSkillDraft | null {
  const skill = detail.organizationSkill;
  if (detail.status !== "accepted" || detail.latest.status !== "accepted" || !detail.latest.acceptedRevisionId ||
      !skill?.currentDraftRevisionId || !skill.currentDraftContent || skill.skillId !== detail.acceptedOrganizationSkillId ||
      skill.currentDraftRevisionId === skill.activeRevisionId) return null;
  return { scope: { ...scope }, submissionId: detail.id, submissionVersion: detail.version, attempt: detail.latest.attempt,
    acceptedRevisionId: detail.latest.acceptedRevisionId, skillId: skill.skillId, organizationVersion: skill.version,
    activeRevisionId: skill.activeRevisionId, draftRevisionId: skill.currentDraftRevisionId, content: { ...skill.currentDraftContent } };
}

const changed = "This accepted draft has changed or is no longer available. Return to Review and reload the submission before editing.";

export function verifyAcceptedSkillDraft(expected: AcceptedSkillDraft, response: { scope: PersonalSkillScope; submission: OrganizationSkillSubmissionDetail }, revisions: SkillRevision[]): SkillRevision {
  const actual = acceptedSkillDraft(response.submission, response.scope);
  if (!actual || actual.scope.tenantId !== expected.scope.tenantId || actual.scope.userId !== expected.scope.userId ||
      actual.submissionId !== expected.submissionId || actual.submissionVersion !== expected.submissionVersion ||
      actual.attempt !== expected.attempt || actual.acceptedRevisionId !== expected.acceptedRevisionId ||
      actual.skillId !== expected.skillId || actual.organizationVersion !== expected.organizationVersion ||
      actual.activeRevisionId !== expected.activeRevisionId || actual.draftRevisionId !== expected.draftRevisionId ||
      actual.content.name !== expected.content.name || actual.content.description !== expected.content.description ||
      actual.content.instructions !== expected.content.instructions) throw new Error(changed);
  const revision = revisions.find(item => item.skillId === expected.skillId && item.skillRevisionId === expected.draftRevisionId);
  const accepted = revisions.find(item => item.skillId === expected.skillId && item.skillRevisionId === expected.acceptedRevisionId);
  if (!revision || !accepted || accepted.metadata.organizationSubmissionId !== expected.submissionId ||
      accepted.metadata.organizationSubmissionAttempt !== expected.attempt || revision.revisionNumber < accepted.revisionNumber ||
      revisions.some(item => item.skillId === expected.skillId && (item.revisionNumber > revision.revisionNumber ||
        item.revisionNumber > accepted.revisionNumber && typeof item.metadata.organizationSubmissionId === "string" &&
        (item.metadata.organizationSubmissionId !== expected.submissionId || item.metadata.organizationSubmissionAttempt !== expected.attempt))) ||
      revision.sourceType !== "inline" || revision.bundleStorageUri !== null || revision.reviewStatus !== "pending_review" ||
      revision.metadata.skillName !== expected.content.name || revision.metadata.description !== expected.content.description ||
      revision.metadata.instructions !== expected.content.instructions) throw new Error(changed);
  return revision;
}
