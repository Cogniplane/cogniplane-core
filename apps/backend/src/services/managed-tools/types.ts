import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";

export type ManagedToolHandler = (input: {
  context: ToolExecutionContext;
  arguments: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

export type ManagedToolDefinition = {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  handler: ManagedToolHandler;
  /**
   * Domain the tool belongs to (e.g. "github", "notion", "session"), stamped by
   * the factory registry from the factory's registration key. Used as the
   * Policy Center `category` so a `categories` rule matches the tool's TRUE
   * domain regardless of which managed-server URL the call arrived through —
   * otherwise a caller could route `github_write_file` via a different enabled
   * managed server's URL to dodge a github-scoped rule. Populated by
   * ManagedToolFactoryRegistry.createDefinitions; absent only for tools built
   * outside the registry (tests).
   */
  category?: string;
};

// ── Schema primitives ─────────────────────────────────────────────────────────

export const nullableStringSchema = { type: ["string", "null"] } as const;
export const nullableNumberSchema = { type: ["number", "null"] } as const;
export const genericObjectSchema = { type: "object", additionalProperties: true } as const;

const managedToolErrorOutputSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    detail: genericObjectSchema
  },
  required: ["error"],
  additionalProperties: true
} as const satisfies Record<string, unknown>;

// ── Schema builders ───────────────────────────────────────────────────────────

export function strictObjectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

// Strict object where every property is required — avoids restating the key list.
export function allRequiredObjectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return strictObjectSchema(properties, Object.keys(properties));
}

export function arraySchema(items: Record<string, unknown>): Record<string, unknown> {
  return { type: "array", items };
}

export function withManagedToolErrorSchema(successSchema: Record<string, unknown>): Record<string, unknown> {
  // MCP outputSchema requires an object root. Keep `type` beside `oneOf` or
  // strict clients may reject the entire tools/list response.
  return { type: "object", oneOf: [successSchema, managedToolErrorOutputSchema] };
}

// ── Shared HTTP helper ────────────────────────────────────────────────────────

type JsonParseLogger = { warn(meta: object, msg: string): void };

const defaultJsonParseLogger: JsonParseLogger = {
  warn(meta, msg) {
    console.warn(JSON.stringify({ level: "warn", msg, ...meta }));
  }
};

/**
 * Reads a `Response` body as JSON and falls back to `{}` on parse failure.
 * Logs the failure with status + URL so upstream API breakage is visible
 * in operational logs instead of being silently masked.
 */
export async function safeJsonBody(
  res: Response,
  logger: JsonParseLogger = defaultJsonParseLogger
): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      {
        status: res.status,
        url: res.url,
        err: err instanceof Error ? err.message : String(err)
      },
      "failed to parse JSON response body"
    );
    return {};
  }
}
