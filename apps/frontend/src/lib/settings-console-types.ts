import type { UserSettingsSection } from "@cogniplane/shared-types";

export type JobDraft = {
  jobName: string;
  description: string;
  cronExpression: string;
  timeZone: string;
  prompt: string;
  enabled: boolean;
};

export type ScheduledJobDefaults = {
  defaultTimeZone: string;
  enableOnCreate: boolean;
};

export function defaultJobDraft(defaults?: ScheduledJobDefaults): JobDraft {
  return {
    jobName: "",
    description: "",
    cronExpression: "0 9 * * 1-5",
    timeZone: defaults?.defaultTimeZone || "UTC",
    prompt: "Summarize new artifacts, approvals, and next actions.",
    enabled: defaults?.enableOnCreate ?? true
  };
}

export function readScheduledJobDefaults(
  section: UserSettingsSection | undefined
): ScheduledJobDefaults {
  return {
    defaultTimeZone:
      typeof section?.config.defaultTimeZone === "string" && section.config.defaultTimeZone.trim()
        ? section.config.defaultTimeZone
        : "UTC",
    enableOnCreate:
      typeof section?.config.enableOnCreate === "boolean" ? section.config.enableOnCreate : true
  };
}
