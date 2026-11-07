import type { ZodType } from "zod";

/**
 * Validates an outgoing API response against its shared schema before sending.
 * The schemas in `@cogniplane/shared-types` are the source of truth for API
 * contracts.
 *
 * On a mismatch this throws, and Fastify turns the throw into a 500. Drift then
 * shows up in tests, not as a wrong response shape. The error lists the issue
 * paths, so the offending field is easy to find.
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
