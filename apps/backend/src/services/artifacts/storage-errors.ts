/**
 * True when an object storage call failed because the storage or the network
 * to it was slow or down, not because of the object. A retry later can work.
 *
 * - Timeouts of the S3 request handler (`TimeoutError`: connection, first
 *   byte, or socket inactivity during the body; `artifact-storage.ts`) and
 *   aborts (`AbortError`).
 * - Network errors on the socket, also while the body streams.
 * - S3 answers 5xx, 429 (`SlowDown`) and 408, and errors that the SDK marks
 *   retryable.
 *
 * A missing object (404, `NoSuchKey`, `ENOENT`), a refused request (403) or
 * any other error is false: a retry does not change it.
 */
export function isTransientStorageError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (candidate.name === "TimeoutError" || candidate.name === "AbortError") return true;
  if (typeof candidate.code === "string" && TRANSIENT_NETWORK_CODES.has(candidate.code)) return true;
  if (candidate.$retryable) return true;
  const status = candidate.$metadata?.httpStatusCode;
  if (typeof status === "number" && (status >= 500 || status === 429 || status === 408)) return true;
  return false;
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ABORT_ERR",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
]);
