/**
 * Single source of truth for classifying an artifact MIME type into one of a
 * small set of UI/filter buckets. Both the backend (the `GET /artifacts`
 * `mimeClass` filter) and the frontend (filter labels) MUST use this function
 * so the two can never drift. Do not hand-roll the mapping anywhere else.
 */

export const MIME_CLASSES = ["image", "pdf", "text", "code", "other"] as const;
export type MimeClass = (typeof MIME_CLASSES)[number];

// MIME types we treat as "code" (syntax-highlighted) rather than plain "text".
// Kept narrow and explicit; everything else under `text/*` falls to "text".
const CODE_MIME_TYPES = new Set([
  "application/json",
  "text/javascript",
  "text/x-python",
  "text/x-typescript",
  "application/x-sh",
  "text/html"
]);

export function classifyMimeClass(mimeType: string): MimeClass {
  const mime = mimeType.toLowerCase().trim();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (CODE_MIME_TYPES.has(mime)) return "code";
  if (mime.startsWith("text/")) return "text";
  return "other";
}
