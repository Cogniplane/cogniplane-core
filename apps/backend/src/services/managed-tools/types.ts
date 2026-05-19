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
  return { oneOf: [successSchema, managedToolErrorOutputSchema] };
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
