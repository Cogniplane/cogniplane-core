import { z } from "zod";

import { MODEL_PROVIDERS } from "../primitives.js";
import { IsoDateSchema } from "./_helpers.js";

export const RuntimeSessionConfigSummarySchema = z.object({
  manifestHash: z.string(),
  configBundleHash: z.string(),
  runtimePolicy: z.object({
    id: z.string(),
    version: z.number(),
    hash: z.string()
  }).passthrough(),
  skillVersions: z.array(z.object({
    id: z.string(),
    version: z.number(),
    hash: z.string()
  }).passthrough()),
  mcpServerVersions: z.array(z.object({
    id: z.string(),
    version: z.number(),
    hash: z.string()
  }).passthrough())
}).passthrough();
export type RuntimeSessionConfigSummary = z.infer<typeof RuntimeSessionConfigSummarySchema>;

export const RuntimeSessionSummarySchema = z.object({
  sessionId: z.string(),
  runtimeId: z.string(),
  status: z.string(),
  healthStatus: z.string(),
  startedAt: IsoDateSchema.nullable(),
  lastActiveAt: IsoDateSchema.nullable(),
  updatedAt: IsoDateSchema,
  configSummary: RuntimeSessionConfigSummarySchema,
  runtimeProvider: z.literal("deep-agents").nullable()
}).passthrough();
export type RuntimeSessionSummary = z.infer<typeof RuntimeSessionSummarySchema>;

export const RuntimeSessionsListResponseSchema = z.object({
  runtimeSessions: z.array(RuntimeSessionSummarySchema)
}).passthrough();
export type RuntimeSessionsListResponse = z.infer<typeof RuntimeSessionsListResponseSchema>;

export const RuntimeRolloutActionSchema = z.enum(["drain_idle", "refresh_idle"]);
export type RuntimeRolloutAction = z.infer<typeof RuntimeRolloutActionSchema>;

export const RuntimeRolloutResponseSchema = z.object({
  action: RuntimeRolloutActionSchema,
  affectedSessionIds: z.array(z.string())
}).passthrough();
export type RuntimeRolloutResponse = z.infer<typeof RuntimeRolloutResponseSchema>;

export const AdminRuntimeConfigSchema = z.object({
  e2bTemplateId: z.string(),
  // Retained for backward compatibility; prefer `platformProviders`, which
  // reports the full per-provider platform-key map (an OpenAI/Google/Z.AI-only
  // deployment reads "missing" on the Anthropic flag alone while working fine).
  anthropicKeyConfigured: z.boolean(),
  /** Providers with a platform-level env key configured (tenant-independent). */
  platformProviders: z.array(z.enum(MODEL_PROVIDERS))
}).passthrough();
export type AdminRuntimeConfig = z.infer<typeof AdminRuntimeConfigSchema>;

// Live in-memory session-runtime detail (tenant-scoped). The unauthenticated
// /health endpoint exposes only aggregate counts; this is the admin view.
export const AdminRuntimeHealthResponseSchema = z.object({
  runtimes: z.array(
    z.object({
      sessionId: z.string(),
      runtimeId: z.string(),
      healthStatus: z.enum(["starting", "healthy", "terminating", "terminated", "error"]),
      lastActiveAt: z.string(),
      hasActiveTurn: z.boolean()
    }).passthrough()
  )
}).passthrough();
export type AdminRuntimeHealthResponse = z.infer<typeof AdminRuntimeHealthResponseSchema>;

