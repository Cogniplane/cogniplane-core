import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

export const PiiModeSchema = z.enum(["off", "detect", "block", "transform"]);
export type PiiMode = z.infer<typeof PiiModeSchema>;

export const PiiRawRetentionSchema = z.enum(["never", "admin_only", "reversible_encrypted"]);
export type PiiRawRetention = z.infer<typeof PiiRawRetentionSchema>;

export const PiiProviderTypeSchema = z.enum(["openai-compatible"]);
export type PiiProviderType = z.infer<typeof PiiProviderTypeSchema>;

export const PiiEntityTypeSchema = z.enum([
  "email",
  "phone",
  "person_name",
  "address",
  "financial",
  "government_id"
]);
export type PiiEntityType = z.infer<typeof PiiEntityTypeSchema>;

export const PiiProtectionSettingsSchema = z.object({
  enabled: z.boolean(),
  mode: PiiModeSchema,
  rawRetention: PiiRawRetentionSchema,
  provider: z.object({
    type: PiiProviderTypeSchema,
    model: z.string()
  }).passthrough(),
  scopes: z.object({
    chatPrompts: z.boolean(),
    uploads: z.boolean(),
    microsoftImports: z.boolean()
  }).passthrough(),
  actions: z.object({
    reportToAdmins: z.boolean()
  }).passthrough(),
  detectors: z.object({
    useRulesFirst: z.boolean(),
    entityTypes: z.array(PiiEntityTypeSchema)
  }).passthrough()
}).passthrough();
export type PiiProtectionSettings = z.infer<typeof PiiProtectionSettingsSchema>;

// ── Provider circuit-breaker status ───────────────────────────────────────────

export const PiiBreakerStateSchema = z.enum(["closed", "open", "half_open"]);
export type PiiBreakerState = z.infer<typeof PiiBreakerStateSchema>;

export const PiiProviderStatusSchema = z.object({
  provider: z.literal("pii-llm"),
  state: PiiBreakerStateSchema,
  failureCount: z.number(),
  // Wall-clock millis. null when state === "closed" / "half_open".
  openedAt: z.number().nullable(),
  willRetryAt: z.number().nullable()
}).passthrough();
export type PiiProviderStatus = z.infer<typeof PiiProviderStatusSchema>;

// ── PII admin dashboard ──────────────────────────────────────────────────────

export const PiiRangePresetSchema = z.enum(["24h", "7d", "30d", "custom"]);
export type PiiRangePreset = z.infer<typeof PiiRangePresetSchema>;

export const PiiBucketGranularitySchema = z.enum(["hour", "day"]);
export type PiiBucketGranularity = z.infer<typeof PiiBucketGranularitySchema>;

export const PiiActivityKpiSchema = z.object({
  current: z.number(),
  previous: z.number()
}).passthrough();
export type PiiActivityKpi = z.infer<typeof PiiActivityKpiSchema>;

export const PiiActivityTimeSeriesPointSchema = z.object({
  bucket: z.string(),
  allow: z.number(),
  report: z.number(),
  block: z.number(),
  transform: z.number(),
  failed: z.number()
}).passthrough();
export type PiiActivityTimeSeriesPoint = z.infer<typeof PiiActivityTimeSeriesPointSchema>;

export const PiiActivityMetricsSchema = z.object({
  range: z.object({
    preset: PiiRangePresetSchema,
    from: z.string(),
    to: z.string(),
    bucket: PiiBucketGranularitySchema
  }).passthrough(),
  policy: z.object({
    enabled: z.boolean(),
    mode: PiiModeSchema,
    rawRetention: PiiRawRetentionSchema,
    scopes: z.object({
      chatPrompts: z.boolean(),
      uploads: z.boolean(),
      microsoftImports: z.boolean()
    }).passthrough(),
    entityTypes: z.array(PiiEntityTypeSchema)
  }).passthrough(),
  kpis: z.object({
    scans: PiiActivityKpiSchema,
    findings: PiiActivityKpiSchema,
    blocked: PiiActivityKpiSchema,
    transformed: PiiActivityKpiSchema,
    failed: PiiActivityKpiSchema
  }).passthrough(),
  timeSeries: z.array(PiiActivityTimeSeriesPointSchema),
  byEntityType: z.array(z.object({
    entityType: z.string(),
    count: z.number()
  }).passthrough()),
  byConfidence: z.array(z.object({
    entityType: z.string(),
    high: z.number(),
    medium: z.number(),
    low: z.number()
  }).passthrough()),
  bySubjectType: z.array(z.object({
    subjectType: z.string(),
    count: z.number()
  }).passthrough())
}).passthrough();
export type PiiActivityMetrics = z.infer<typeof PiiActivityMetricsSchema>;

export const PiiTopGroupBySchema = z.enum(["user", "session"]);
export type PiiTopGroupBy = z.infer<typeof PiiTopGroupBySchema>;

export const PiiTopUserRowSchema = z.object({
  userId: z.string(),
  findingsTotal: z.number(),
  sessionsCount: z.number(),
  blockCount: z.number(),
  transformCount: z.number(),
  failedCount: z.number(),
  lastSeenAt: IsoDateSchema.nullable()
}).passthrough();
export type PiiTopUserRow = z.infer<typeof PiiTopUserRowSchema>;

export const PiiTopSessionRowSchema = z.object({
  sessionId: z.string(),
  userId: z.string().nullable(),
  findingsTotal: z.number(),
  actionMix: z.object({
    allow: z.number(),
    report: z.number(),
    block: z.number(),
    transform: z.number(),
    failed: z.number()
  }).passthrough(),
  lastActivityAt: IsoDateSchema.nullable()
}).passthrough();
export type PiiTopSessionRow = z.infer<typeof PiiTopSessionRowSchema>;

export const PiiTopResponseSchema = z.discriminatedUnion("groupBy", [
  z.object({
    range: z.object({
      preset: PiiRangePresetSchema,
      from: z.string(),
      to: z.string()
    }).passthrough(),
    groupBy: z.literal("user"),
    rows: z.array(PiiTopUserRowSchema)
  }).passthrough(),
  z.object({
    range: z.object({
      preset: PiiRangePresetSchema,
      from: z.string(),
      to: z.string()
    }).passthrough(),
    groupBy: z.literal("session"),
    rows: z.array(PiiTopSessionRowSchema)
  }).passthrough()
]);
export type PiiTopResponse = z.infer<typeof PiiTopResponseSchema>;

export const PiiRecentActionTokenSchema = z.enum([
  "allow",
  "report",
  "block",
  "transform",
  "failed"
]);
export type PiiRecentActionToken = z.infer<typeof PiiRecentActionTokenSchema>;

export const PiiRecentRowSchema = z.object({
  scanRunId: z.string(),
  createdAt: IsoDateSchema,
  completedAt: IsoDateSchema.nullable(),
  subjectType: z.enum(["message", "artifact"]),
  subjectId: z.string(),
  sessionId: z.string().nullable(),
  userId: z.string().nullable(),
  mode: z.string(),
  actionTaken: z.string().nullable(),
  status: z.string(),
  providerType: z.string().nullable(),
  providerModel: z.string().nullable(),
  findingsCount: z.number(),
  errorMessage: z.string().nullable(),
  entityTypes: z.array(z.string())
}).passthrough();
export type PiiRecentRow = z.infer<typeof PiiRecentRowSchema>;

export const PiiRecentResponseSchema = z.object({
  range: z.object({
    preset: PiiRangePresetSchema,
    from: z.string(),
    to: z.string()
  }).passthrough(),
  actions: z.array(PiiRecentActionTokenSchema),
  rows: z.array(PiiRecentRowSchema)
}).passthrough();
export type PiiRecentResponse = z.infer<typeof PiiRecentResponseSchema>;

export const PiiQueueStatsSchema = z.object({
  queued: z.number(),
  claimed: z.number(),
  completed: z.number(),
  failed: z.number(),
  oldestQueuedAt: IsoDateSchema.nullable(),
  maxAttemptsHit: z.number()
}).passthrough();
export type PiiQueueStats = z.infer<typeof PiiQueueStatsSchema>;

export const PiiLatencyRowSchema = z.object({
  subjectType: z.enum(["message", "artifact"]),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  p99Ms: z.number().nullable(),
  sampleCount: z.number()
}).passthrough();
export type PiiLatencyRow = z.infer<typeof PiiLatencyRowSchema>;

export const PiiBreakerTransitionEventSchema = z.object({
  at: z.string(),
  provider: z.string(),
  from: z.string(),
  to: z.string(),
  failureCount: z.number()
}).passthrough();
export type PiiBreakerTransitionEvent = z.infer<typeof PiiBreakerTransitionEventSchema>;

export const PiiJobsStatsResponseSchema = z.object({
  range: z.object({
    preset: PiiRangePresetSchema,
    from: z.string(),
    to: z.string()
  }).passthrough(),
  queue: PiiQueueStatsSchema,
  latency: z.array(PiiLatencyRowSchema),
  topErrors: z.array(z.object({
    message: z.string(),
    count: z.number()
  }).passthrough()),
  breakerTimeline: z.array(PiiBreakerTransitionEventSchema)
}).passthrough();
export type PiiJobsStatsResponse = z.infer<typeof PiiJobsStatsResponseSchema>;
