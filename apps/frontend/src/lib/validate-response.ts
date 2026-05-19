import type { ZodType } from "@cogniplane/shared-types";

// Single helper for "I just deserialized JSON from the wire and want the
// shared schema to be the source of truth, not a TypeScript cast."
//
// On schema mismatch this throws — calling code is expected to surface the
// error (toast, error boundary, etc.) instead of swallowing it. Logs the
// issue list to the console first so the field paths are visible in
// devtools without unwrapping the thrown error.
export function parseResponse<T>(schema: ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const summary = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  if (process.env.NODE_ENV !== "production") {
    console.error(`[api-validation] ${context}: ${summary}`, result.error.issues, value);
  }
  throw new Error(`Schema mismatch at ${context}: ${summary}`);
}
