import type { ArtifactStorage } from "./artifact-storage.js";

/**
 * Read text content from a Node.js readable stream, up to `maxChars` characters.
 */
export async function readStreamAsText(
  stream: NodeJS.ReadableStream,
  maxChars: number
): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    const piece = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : Buffer.from(chunk).toString("utf8");
    const remaining = maxChars - text.length;
    if (remaining <= 0) {
      break;
    }
    text += piece.slice(0, remaining);
  }

  return text;
}

/**
 * Check whether an artifact's MIME type indicates text-readable content.
 */
export function isTextReadableArtifact(mimeType: string): boolean {
  return mimeType.startsWith("text/") || mimeType === "application/json";
}

/**
 * Open a stored artifact and read a text excerpt up to `maxChars` characters.
 */
export async function readArtifactExcerpt(
  storage: ArtifactStorage,
  storageKey: string,
  maxChars: number
): Promise<string> {
  const handle = await storage.openReadStream(storageKey);
  return readStreamAsText(handle.stream, maxChars);
}
