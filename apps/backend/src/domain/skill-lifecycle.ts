export const skillValidationStatuses = [
  "validated",
  "validated_with_warnings",
  "active"
] as const;

export const skillReviewStatuses = [
  "pending_review",
  "active",
  "approved"
] as const;

export type SkillValidationStatus = (typeof skillValidationStatuses)[number];
export type SkillReviewStatus = (typeof skillReviewStatuses)[number];

export function canActivateRevision(validationStatus: string): validationStatus is SkillValidationStatus {
  return skillValidationStatuses.includes(validationStatus as SkillValidationStatus);
}

export function canReviewRevision(reviewStatus: string): reviewStatus is SkillReviewStatus {
  return skillReviewStatuses.includes(reviewStatus as SkillReviewStatus);
}

export function isBundleBackedSkill(skill: { sourceType: string | null }): boolean {
  return Boolean(skill.sourceType);
}
