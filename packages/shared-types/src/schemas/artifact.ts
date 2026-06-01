import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";
import { MIME_CLASSES } from "../mime-class.js";

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

// ── Cross-session artifact browser (GET /artifacts) ──────────────────────────

export const ArtifactSortSchema = z.enum([
  "created_desc",
  "created_asc",
  "name_asc",
  "name_desc",
  "size_desc",
  "size_asc"
]);
export type ArtifactSort = z.infer<typeof ArtifactSortSchema>;

// Browser-facing artifact types: `derived` is excluded by design (internal,
// non-user-facing derivatives — see the browser plan / route).
export const ArtifactBrowseTypeSchema = z.enum(["upload", "generated"]);
export type ArtifactBrowseType = z.infer<typeof ArtifactBrowseTypeSchema>;

export const ArtifactBrowseStatusSchema = z.enum([
  "pending",
  "processing",
  "ready",
  "failed"
]);
export type ArtifactBrowseStatus = z.infer<typeof ArtifactBrowseStatusSchema>;

// Repeated query params (`?type=upload&type=generated`) may arrive as a single
// string or an array; normalize both to an array. An absent param → undefined
// (matches anything). Empty values are dropped.
function multiEnum<T extends z.ZodTypeAny>(schema: T) {
  return z
    .union([schema, z.array(schema)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));
}

export const ArtifactListQuerySchema = z.object({
  q: z.string().trim().min(1).max(255).optional(),
  type: multiEnum(ArtifactBrowseTypeSchema),
  status: multiEnum(ArtifactBrowseStatusSchema),
  mimeClass: multiEnum(z.enum(MIME_CLASSES)),
  sort: ArtifactSortSchema.default("created_desc"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional()
});
export type ArtifactListQuery = z.infer<typeof ArtifactListQuerySchema>;

export const ArtifactBrowseResponseSchema = z.object({
  items: z.array(ArtifactSchema),
  nextCursor: z.string().nullable()
}).passthrough();
export type ArtifactBrowseResponse = z.infer<typeof ArtifactBrowseResponseSchema>;
