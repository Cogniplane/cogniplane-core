import { z } from "zod";

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
  runtimeProvider: z.string().nullable(),
  // Claude adapter execution mode — "local" or "e2b". null for Codex or older rows.
  mode: z.enum(["local", "e2b"]).nullable()
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
  codexBackend: z.enum(["local", "e2b"]),
  claudeBackend: z.enum(["local", "e2b"]),
  e2bTemplateId: z.string(),
  codexModel: z.string(),
  claudeModel: z.string(),
  anthropicKeyConfigured: z.boolean(),
  openaiKeyConfigured: z.boolean()
}).passthrough();
export type AdminRuntimeConfig = z.infer<typeof AdminRuntimeConfigSchema>;

// ── Codex/OpenAI runtime diagnostic (admin debug page) ──────────────────────

const ProbeOkSchema = z.object({
  ok: z.literal(true),
  status: z.number(),
  statusText: z.string()
}).passthrough();
const ProbeErrSchema = z.object({
  ok: z.literal(false),
  error: z.string()
}).passthrough();
const ProbeSkippedSchema = z.object({ skipped: z.literal(true) }).passthrough();

const StreamingProbeOkSchema = z.object({
  ok: z.literal(true),
  status: z.number(),
  statusText: z.string(),
  stream: z.boolean(),
  firstChunkBytes: z.number().nullable(),
  completedStream: z.boolean().nullable(),
  totalChunkBytes: z.number().nullable()
}).passthrough();
const StreamingProbeErrSchema = z.object({
  ok: z.literal(false),
  stream: z.boolean(),
  error: z.string()
}).passthrough();

export const RuntimeOpenAiDiagnosticSchema = z.object({
  checkedAt: IsoDateSchema,
  home: z.string(),
  codexAuth: z.object({
    openAiApiKeyPresent: z.boolean(),
    authFilePresent: z.boolean(),
    configFilePresent: z.boolean()
  }).passthrough(),
  dns: z.union([
    z.object({
      ok: z.literal(true),
      addresses: z.array(z.object({
        address: z.string(),
        family: z.number()
      }).passthrough())
    }).passthrough(),
    z.object({ ok: z.literal(false), error: z.string() }).passthrough()
  ]),
  probes: z.object({
    unauthenticated: z.union([ProbeSkippedSchema, ProbeOkSchema, ProbeErrSchema]),
    authenticated: z.union([ProbeSkippedSchema, ProbeOkSchema, ProbeErrSchema]),
    responsesNonStreaming: z.union([ProbeSkippedSchema, StreamingProbeOkSchema, StreamingProbeErrSchema]).optional(),
    responsesStreaming: z.union([ProbeSkippedSchema, StreamingProbeOkSchema, StreamingProbeErrSchema]).optional()
  }).passthrough()
}).passthrough();
export type RuntimeOpenAiDiagnostic = z.infer<typeof RuntimeOpenAiDiagnosticSchema>;
