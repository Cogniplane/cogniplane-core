import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

import { EFFORT_LEVELS, MODEL_PROVIDERS } from "../primitives.js";

// The public LLM provider behind a model id. See MODEL_PROVIDER_META for how
// each maps to a LangChain initChatModel prefix / base URL.
const ModelProviderSchema = z.enum(MODEL_PROVIDERS);
const EffortLevelSchema = z.enum(EFFORT_LEVELS);

export const ModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  provider: ModelProviderSchema,
  supportedEfforts: z.array(EffortLevelSchema),
  defaultEffort: EffortLevelSchema.nullable(),
  // Max input context in tokens, used by the composer's context-window meter.
  contextWindow: z.number().int().positive(),
  // "custom" = admin-added (tenant_custom_models); absent/"builtin" = the
  // static platform catalog. Only the admin surfaces care about this.
  source: z.enum(["builtin", "custom"]).optional()
}).passthrough();
export type Model = z.infer<typeof ModelSchema>;

export const ModelsListResponseSchema = z.object({
  models: z.array(ModelSchema),
  showEffortSelector: z.boolean()
}).passthrough();
export type ModelsListResponse = z.infer<typeof ModelsListResponseSchema>;

// GET /admin/models — the FULL model catalog (unfiltered by key presence or
// tenant availability settings) plus per-provider key-source visibility, so
// the admin UI can show exactly why a provider's models are or aren't
// selectable instead of leaving admins to infer it from key presence.
export const AdminProviderStatusSchema = z.object({
  id: ModelProviderSchema,
  label: z.string(),
  // Where the effective key for this provider comes from: a tenant-stored key
  // ("tenant"), the platform env fallback ("platform"), or nowhere ("none").
  keySource: z.enum(["tenant", "platform", "none"])
}).passthrough();
export type AdminProviderStatus = z.infer<typeof AdminProviderStatusSchema>;

export const AdminModelCatalogResponseSchema = z.object({
  models: z.array(ModelSchema),
  providers: z.array(AdminProviderStatusSchema)
}).passthrough();
export type AdminModelCatalogResponse = z.infer<typeof AdminModelCatalogResponseSchema>;

// ── Admin-managed custom models ──────────────────────────────────────────────
//
// POST /admin/custom-models. For provider "openrouter" the backend validates
// the slug against OpenRouter's public models API and auto-fills any omitted
// displayName/description/contextWindow; for other providers displayName and
// contextWindow are required (there is no key-free lookup to fill them).
export const CustomModelCreateRequestSchema = z.object({
  provider: ModelProviderSchema,
  // The bare vendor model id ("moonshotai/kimi-k3", "gpt-6-preview"). The
  // backend derives the catalog id as "<provider>/<vendorModelId>".
  vendorModelId: z.string().trim().min(1).max(150),
  displayName: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  contextWindow: z.number().int().min(1_000).max(100_000_000).optional()
});
export type CustomModelCreateRequest = z.infer<typeof CustomModelCreateRequestSchema>;

export const CustomModelEnvelopeSchema = z.object({
  model: ModelSchema
}).passthrough();
export type CustomModelEnvelope = z.infer<typeof CustomModelEnvelopeSchema>;

// GET /admin/openrouter-models — slim, server-proxied slice of OpenRouter's
// public catalog for the admin "add model" picker.
export const OpenRouterModelOptionSchema = z.object({
  // OpenRouter slug ("moonshotai/kimi-k3"), i.e. the vendorModelId to submit.
  id: z.string(),
  name: z.string(),
  contextLength: z.number().int().positive().nullable()
}).passthrough();
export type OpenRouterModelOption = z.infer<typeof OpenRouterModelOptionSchema>;

export const OpenRouterModelsResponseSchema = z.object({
  models: z.array(OpenRouterModelOptionSchema)
}).passthrough();
export type OpenRouterModelsResponse = z.infer<typeof OpenRouterModelsResponseSchema>;

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
  count?: number;
};

export type OverviewStat = {
  label: string;
  value: string;
  detail: string;
};
