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
