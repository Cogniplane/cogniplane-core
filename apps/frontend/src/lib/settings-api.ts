import {
  GithubAllowedRepositoriesResponseSchema,
  GithubConnectionStatusSchema,
  GithubRepositoryListResponseSchema,
  JiraAccountCandidatesResponseSchema,
  JiraAccountSitesResponseSchema,
  JiraConnectionStatusSchema,
  JiraUserConnectionSchema,
  NotionConnectionStatusSchema,
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

import { request } from "./api-client";
import { parseResponse } from "./validate-response";

import type {
  GithubConnectionStatus,
  GithubRepositoryListResponse,
  JiraAccountCandidate,
  JiraConnectionSelectRequest,
  JiraConnectionStatus,
  JiraSite,
  JiraUserConnection,
  NotionConnectionStatus,
  ScheduledJob,
  ScheduledJobRun,
  UserSettingsSection
} from "@cogniplane/shared-types";

export async function listUserSettingsSections(): Promise<UserSettingsSection[]> {
  const raw = await request<unknown>("/me/settings");
  return parseResponse(UserSettingsSectionsResponseSchema, raw, "GET /me/settings").sections;
}

export async function fetchGithubConnectionStatus(): Promise<GithubConnectionStatus> {
  const raw = await request<unknown>("/me/github-connection");
  return parseResponse(GithubConnectionStatusSchema, raw, "GET /me/github-connection");
}

export async function createGithubAuthorizationUrl(): Promise<string> {
  const raw = await request<unknown>("/me/github-connection/authorize", { method: "POST" });
  return parseResponse(
    OAuthAuthorizationUrlResponseSchema,
    raw,
    "POST /me/github-connection/authorize"
  ).url;
}

export async function listGithubRepositories(): Promise<GithubRepositoryListResponse> {
  const raw = await request<unknown>("/me/github-connection/repositories");
  return parseResponse(GithubRepositoryListResponseSchema, raw, "GET /me/github-connection/repositories");
}

/** `githubUserId` is the account that the member saw when they chose the list. */
export async function updateGithubAllowedRepositories(
  githubUserId: string,
  repositories: string[]
): Promise<string[]> {
  const raw = await request<unknown>("/me/github-connection/repositories", {
    method: "PUT",
    body: JSON.stringify({ githubUserId, repositories })
  });
  return parseResponse(
    GithubAllowedRepositoriesResponseSchema,
    raw,
    "PUT /me/github-connection/repositories"
  ).allowedRepositories;
}

export async function deleteGithubConnection(): Promise<void> {
  await request<void>("/me/github-connection", {
    method: "DELETE"
  });
}

export async function fetchNotionConnectionStatus(): Promise<NotionConnectionStatus> {
  const raw = await request<unknown>("/me/notion-connection");
  return parseResponse(NotionConnectionStatusSchema, raw, "GET /me/notion-connection");
}

export async function createNotionAuthorizationUrl(): Promise<string> {
  const raw = await request<unknown>("/me/notion-connection/authorize", { method: "POST" });
  return parseResponse(
    OAuthAuthorizationUrlResponseSchema,
    raw,
    "POST /me/notion-connection/authorize"
  ).url;
}

export async function deleteNotionConnection(): Promise<void> {
  await request<void>("/me/notion-connection", {
    method: "DELETE"
  });
}

export async function fetchJiraConnectionStatus(): Promise<JiraConnectionStatus> {
  const raw = await request<unknown>("/me/jira-connection");
  return parseResponse(JiraConnectionStatusSchema, raw, "GET /me/jira-connection");
}

export async function createJiraAuthorizationUrl(): Promise<string> {
  const raw = await request<unknown>("/me/jira-connection/authorize", { method: "POST" });
  return parseResponse(OAuthAuthorizationUrlResponseSchema, raw, "POST /me/jira-connection/authorize").url;
}

export async function listJiraAccountCandidates(): Promise<JiraAccountCandidate[]> {
  const raw = await request<unknown>("/me/jira-connection/accounts");
  return parseResponse(JiraAccountCandidatesResponseSchema, raw, "GET /me/jira-connection/accounts").accounts;
}

export async function listJiraAccountSites(accountId: string): Promise<JiraSite[]> {
  const path = `/me/jira-connection/accounts/${encodeURIComponent(accountId)}/sites`;
  const raw = await request<unknown>(path);
  return parseResponse(JiraAccountSitesResponseSchema, raw, "GET /me/jira-connection/accounts/:accountId/sites").sites;
}

export async function selectJiraConnection(input: JiraConnectionSelectRequest): Promise<JiraUserConnection> {
  const raw = await request<{ userConnection: unknown }>("/me/jira-connection", {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return parseResponse(JiraUserConnectionSchema, raw.userConnection, "PUT /me/jira-connection");
}

export async function deleteJiraConnection(): Promise<void> {
  await request<void>("/me/jira-connection", { method: "DELETE" });
}

export async function updateUserSettingsSection(
  sectionKey: UserSettingsSection["sectionKey"],
  config: Record<string, unknown>
): Promise<UserSettingsSection> {
  const raw = await request<unknown>(`/me/settings/${sectionKey}`, {
    method: "PUT",
    body: JSON.stringify({ config })
  });
  return parseResponse(UserSettingsSectionEnvelopeSchema, raw, "PUT /me/settings/:sectionKey")
    .section;
}

export async function listScheduledJobs(): Promise<ScheduledJob[]> {
  const raw = await request<unknown>("/me/scheduled-jobs");
  return parseResponse(ScheduledJobsListResponseSchema, raw, "GET /me/scheduled-jobs")
    .scheduledJobs;
}

export async function previewScheduledJob(input: ScheduledJobPreviewRequest): Promise<string | null> {
  const raw = await request<unknown>("/me/scheduled-jobs/preview", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return parseResponse(ScheduledJobPreviewResponseSchema, raw, "POST /me/scheduled-jobs/preview").nextRunAt;
}

export async function createScheduledJob(input: ScheduledJobRequest): Promise<ScheduledJob> {
  const raw = await request<unknown>("/me/scheduled-jobs", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return parseResponse(ScheduledJobEnvelopeSchema, raw, "POST /me/scheduled-jobs").scheduledJob;
}

export async function updateScheduledJob(
  jobId: string,
  input: ScheduledJobRequest
): Promise<ScheduledJob> {
  const raw = await request<unknown>(`/me/scheduled-jobs/${jobId}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return parseResponse(ScheduledJobEnvelopeSchema, raw, "PUT /me/scheduled-jobs/:id").scheduledJob;
}

export async function deleteScheduledJob(jobId: string): Promise<void> {
  await request<void>(`/me/scheduled-jobs/${jobId}`, {
    method: "DELETE"
  });
}

export async function listScheduledJobRuns(jobId: string): Promise<ScheduledJobRun[]> {
  const raw = await request<unknown>(`/me/scheduled-jobs/${jobId}/runs`);
  return parseResponse(ScheduledJobRunsListResponseSchema, raw, "GET /me/scheduled-jobs/:id/runs")
    .runs;
}

export async function fetchPersonalTokenUsage(days: number): Promise<PersonalTokenUsageSeries> {
  const raw = await request<unknown>(`/me/token-usage?days=${days}`);
  return parseResponse(PersonalTokenUsageResponseSchema, raw, "GET /me/token-usage").usage;
}

export type { PersonalTokenUsageSeries } from "@cogniplane/shared-types";
