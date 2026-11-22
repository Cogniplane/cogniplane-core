import type { ZodType } from "@cogniplane/shared-types";

// Single helper for "I just deserialized JSON from the wire and want the
// shared schema to be the source of truth, not a TypeScript cast."
//
// On schema mismatch this throws — calling code is expected to surface the
// error (toast, error boundary, etc.) instead of swallowing it. Logs the
// issue list to the console first so the field paths are visible in
// devtools without unwrapping the thrown error.
//
// The log never holds the body. A body can hold a token, a recovery code or an
// authenticator secret. A raw Zod issue can also carry its input, so the log
// has only the path, code and message of each issue.
export function parseResponse<T>(schema: ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const summary = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  if (process.env.NODE_ENV !== "production") {
    console.error(
      `[api-validation] ${context}: ${summary}`,
      result.error.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message }))
    );
  }
  throw new Error(`Schema mismatch at ${context}: ${summary}`);
}
