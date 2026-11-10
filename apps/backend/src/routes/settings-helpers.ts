import {
  userSettingsSectionKeys,
  type UserSettingsSectionKey,
  type UserSettingsStore
} from "../services/user-settings-store.js";

export function getSectionTitle(sectionKey: UserSettingsSectionKey): string {
  switch (sectionKey) {
    case "scheduled_jobs":
      return "Scheduled jobs";
    case "github":
      return "GitHub";
    case "skills":
      return "Skill selection";
    case "mcp":
      return "MCP selection";
    case "model":
      return "Model override";
  }
}

export function isLiveSettingsSection(sectionKey: UserSettingsSectionKey): boolean {
  return sectionKey === "scheduled_jobs" || sectionKey === "github";
}

export function buildSectionSummaries(
  storedSections: Awaited<ReturnType<UserSettingsStore["listSections"]>>
) {
  const byKey = new Map(storedSections.map((section) => [section.sectionKey, section]));

  return userSettingsSectionKeys.map((sectionKey) => {
    const existing = byKey.get(sectionKey);
    return {
      sectionKey,
      title: getSectionTitle(sectionKey),
      status: isLiveSettingsSection(sectionKey) ? "live" : "planned",
      version: existing?.version ?? 0,
      config: existing?.config ?? {},
      updatedAt: existing?.updatedAt ?? null
    };
  });
}

export function buildScheduledJobAuditPayload(job: {
  jobId: string;
  jobName: string;
  enabled: boolean;
  nextRunAt: string | null;
}) {
  return {
    jobId: job.jobId,
    jobName: job.jobName,
    enabled: job.enabled,
    nextRunAt: job.nextRunAt
  };
}
