import {
  z,
  GithubAllowedRepositoriesResponseSchema,
  GithubConnectionStatusSchema,
  GithubRepositoryListResponseSchema,
  GithubUserConnectionSchema,
  JiraAccountCandidatesResponseSchema,
  JiraAccountSitesResponseSchema,
  JiraConnectionStatusSchema,
  JiraUserConnectionSchema,
  NotionConnectionStatusSchema,
  NotionUserConnectionSchema,
  OAuthAuthorizationUrlResponseSchema,
  PersonalTokenUsageResponseSchema,
  ScheduledJobEnvelopeSchema,
  ScheduledJobPreviewResponseSchema,
  ScheduledJobRunsListResponseSchema,
  ScheduledJobsListResponseSchema,
  UserSettingsSectionEnvelopeSchema,
  UserSettingsSectionsResponseSchema,
  type PersonalTokenUsageSeries,
  type ScheduledJobPreviewRequest,
  type ScheduledJobRequest
} from "@cogniplane/shared-types";

import { requestJson, requestEmpty } from "./api-client";

import type {
  GithubConnectionStatus,
  GithubRepositoryListResponse,
  GithubUserConnection,
  JiraAccountCandidate,
  JiraConnectionSelectRequest,
  JiraConnectionStatus,
  JiraSite,
  JiraUserConnection,
  NotionConnectionConfirmRequest,
  NotionConnectionStatus,
  NotionUserConnection,
  ScheduledJob,
  ScheduledJobRun,
  UserSettingsSection
} from "@cogniplane/shared-types";

export async function listUserSettingsSections(): Promise<UserSettingsSection[]> {
  return (await requestJson("/me/settings", UserSettingsSectionsResponseSchema)).sections;
}

export async function fetchGithubConnectionStatus(): Promise<GithubConnectionStatus> {
  return await requestJson("/me/github-connection", GithubConnectionStatusSchema);
}

export async function createGithubAuthorizationUrl(): Promise<string> {
  return (await requestJson("/me/github-connection/authorize", OAuthAuthorizationUrlResponseSchema, { method: "POST" })).url;
}

export async function listGithubRepositories(): Promise<GithubRepositoryListResponse> {
  return await requestJson("/me/github-connection/repositories", GithubRepositoryListResponseSchema);
}

/** `githubUserId` is the account that the member saw when they chose the list. */
export async function updateGithubAllowedRepositories(
  githubUserId: string,
  repositories: string[]
): Promise<string[]> {
  return (await requestJson("/me/github-connection/repositories", GithubAllowedRepositoriesResponseSchema, {
    method: "PUT",
    body: JSON.stringify({ githubUserId, repositories })
  })).allowedRepositories;
}

/** Confirms a suspended connection. `githubUserId` is the account that the page shows. */
export async function confirmGithubConnection(githubUserId: string): Promise<GithubUserConnection> {
  return (await requestJson("/me/github-connection/confirm", z.object({ userConnection: GithubUserConnectionSchema }), {
    method: "POST",
    body: JSON.stringify({ githubUserId })
  })).userConnection;
}

export async function deleteGithubConnection(): Promise<void> {
  await requestEmpty("/me/github-connection", {
    method: "DELETE"
  });
}

export async function fetchNotionConnectionStatus(): Promise<NotionConnectionStatus> {
  return await requestJson("/me/notion-connection", NotionConnectionStatusSchema);
}

export async function createNotionAuthorizationUrl(): Promise<string> {
  return (await requestJson("/me/notion-connection/authorize", OAuthAuthorizationUrlResponseSchema, { method: "POST" })).url;
}

/** Confirms a suspended connection for the Notion user and workspace that the page shows. */
export async function confirmNotionConnection(input: NotionConnectionConfirmRequest): Promise<NotionUserConnection> {
  return (await requestJson("/me/notion-connection/confirm", z.object({ userConnection: NotionUserConnectionSchema }), {
    method: "POST",
    body: JSON.stringify(input)
  })).userConnection;
}

export async function deleteNotionConnection(): Promise<void> {
  await requestEmpty("/me/notion-connection", {
    method: "DELETE"
  });
}

export async function fetchJiraConnectionStatus(): Promise<JiraConnectionStatus> {
  return await requestJson("/me/jira-connection", JiraConnectionStatusSchema);
}

export async function createJiraAuthorizationUrl(): Promise<string> {
  return (await requestJson("/me/jira-connection/authorize", OAuthAuthorizationUrlResponseSchema, { method: "POST" })).url;
}

export async function listJiraAccountCandidates(): Promise<JiraAccountCandidate[]> {
  return (await requestJson("/me/jira-connection/accounts", JiraAccountCandidatesResponseSchema)).accounts;
}

export async function listJiraAccountSites(accountId: string): Promise<JiraSite[]> {
  const path = `/me/jira-connection/accounts/${encodeURIComponent(accountId)}/sites`;
  return (await requestJson(path, JiraAccountSitesResponseSchema)).sites;
}

export async function selectJiraConnection(input: JiraConnectionSelectRequest): Promise<JiraUserConnection> {
  return (await requestJson("/me/jira-connection", z.object({ userConnection: JiraUserConnectionSchema }), {
    method: "PUT",
    body: JSON.stringify(input)
  })).userConnection;
}

export async function deleteJiraConnection(): Promise<void> {
  await requestEmpty("/me/jira-connection", { method: "DELETE" });
}

export async function updateUserSettingsSection(
  sectionKey: UserSettingsSection["sectionKey"],
  config: Record<string, unknown>
): Promise<UserSettingsSection> {
  return (await requestJson(`/me/settings/${sectionKey}`, UserSettingsSectionEnvelopeSchema, {
    method: "PUT",
    body: JSON.stringify({ config })
  })).section;
}

export async function listScheduledJobs(): Promise<ScheduledJob[]> {
  return (await requestJson("/me/scheduled-jobs", ScheduledJobsListResponseSchema)).scheduledJobs;
}

export async function previewScheduledJob(input: ScheduledJobPreviewRequest): Promise<string | null> {
  return (await requestJson("/me/scheduled-jobs/preview", ScheduledJobPreviewResponseSchema, {
    method: "POST",
    body: JSON.stringify(input)
  })).nextRunAt;
}

export async function createScheduledJob(input: ScheduledJobRequest): Promise<ScheduledJob> {
  return (await requestJson("/me/scheduled-jobs", ScheduledJobEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify(input)
  })).scheduledJob;
}

export async function updateScheduledJob(
  jobId: string,
  input: ScheduledJobRequest
): Promise<ScheduledJob> {
  return (await requestJson(`/me/scheduled-jobs/${jobId}`, ScheduledJobEnvelopeSchema, {
    method: "PUT",
    body: JSON.stringify(input)
  })).scheduledJob;
}

export async function deleteScheduledJob(jobId: string): Promise<void> {
  await requestEmpty(`/me/scheduled-jobs/${jobId}`, {
    method: "DELETE"
  });
}

export async function listScheduledJobRuns(jobId: string): Promise<ScheduledJobRun[]> {
  return (await requestJson(`/me/scheduled-jobs/${jobId}/runs`, ScheduledJobRunsListResponseSchema)).runs;
}

export async function fetchPersonalTokenUsage(days: number): Promise<PersonalTokenUsageSeries> {
  return (await requestJson(`/me/token-usage?days=${days}`, PersonalTokenUsageResponseSchema)).usage;
}

export type { PersonalTokenUsageSeries } from "@cogniplane/shared-types";
