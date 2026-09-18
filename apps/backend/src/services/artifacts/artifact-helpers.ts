import { StringDecoder } from "node:string_decoder";
import { isTextReadableArtifact as isSharedTextReadableArtifact } from "@cogniplane/shared-types";
import type { ArtifactStorage } from "./artifact-storage.js";

/**
 * Read text content from a Node.js readable stream, up to `maxChars` characters.
 */
export async function readStreamAsText(
  stream: NodeJS.ReadableStream,
  maxChars: number
): Promise<string> {
  return (await readDecodedText(stream, maxChars)).text;
}

type DecodedTextRead = {
  text: string;
  truncated: boolean;
};

function takeAtUtf16Boundary(text: string, maxChars: number): number {
  let take = Math.min(text.length, maxChars);
  const last = take > 0 ? text.charCodeAt(take - 1) : 0;
  if (take < text.length && last >= 0xd800 && last <= 0xdbff) take += 1;
  return take;
}

async function readDecodedText(
  stream: NodeJS.ReadableStream,
  maxChars: number
): Promise<DecodedTextRead> {
  const decoder = new StringDecoder("utf8");
  let text = "";
  let truncated = false;
  for await (const chunk of stream) {
    // StringDecoder carries an incomplete UTF-8 sequence into the next chunk.
    // Calling Buffer#toString on each chunk independently would replace those
    // bytes with U+FFFD and corrupt text that a caller may write back.
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const piece = decoder.write(buffer);
    const remaining = maxChars - text.length;
    if (remaining <= 0) {
      truncated = buffer.length > 0 || piece.length > 0;
      break;
    }
    // Keep a surrogate pair together. The one-character overflow is
    // intentional because a complete code point is safer than a lone surrogate.
    const take = takeAtUtf16Boundary(piece, remaining);
    text += piece.slice(0, take);
    if (take < piece.length) {
      truncated = true;
      break;
    }
  }

  if (!truncated) {
    const tail = decoder.end();
    if (tail.length > 0) {
      const remaining = maxChars - text.length;
      if (remaining <= 0) {
        truncated = true;
      } else {
        const take = takeAtUtf16Boundary(tail, remaining);
        text += tail.slice(0, take);
        truncated = take < tail.length;
      }
    }
  }

  return { text, truncated };
}

export type BoundedTextRead = {
  text: string;
  truncated: boolean;
};

/** Read text while reporting overflow separately from the bounded content. */
export async function readStreamAsBoundedText(
  stream: NodeJS.ReadableStream,
  maxChars: number
): Promise<BoundedTextRead> {
  return readDecodedText(stream, maxChars);
}

/**
 * Check whether an artifact's MIME type indicates text-readable content.
 */
export function isTextReadableArtifact(mimeType: string): boolean {
  return isSharedTextReadableArtifact(mimeType);
}

/**
 * Open a stored artifact and read a text excerpt up to `maxChars` characters.
 */
export async function readArtifactExcerpt(
  storage: Pick<ArtifactStorage, "openReadStream">,
  storageKey: string,
  maxChars: number
): Promise<string> {
  const handle = await storage.openReadStream(storageKey);
  return readStreamAsText(handle.stream, maxChars);
}
