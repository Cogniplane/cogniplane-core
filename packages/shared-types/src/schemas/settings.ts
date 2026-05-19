import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

import { EFFORT_LEVELS } from "../primitives.js";

const RuntimeProviderSchema = z.enum(["codex", "claude-code"]);
const EffortLevelSchema = z.enum(EFFORT_LEVELS);

const ProviderEnumSchema = RuntimeProviderSchema;

export const ModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  provider: RuntimeProviderSchema,
  supportedEfforts: z.array(EffortLevelSchema),
  defaultEffort: EffortLevelSchema.nullable()
}).passthrough();
export type Model = z.infer<typeof ModelSchema>;

export const ModelsListResponseSchema = z.object({
  models: z.array(ModelSchema),
  enabledRuntimeProviders: z.array(ProviderEnumSchema),
  defaultRuntimeProvider: ProviderEnumSchema,
  showEffortSelector: z.boolean()
}).passthrough();
export type ModelsListResponse = z.infer<typeof ModelsListResponseSchema>;

export const UserSettingsSectionSchema = z.object({
  sectionKey: z.enum(["scheduled_jobs", "github", "skills", "mcp", "model"]),
  title: z.string(),
  status: z.enum(["live", "planned"]),
  version: z.number(),
  config: z.record(z.string(), z.unknown()),
  updatedAt: IsoDateSchema.nullable()
}).passthrough();
export type UserSettingsSection = z.infer<typeof UserSettingsSectionSchema>;

export const ScheduledJobSchema = z.object({
  jobId: z.string(),
  userId: z.string(),
  jobName: z.string(),
  description: z.string().nullable(),
  scheduleKind: z.literal("cron"),
  cronExpression: z.string(),
  timeZone: z.string(),
  targetType: z.enum(["prompt", "skill"]),
  targetRef: z.string().nullable(),
  input: z.object({
    prompt: z.string()
  }).passthrough(),
  settingsSnapshot: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  lastRunAt: IsoDateSchema.nullable(),
  nextRunAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
}).passthrough();
export type ScheduledJob = z.infer<typeof ScheduledJobSchema>;

export const ScheduledJobsListResponseSchema = z.object({
  scheduledJobs: z.array(ScheduledJobSchema)
}).passthrough();
export type ScheduledJobsListResponse = z.infer<typeof ScheduledJobsListResponseSchema>;

export const ScheduledJobEnvelopeSchema = z.object({
  scheduledJob: ScheduledJobSchema
}).passthrough();
export type ScheduledJobEnvelope = z.infer<typeof ScheduledJobEnvelopeSchema>;

export const ScheduledJobRunSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  userId: z.string(),
  sessionId: z.string().nullable(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  startedAt: IsoDateSchema,
  completedAt: IsoDateSchema.nullable(),
  durationMs: z.number().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  errorMessage: z.string().nullable(),
  summary: z.string().nullable(),
  createdAt: IsoDateSchema
}).passthrough();
export type ScheduledJobRun = z.infer<typeof ScheduledJobRunSchema>;

export const ScheduledJobRunsListResponseSchema = z.object({
  runs: z.array(ScheduledJobRunSchema)
}).passthrough();
export type ScheduledJobRunsListResponse = z.infer<typeof ScheduledJobRunsListResponseSchema>;

export const UserSettingsSectionEnvelopeSchema = z.object({
  section: UserSettingsSectionSchema
}).passthrough();
export type UserSettingsSectionEnvelope = z.infer<typeof UserSettingsSectionEnvelopeSchema>;

export const UserSettingsSectionsResponseSchema = z.object({
  sections: z.array(UserSettingsSectionSchema)
}).passthrough();
export type UserSettingsSectionsResponse = z.infer<typeof UserSettingsSectionsResponseSchema>;

// UI-only types — kept here for symmetry but not validated server-side.
export type NavigationItem = {
  id: string;
  label: string;
  tone: "live" | "planned";
  count?: number;
};

export type OverviewStat = {
  label: string;
  value: string;
  detail: string;
};
