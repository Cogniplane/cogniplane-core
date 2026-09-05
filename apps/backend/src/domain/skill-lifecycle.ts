export const skillValidationStatuses = [
  "validated",
  "validated_with_warnings",
  "active"
] as const;

export type SkillValidationStatus = (typeof skillValidationStatuses)[number];

export function canActivateRevision(validationStatus: string): validationStatus is SkillValidationStatus {
  return skillValidationStatuses.includes(validationStatus as SkillValidationStatus);
}
