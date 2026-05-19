import type { ZodType } from "zod";

/**
 * Validates an outgoing API response against its shared schema before sending.
 * The schemas in `@cogniplane/shared-types` are the single source of truth for API
 * contracts; passing every reply through this helper guarantees the handler
 * cannot drift from what the frontend expects.
 *
 * On schema mismatch this throws — Fastify converts it to a 500 — so any
 * drift surfaces in tests immediately rather than silently shipping a wrong
 * shape. The error includes the issue paths so the offending field is obvious.
 */
export function serialize<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const summary = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  // Mirror to stderr so the contract violation surfaces in test output even
  // when the framework swallows the thrown 500. Tests rely on this to
  // diagnose schema/handler drift.
  if (process.env.NODE_ENV !== "production") {
    console.error(`[serialize] contract violation: ${summary}`);
  }
  throw new Error(`Response shape does not match contract: ${summary}`);
}
