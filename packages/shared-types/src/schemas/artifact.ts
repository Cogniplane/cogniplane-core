import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

export const ArtifactPiiDetailSchema = z.object({
  status: z.enum(["pending", "scanning", "scanned", "blocked", "transformed", "failed"]).optional(),
  modeApplied: z.enum(["off", "detect", "block", "transform"]).optional(),
  scanRunId: z.string().optional(),
  summaryText: z.string().optional(),
  findingsCount: z.number().optional(),
  blockReason: z.string().optional()
}).passthrough();
export type ArtifactPiiDetail = z.infer<typeof ArtifactPiiDetailSchema>;

// `detail` is a JSONB bag with one well-known optional `pii` field; everything
// else is intentionally untyped because individual handlers stash whatever
// they need (mime hints, processor diagnostics, etc.).
const ArtifactDetailSchema = z.record(z.string(), z.unknown()).and(
  z.object({ pii: ArtifactPiiDetailSchema.optional() }).passthrough()
);

export const ArtifactSchema = z.object({
  artifactId: z.string(),
  sessionId: z.string(),
  userId: z.string(),
  artifactType: z.enum(["upload", "derived", "generated"]),
  sourceArtifactId: z.string().nullable(),
  artifactName: z.string(),
  mimeType: z.string(),
  storageBackend: z.enum(["local", "bucket"]),
  storageKey: z.string(),
  fileSizeBytes: z.number(),
  checksumSha256: z.string(),
  status: z.enum(["pending", "processing", "ready", "failed", "deleted"]),
  createdByType: z.enum(["user", "tool", "job", "system"]),
  createdByRef: z.string().nullable(),
  detail: ArtifactDetailSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
}).passthrough();
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactEnvelopeSchema = z.object({
  artifact: ArtifactSchema
}).passthrough();
export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelopeSchema>;

export const DownloadHandleSchema = z.object({
  token: z.string(),
  url: z.string(),
  expiresAt: IsoDateSchema
}).passthrough();
export type DownloadHandle = z.infer<typeof DownloadHandleSchema>;

export const DownloadHandleEnvelopeSchema = z.object({
  download: DownloadHandleSchema
}).passthrough();
export type DownloadHandleEnvelope = z.infer<typeof DownloadHandleEnvelopeSchema>;

export const ArtifactsListResponseSchema = z.object({
  artifacts: z.array(ArtifactSchema)
}).passthrough();
export type ArtifactsListResponse = z.infer<typeof ArtifactsListResponseSchema>;

export const ArtifactPreviewTextResponseSchema = z.object({
  text: z.string()
}).passthrough();
export type ArtifactPreviewTextResponse = z.infer<typeof ArtifactPreviewTextResponseSchema>;
