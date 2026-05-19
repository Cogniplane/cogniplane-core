import {
  GithubConnectionStatusSchema,
  NotionConnectionStatusSchema,
  OAuthAuthorizationUrlResponseSchema,
  PersonalTokenUsageResponseSchema,
  ScheduledJobEnvelopeSchema,
  ScheduledJobRunsListResponseSchema,
  ScheduledJobsListResponseSchema,
  UserSettingsSectionEnvelopeSchema,
  UserSettingsSectionsResponseSchema,
  type PersonalTokenUsageSeries
} from "@cogniplane/shared-types";

import { request } from "./api-client";
import { parseResponse } from "./validate-response";

import type {
  GithubConnectionStatus,
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

export async function createScheduledJob(input: {
  jobName: string;
  description?: string | null;
  cronExpression: string;
  timeZone: string;
  targetType?: "prompt" | "skill";
  targetRef?: string | null;
  input: {
    prompt: string;
  };
  enabled?: boolean;
}): Promise<ScheduledJob> {
  const raw = await request<unknown>("/me/scheduled-jobs", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return parseResponse(ScheduledJobEnvelopeSchema, raw, "POST /me/scheduled-jobs").scheduledJob;
}

export async function updateScheduledJob(
  jobId: string,
  input: {
    jobName: string;
    description?: string | null;
    cronExpression: string;
    timeZone: string;
    targetType?: "prompt" | "skill";
    targetRef?: string | null;
    input: {
      prompt: string;
    };
    enabled?: boolean;
  }
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
