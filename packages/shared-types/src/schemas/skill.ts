import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

export const AdminSkillSchema = z.object({
  skillId: z.string(),
  skillName: z.string(),
  description: z.string().nullable(),
  instructions: z.string(),
  version: z.number(),
  contentHash: z.string(),
  enabled: z.boolean(),
  isPublished: z.boolean(),
  createdBy: z.string(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  activeRevisionId: z.number().nullable(),
  activeSourceType: z.string().nullable(),
  activeBundleName: z.string().nullable(),
  activeBundleStorageUri: z.string().nullable(),
  activeBundleHash: z.string().nullable(),
  activeValidationStatus: z.string().nullable(),
  activeReviewStatus: z.string().nullable(),
  isInherited: z.boolean(),
  // Per-skill adoption counts; both optional because older API responses
  // and offline activations table both produce missing values. UI defaults to 0.
  invokedSessions30d: z.number().optional(),
  materializedSessions30d: z.number().optional()
}).passthrough();
export type AdminSkill = z.infer<typeof AdminSkillSchema>;

export const AdminSkillsListResponseSchema = z.object({
  skills: z.array(AdminSkillSchema)
}).passthrough();
export type AdminSkillsListResponse = z.infer<typeof AdminSkillsListResponseSchema>;

export const AdminManagedToolSchema = z.object({
  id: z.string(),
  description: z.string(),
  readOnly: z.boolean()
}).passthrough();
export type AdminManagedTool = z.infer<typeof AdminManagedToolSchema>;

export const AdminManagedToolsListResponseSchema = z.object({
  tools: z.array(AdminManagedToolSchema)
}).passthrough();
export type AdminManagedToolsListResponse = z.infer<typeof AdminManagedToolsListResponseSchema>;

export const AdminSkillEnvelopeSchema = z.object({
  skill: AdminSkillSchema
}).passthrough();
export type AdminSkillEnvelope = z.infer<typeof AdminSkillEnvelopeSchema>;

export const SkillRevisionSchema = z.object({
  skillRevisionId: z.number(),
  skillId: z.string(),
  revisionNumber: z.number(),
  sourceType: z.string(),
  sourceLabel: z.string().nullable(),
  bundleName: z.string().nullable(),
  bundleStorageUri: z.string().nullable(),
  bundleHash: z.string(),
  validationStatus: z.string(),
  validationMessages: z.array(z.record(z.string(), z.unknown())),
  reviewStatus: z.string(),
  reviewNotes: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdBy: z.string(),
  createdAt: IsoDateSchema,
  reviewedBy: z.string().nullable(),
  reviewedAt: IsoDateSchema.nullable(),
  activatedAt: IsoDateSchema.nullable()
}).passthrough();
export type SkillRevision = z.infer<typeof SkillRevisionSchema>;

export const SkillMarketplaceEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  repositoryUrl: z.string(),
  ref: z.string(),
  subdirectory: z.string(),
  publisher: z.string().nullable(),
  reviewStatus: z.enum(["official", "reviewed", "community", "experimental"]),
  tags: z.array(z.string()),
  recommended: z.boolean(),
  skillVersion: z.string().nullable(),
  lastReviewedAt: z.string().nullable(),
  sourceUrl: z.string().nullable()
}).passthrough();
export type SkillMarketplaceEntry = z.infer<typeof SkillMarketplaceEntrySchema>;

const MarketplaceCommonSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  repositoryUrl: z.string().nullable(),
  skills: z.array(SkillMarketplaceEntrySchema)
});

export const SkillMarketplaceCatalogSchema = z.discriminatedUnion("status", [
  MarketplaceCommonSchema.extend({
    status: z.literal("disabled"),
    sourceUrl: z.string().nullable(),
    fetchedAt: IsoDateSchema.nullable(),
    error: z.string().nullable()
  }).passthrough(),
  MarketplaceCommonSchema.extend({
    status: z.literal("error"),
    sourceUrl: z.string(),
    fetchedAt: IsoDateSchema,
    error: z.string()
  }).passthrough(),
  MarketplaceCommonSchema.extend({
    status: z.literal("ready"),
    sourceUrl: z.string(),
    fetchedAt: IsoDateSchema,
    error: z.null()
  }).passthrough()
]);
export type SkillMarketplaceCatalog = z.infer<typeof SkillMarketplaceCatalogSchema>;

export const SkillMarketplaceResponseSchema = z.object({
  marketplace: SkillMarketplaceCatalogSchema
}).passthrough();
export type SkillMarketplaceResponse = z.infer<typeof SkillMarketplaceResponseSchema>;

export const SkillImprovementSessionSummarySchema = z.object({
  tenantId: z.string(),
  sessionId: z.string(),
  skillId: z.string(),
  corpusArtifactId: z.string().nullable(),
  sessionLimit: z.number(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  createdBy: z.string(),
  createdAt: IsoDateSchema
}).passthrough();
export type SkillImprovementSessionSummary = z.infer<typeof SkillImprovementSessionSummarySchema>;

export const LaunchSkillImprovementResponseSchema = z.object({
  sessionId: z.string(),
  artifactId: z.string().nullable(),
  includedSessionCount: z.number(),
  truncatedToolResultCount: z.number()
}).passthrough();
export type LaunchSkillImprovementResponse = z.infer<typeof LaunchSkillImprovementResponseSchema>;

// Skill import endpoints (zip / github / inline) all return the same shape:
// the upserted skill row plus the newly-created revision row.
export const SkillImportResponseSchema = z.object({
  skill: AdminSkillSchema,
  revision: SkillRevisionSchema
}).passthrough();
export type SkillImportResponse = z.infer<typeof SkillImportResponseSchema>;

export const SkillRevisionsListResponseSchema = z.object({
  revisions: z.array(SkillRevisionSchema)
}).passthrough();
export type SkillRevisionsListResponse = z.infer<typeof SkillRevisionsListResponseSchema>;

export const SkillRevisionFilePreviewSchema = z.object({
  path: z.string(),
  sizeBytes: z.number(),
  encoding: z.enum(["utf8", "base64"]),
  contentType: z.string(),
  content: z.string()
}).passthrough();
export type SkillRevisionFilePreview = z.infer<typeof SkillRevisionFilePreviewSchema>;

export const SkillRevisionFileResponseSchema = z.object({
  file: SkillRevisionFilePreviewSchema,
  limitBytes: z.number()
}).passthrough();
export type SkillRevisionFileResponse = z.infer<typeof SkillRevisionFileResponseSchema>;

export const SkillImprovementSessionsListResponseSchema = z.object({
  sessions: z.array(SkillImprovementSessionSummarySchema)
}).passthrough();
export type SkillImprovementSessionsListResponse = z.infer<typeof SkillImprovementSessionsListResponseSchema>;

// ── Skill judge admin ────────────────────────────────────────────────────────

export const SkillJudgeProviderIdSchema = z.enum(["anthropic", "openai"]);
export type SkillJudgeProviderId = z.infer<typeof SkillJudgeProviderIdSchema>;

export const SkillJudgeModeSchema = z.enum(["sync", "batch"]);
export type SkillJudgeMode = z.infer<typeof SkillJudgeModeSchema>;

export const SkillJudgeSettingsSchema = z.object({
  skillJudgeEnabled: z.boolean(),
  skillJudgeProvider: SkillJudgeProviderIdSchema.nullable(),
  skillJudgeModel: z.string().nullable(),
  skillJudgeMode: SkillJudgeModeSchema
}).passthrough();
export type SkillJudgeSettings = z.infer<typeof SkillJudgeSettingsSchema>;

export const SkillJudgeModelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: SkillJudgeProviderIdSchema,
  isDefault: z.boolean().optional(),
  hint: z.string().optional()
}).passthrough();
export type SkillJudgeModelOption = z.infer<typeof SkillJudgeModelOptionSchema>;

export const SkillJudgePlatformInfoSchema = z.object({
  workerEnabled: z.boolean(),
  pollIntervalMs: z.number(),
  inactiveBeforeMs: z.number(),
  maxSessionsPerTick: z.number()
}).passthrough();
export type SkillJudgePlatformInfo = z.infer<typeof SkillJudgePlatformInfoSchema>;

export const SkillJudgeStatsSchema = z.object({
  eligibleNow: z.number(),
  syncRunning: z.number(),
  batchPending: z.number(),
  oldestBatchSubmittedAt: z.string().nullable(),
  recentFailures: z.array(z.object({
    sessionId: z.string(),
    error: z.string().nullable(),
    completedAt: z.string().nullable()
  }).passthrough())
}).passthrough();
export type SkillJudgeStats = z.infer<typeof SkillJudgeStatsSchema>;

export const SkillJudgeResponseSchema = z.object({
  settings: SkillJudgeSettingsSchema,
  availableModels: z.array(SkillJudgeModelOptionSchema),
  platform: SkillJudgePlatformInfoSchema,
  stats: SkillJudgeStatsSchema
}).passthrough();
export type SkillJudgeResponse = z.infer<typeof SkillJudgeResponseSchema>;

export const SkillJudgeSettingsEnvelopeSchema = z.object({
  settings: SkillJudgeSettingsSchema
}).passthrough();
export type SkillJudgeSettingsEnvelope = z.infer<typeof SkillJudgeSettingsEnvelopeSchema>;
