/**
 * Returns true when @fastify/multipart refused a file part because it is
 * larger than the `fileSize` limit (code FST_REQ_FILE_TOO_LARGE).

 */
export function isFileTooLargeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE"
  );
}
