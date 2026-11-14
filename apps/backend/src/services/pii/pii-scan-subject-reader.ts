import type { ArtifactReadHandle, ArtifactStorage } from "../artifacts/artifact-storage.js";
import { isTransientStorageError } from "../artifacts/storage-errors.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { PiiProtectionServiceError, piiStorageUnavailableError } from "./pii-protection-service.js";
import type { PdfOcr } from "./pdf-ocr.js";
import type { PdfImageCoverage, PiiScanArtifactInput } from "./pii-provider.js";
import type { PiiScanSubjectReader } from "./pii-scan-job-handler.js";
import { toScannableText, type PdfTextExtractor } from "./scannable-text.js";
import { withTenantScope, type Pool } from "../../lib/db.js";

/**
 * Hard cap on bytes buffered from artifact storage during a PII scan read.
 * Matches the `PiiProtectionService` default (`artifactMaxBytes`) so the
 * stream read fails fast — before the whole object lands in memory — instead
 * of OOMing on a multi-GB upload and only then hitting the service-level cap.
 */
const ARTIFACT_READ_MAX_BYTES = 5 * 1024 * 1024;

export class DatabasePiiScanSubjectReader implements PiiScanSubjectReader {
  constructor(
    private readonly deps: {
      db: Pool;
      artifacts: Pick<ArtifactStore, "get">;
      storage: Pick<ArtifactStorage, "openReadStream">;
      /** Overrides the default read cap. */
      maxBytes?: number;
      /** Without it, PDF uploads are rejected as unscannable. */
      extractPdfText?: PdfTextExtractor;
      /** Without it, the scan reads only the text of a PDF. */
      ocrPdf?: PdfOcr;
    }
  ) {}

  async readMessageText(input: {
    tenantId: string;
    messageId: string;
  }): Promise<string | null> {
    // `MessageStore.getOwned` requires a userId; the scheduler worker does not
    // carry one, so we read directly under the tenant scope. RLS still applies.
    return withTenantScope(this.deps.db, input.tenantId, async (client) => {
      const result = await client.query<{ content_text: string }>(
        `SELECT content_text FROM messages WHERE tenant_id = $1 AND message_id = $2 LIMIT 1`,
        [input.tenantId, input.messageId]
      );
      if (result.rows.length === 0) return null;
      return result.rows[0].content_text ?? "";
    });
  }

  async readArtifact(input: {
    tenantId: string;
    artifactId: string;
  }): Promise<PiiScanArtifactInput | null> {
    const artifact = await this.deps.artifacts.get(input.tenantId, input.artifactId);
    if (!artifact) return null;

    const { storage, extractPdfText, ocrPdf } = this.deps;
    let imageCoverage: PdfImageCoverage | undefined;
    let readingStorage = false;
    const maxBytes = this.deps.maxBytes ?? ARTIFACT_READ_MAX_BYTES;
    // `entityTypes` on the input is part of the provider contract but the
    // protection service resolves the effective list from tenant settings —
    // this array is a placeholder to satisfy the type.
    return {
      artifactId: artifact.artifactId,
      contentType: artifact.mimeType,
      entityTypes: [],
      // Set by `readContent`. Without OCR, every PDF verdict is text-only:
      // image detection in PDFs is not reliable (an undrawn or broken image
      // is not listed). With OCR, the OCR pass reads every page it can.
      imageCoverage: () => imageCoverage,
      storageReadInProgress: () => readingStorage,
      async readContent(signal?: AbortSignal) {
        readingStorage = true;
        let bytes: Buffer;
        try {
          bytes = await readStoredObject(storage, artifact.storageKey, maxBytes, signal);
        } finally {
          readingStorage = false;
        }
        // The tenant lets the OCR slots give each tenant a turn (pdf-ocr.ts).
        const scannable = await toScannableText(
          artifact.mimeType, bytes, { extractPdfText, ocrPdf }, signal, { tenantId: input.tenantId }
        );
        imageCoverage = scannable.imageCoverage;
        return scannable.text;
      }
    };
  }
}

type DestroyableStream = NodeJS.ReadableStream & { destroy?: (error?: Error) => void; destroyed?: boolean };

/**
 * Reads a stored object into memory, with the scan's size cap and signal.
 *
 * - The signal goes to `openReadStream`, so an abort also stops the wait for
 *   the response headers.
 * - An abort during the body destroys the stream, so a stalled body frees its
 *   socket at once. The stream is also destroyed on any other early exit.
 * - A transient storage failure, or an abort while storage is read, becomes
 *   `pii_storage_unavailable` (retried without using the scan budget). Other
 *   errors, for example a missing object, pass unchanged.
 */
async function readStoredObject(
  storage: Pick<ArtifactStorage, "openReadStream">,
  storageKey: string,
  maxBytes: number,
  signal: AbortSignal | undefined
): Promise<Buffer> {
  let handle: ArtifactReadHandle;
  try {
    handle = await storage.openReadStream(storageKey, signal ? { signal } : undefined);
  } catch (error) {
    throw storageReadFailure(error, signal);
  }
  const stream = handle.stream as DestroyableStream;
  const destroy = (error?: Error) => {
    if (!stream.destroyed) stream.destroy?.(error);
  };
  const onAbort = () => destroy(abortReason(signal));
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    // An abort before the listener was added.
    if (signal?.aborted) throw abortReason(signal);
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      // Enforce the cap while reading so a huge object can't be fully
      // buffered into memory before the service-level check runs.
      if (total > maxBytes) {
        throw new PiiProtectionServiceError(
          "file_too_large",
          `Artifact exceeds the ${maxBytes}-byte PII scan cap`
        );
      }
      chunks.push(buf);
    }
  } catch (error) {
    if (error instanceof PiiProtectionServiceError) throw error;
    throw storageReadFailure(error, signal);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    destroy();
  }
  return Buffer.concat(chunks);
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("PII scan storage read aborted", "AbortError");
}

function storageReadFailure(error: unknown, signal: AbortSignal | undefined): unknown {
  return signal?.aborted || isTransientStorageError(error) ? piiStorageUnavailableError() : error;
}
