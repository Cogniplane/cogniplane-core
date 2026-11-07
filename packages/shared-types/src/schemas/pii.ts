import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

export const PII_MODES = ["off", "detect", "block", "transform"] as const;
export const PiiModeSchema = z.enum(PII_MODES);
export type PiiMode = z.infer<typeof PiiModeSchema>;

export const PII_RAW_RETENTION = ["never", "admin_only", "reversible_encrypted"] as const;
export const PiiRawRetentionSchema = z.enum(PII_RAW_RETENTION);
export type PiiRawRetention = z.infer<typeof PiiRawRetentionSchema>;

export const PII_PROVIDER_TYPES = ["openai-compatible"] as const;
export const PiiProviderTypeSchema = z.enum(PII_PROVIDER_TYPES);
export type PiiProviderType = z.infer<typeof PiiProviderTypeSchema>;

// The detection model name that a save accepts. The server reads a stored
// name with the same schema, so both use one limit.
export const PII_PROVIDER_MODEL_MAX_LENGTH = 256;
export const PiiProviderModelSchema = z.string().trim().max(PII_PROVIDER_MODEL_MAX_LENGTH);

export const PII_ENTITY_TYPES = [
  "email",
  "phone",
  "person_name",
  "address",
  "financial",
  "government_id"
] as const;
export const PiiEntityTypeSchema = z.enum(PII_ENTITY_TYPES);
export type PiiEntityType = z.infer<typeof PiiEntityTypeSchema>;

// Core scan scopes. An import source that an overlay adds registers its own
// scope key on the backend; the stored policy keeps that key next to these two.
export const PII_CORE_SCOPE_KEYS = ["chatPrompts", "uploads"] as const;
export type PiiCoreScopeKey = (typeof PII_CORE_SCOPE_KEYS)[number];

// Every other key is a registered import scope, and its value is a boolean.
export const PiiScopesSchema = z.object({
  chatPrompts: z.boolean(),
  uploads: z.boolean()
}).catchall(z.boolean());
export type PiiScopes = z.infer<typeof PiiScopesSchema>;

const PiiProtectionSettingsBaseSchema = z.object({
  enabled: z.boolean(),
  mode: PiiModeSchema,
  rawRetention: PiiRawRetentionSchema,
  provider: z.object({
    type: PiiProviderTypeSchema,
    model: z.string().trim()
  }).passthrough(),
  scopes: PiiScopesSchema,
  actions: z.object({
    reportToAdmins: z.boolean()
  }).passthrough(),
  detectors: z.object({
    useRulesFirst: z.boolean(),
    entityTypes: z.array(PiiEntityTypeSchema)
  }).passthrough()
});

export const PiiProtectionSettingsSchema = PiiProtectionSettingsBaseSchema.passthrough();
export type PiiProtectionSettings = z.infer<typeof PiiProtectionSettingsSchema>;

/**
 * Strict request schema. It accepts the core scopes and the given import scope
 * keys, and rejects every other key. An import scope key is optional: when a
 * request leaves it out, the server keeps the stored value.
 *
 * `expectedRevision` is the PII settings revision that the save is based on
 * (`settings.piiProtectionRevision` in GET /tenant). It is not part of the
 * stored policy. When the stored revision is different, the server refuses the
 * save with 409 `pii_settings_conflict`. It is optional for compatibility:
 * older clients send no revision, and their save replaces the settings with no
 * check.
 */
export function buildPiiProtectionSettingsRequestSchema(importScopeKeys: readonly string[] = []) {
  const scopeShape: Record<string, z.ZodBoolean | z.ZodOptional<z.ZodBoolean>> = {
    chatPrompts: z.boolean(),
    uploads: z.boolean()
  };
  for (const key of importScopeKeys) {
    if (!(PII_CORE_SCOPE_KEYS as readonly string[]).includes(key)) scopeShape[key] = z.boolean().optional();
  }
  // The keys are known only at run time, so the static type is the shared
  // scope shape: two core booleans and optional import booleans.
  const scopes = z.object(scopeShape).strict() as unknown as z.ZodType<PiiScopes>;
  return PiiProtectionSettingsBaseSchema.extend({
    provider: z.object({
      type: PiiProviderTypeSchema,
      model: PiiProviderModelSchema
    }).strict(),
    scopes,
    actions: z.object({
      reportToAdmins: z.boolean()
    }).strict(),
    detectors: z.object({
      useRulesFirst: z.boolean(),
      entityTypes: z.array(PiiEntityTypeSchema).max(PII_ENTITY_TYPES.length)
    }).strict(),
    expectedRevision: z.number().int().nonnegative().optional()
  }).strict();
}

// Core scopes only. The backend adds the registered import scope keys.
export const PiiProtectionSettingsRequestSchema = buildPiiProtectionSettingsRequestSchema();
export type PiiProtectionSettingsRequest = z.infer<typeof PiiProtectionSettingsRequestSchema>;

// A registered import scope that has no stored value uses its own default.
export const DEFAULT_PII_PROTECTION: PiiProtectionSettings = {
  enabled: false,
  mode: "off",
  rawRetention: "never",
  provider: { type: "openai-compatible", model: "" },
  scopes: { chatPrompts: true, uploads: true },
  actions: { reportToAdmins: true },
  detectors: { useRulesFirst: true, entityTypes: [...PII_ENTITY_TYPES] }
};

// ── Stored policy health ─────────────────────────────────────────────────────
//
// What the server did with a stored policy that does not match the schema. It
// is not part of the policy, so a save never writes it. Reason codes and field
// paths are stable; they never contain stored values.
// - ok: the stored policy is valid.
// - warning: safe values replace some fields, or protection is off because
//   the stored on/off choice is off but another field is invalid.
// - error: the on/off choice cannot be trusted. Content in scope is stopped,
//   before any provider call, until an admin saves a valid policy.

export const PII_POLICY_HEALTH_REASONS = [
  "policy_not_object",
  "enabled_invalid",
  "mode_invalid",
  "mode_off_while_enabled",
  "scope_invalid",
  "raw_retention_invalid",
  "actions_invalid",
  "detectors_invalid",
  "entity_types_invalid",
  "entity_types_unsupported",
  "provider_invalid"
] as const;
export const PiiPolicyHealthReasonSchema = z.enum(PII_POLICY_HEALTH_REASONS);
export type PiiPolicyHealthReason = z.infer<typeof PiiPolicyHealthReasonSchema>;

export const PiiPolicyHealthSchema = z.object({
  state: z.enum(["ok", "warning", "error"]),
  // Unknown codes from a newer server are kept as strings.
  reasons: z.array(z.string()),
  fields: z.array(z.string())
}).passthrough();
export type PiiPolicyHealth = z.infer<typeof PiiPolicyHealthSchema>;

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
    scopes: PiiScopesSchema,
    entityTypes: z.array(PiiEntityTypeSchema)
  }).passthrough(),
  // Optional: a server older than this field does not send it.
  policyHealth: PiiPolicyHealthSchema.optional(),
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
  subjectType: z.enum(["message", "artifact", "project_instructions"]),
  subjectId: z.string(),
  instructionsRevision: z.number().int().nonnegative().nullable().optional(),
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
  subjectType: z.enum(["message", "artifact", "project_instructions"]),
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
