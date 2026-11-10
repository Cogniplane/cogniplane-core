import type { Artifact } from "@cogniplane/shared-types";

const PREVIEWABLE_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/markdown",
  "text/x-python",
  "text/x-typescript",
  "application/json",
  "application/x-sh",
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function canPreviewArtifact(artifact: Pick<Artifact, "mimeType" | "status">): boolean {
  if (artifact.status !== "ready") return false;
  return PREVIEWABLE_MIME_TYPES.has(artifact.mimeType);
}

/** The largest text file that the preview downloads, in bytes. Images and PDF
 *  files do not use this limit. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

export const TEXT_PREVIEW_TOO_LARGE_MESSAGE =
  `This file is too large to preview. The preview limit is ${TEXT_PREVIEW_MAX_BYTES / (1024 * 1024)} MB. Download the file to see all of it.`;

/** The text preview refuses a file over the limit. It does not show the first
 *  part, because a cut JSON, HTML or CSV file can look complete. */
export class ArtifactPreviewTooLargeError extends Error {
  constructor() {
    super("Artifact content is larger than the text preview limit.");
    this.name = "ArtifactPreviewTooLargeError";
  }
}

/** True when the recorded size of a text artifact is over the preview limit.
 *  The download read also counts the bytes, because this size can be wrong. */
export function exceedsTextPreviewLimit(artifact: Pick<Artifact, "mimeType" | "fileSizeBytes">): boolean {
  if (isImageArtifact(artifact.mimeType) || isPdfArtifact(artifact.mimeType)) return false;
  return artifact.fileSizeBytes > TEXT_PREVIEW_MAX_BYTES;
}

// Maps previewable MIME types to their Monaco/highlight.js language identifiers.
// text/plain is intentionally omitted — callers fall back to the "plaintext" default via the ?? operator.
const MIME_TO_LANGUAGE: Record<string, string> = {
  "text/x-python": "python",
  "text/x-typescript": "typescript",
  "text/javascript": "javascript",
  "text/html": "html",
  "text/csv": "csv",
  "text/markdown": "markdown",
  "application/json": "json",
  "application/x-sh": "bash",
};

export function getPreviewLanguage(mimeType: string): string {
  return MIME_TO_LANGUAGE[mimeType] ?? "plaintext";
}

export function isImageArtifact(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export function isPdfArtifact(mimeType: string): boolean {
  return mimeType === "application/pdf";
}
