import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";
import { MIME_CLASSES } from "../mime-class.js";

export const ArtifactPiiDetailSchema = z.object({
  status: z.enum(["pending", "scanning", "scanned", "blocked", "transformed", "failed"]).optional(),
  /**
   * Before a terminal success, or on failure, the value is the planned
   * (queued) mode. After a terminal success, it is the mode that the scan
   * applied.
   */
  modeApplied: z.enum(["off", "detect", "block", "transform"]).optional(),
  /** The PII settings revision that the scan read. Queued, synchronous upload, and chat prompt scans set it. */
  policyRevision: z.number().int().nonnegative().optional(),
  scanRunId: z.string().optional(),
  summaryText: z.string().optional(),
  findingsCount: z.number().optional(),
  blockReason: z.string().optional(),
  /**
   * The scan did not read all of the file's page images (a PDF): OCR was
   * off, stopped at a limit, or failed. Absent when OCR read every page.
   */
  imagesNotScanned: z.boolean().optional(),
  /**
   * Set when OCR ran on a PDF. `complete`: every page was read. `partial`:
   * OCR stopped at a page, size, or time limit. `failed`: OCR did not run
   * to the end. Only `complete` covers the page images.
   */
  imageScan: z.enum(["complete", "partial", "failed"]).optional(),
  /** Pages that OCR read. Set with `imageScan`. */
  imagePagesScanned: z.number().int().nonnegative().optional(),
  /** Pages in the PDF. Absent when OCR could not read the page count. */
  imagePageCount: z.number().int().positive().optional()
}).passthrough();
export type ArtifactPiiDetail = z.infer<typeof ArtifactPiiDetailSchema>;

/**
 * The PII verdicts that let an artifact's bytes leave the store. It is an
 * allow-list: a failed scan, and any value that is not in the list, keep the
 * bytes in. PII checks fail closed (docs/decisions.md, D16). The backend
 * builds its SQL check from this list too.
 */
export const ARTIFACT_PII_ELIGIBLE_STATUSES = ["scanned", "transformed"] as const satisfies readonly NonNullable<
  ArtifactPiiDetail["status"]
>[];

/**
 * True when this PII verdict lets the bytes leave the store. No verdict (no
 * scan applied) is eligible. JSON null is no verdict, as SQL `->>` reads it.
 */
export function isArtifactPiiVerdictEligible(piiStatus: unknown): boolean {
  return piiStatus === undefined || piiStatus === null ||
    (ARTIFACT_PII_ELIGIBLE_STATUSES as readonly unknown[]).includes(piiStatus);
}

/**
 * The one rule for chat context, runtime workspaces, previews, downloads and
 * project library imports: the artifact is `ready` and its PII verdict is
 * eligible. The verdict is read from `detail.pii` on its own, never inferred
 * from `status`: a block on a record that is already `ready` leaves `status`
 * unchanged and must still deny. The frontend uses it to show what the backend
 * accepts; the backend is the boundary.
 */
export function isArtifactPiiEligible(artifact: { status: string; detail?: { pii?: unknown } | null }): boolean {
  if (artifact.status !== "ready") return false;
  const pii = artifact.detail?.pii;
  const piiStatus: unknown = pii && typeof pii === "object" ? (pii as { status?: unknown }).status : undefined;
  return isArtifactPiiVerdictEligible(piiStatus);
}

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

export const ArtifactSortSchema = z.enum([
  "created_desc",
  "created_asc",
  "name_asc",
  "name_desc",
  "size_desc",
  "size_asc"
]);
export type ArtifactSort = z.infer<typeof ArtifactSortSchema>;

// Browser-facing artifact types. The schema excludes `derived` by design,
// because it holds internal derivatives that users do not see.
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
