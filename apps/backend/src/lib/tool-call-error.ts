import { redactSecrets } from "../services/redact-secrets.js";

/**
 * A tool-call failure whose message is written for the *model* and safe to
 * return verbatim over the MCP gateway.
 *
 * Same contract as `AdminConfigError`, at a different boundary with a harsher
 * audience. The model reads a JSON-RPC error from `/mcp/:serverId`. The tool
 * card shows it, and the transcript and the LangGraph checkpointer store it.
 * Do not relay `error.message` unconditionally. It can contain E2B sandbox ids,
 * S3 bucket names, or Postgres relation names.
 *
 * Throw this for a refusal the model can act on ("that tool is not enabled").
 * `clientSafeToolErrorMessage` collapses everything else, such as SDK, driver,
 * and filesystem errors. Those errors survive only in the request log.
 */
export class ToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCallError";
  }
}

/**
 * Mirrors `clientSafeTurnFailureMessage` in the Deep Agents adapter.
 * Deliberately user-facing errors pass through. Everything else collapses.
 *
 * Passed through:
 *   - `ToolCallError` — raised by this gateway for a policy refusal.
 *   - `AdminConfigError` — validation text already written for an API client.
 *   - anything carrying a 4xx `statusCode`/`status`, the convention app code and
 *     provider SDKs both use for "the caller can fix this".
 *
 * Classified by `name` rather than `instanceof` for the same reason the adapter
 * does it: a duplicated module instance (bundling, vitest module graph) breaks
 * `instanceof` while the name survives.
 */
export function clientSafeToolErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }

  if (error.name === "ToolCallError" || error.name === "AdminConfigError") {
    return error.message;
  }

  const raw = error as unknown as { statusCode?: unknown; status?: unknown };
  const status = typeof raw.statusCode === "number" ? raw.statusCode : raw.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return error.message;
  }

  return fallback;
}

export type LoggedToolError = {
  type: string;
  message?: string;
  stack?: string;
  code?: string | number;
  cause?: LoggedToolError;
};

const MAX_LOGGED_CAUSES = 3;

function redactToolErrorText(value: string): string {
  return redactSecrets(value).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@");
}

/**
 * The part of a tool-call failure that the gateway writes to the log, the only
 * place where the cause of an internal failure stays.
 *
 * It keeps the type, the message, the stack, a primitive `code` and the cause
 * chain. It drops all other fields. SDK and driver errors put request headers,
 * client objects and row values in enumerable fields, and pino's error
 * serializer writes each enumerable field. An SDK can also quote a key in its
 * message, so the message and the stack go through the `redactSecrets` text
 * rules, with URL user information removed too. A throw that is not an Error
 * keeps only its type: a thrown string can be a connection string.
 *
 * Log the result under `error`. Fastify's `err` serializer reads any object
 * with a `message` as an Error and replaces its `type` with "Object".
 */
export function toolErrorForLog(error: unknown, depth = 0): LoggedToolError {
  // A getter that throws here would escape the caller's catch block, and the
  // RPC answer would become an HTTP 500.
  try {
    if (!(error instanceof Error)) {
      return { type: typeof error };
    }
    const { message, stack, cause } = error;
    const code = (error as { code?: unknown }).code;
    return {
      type: (typeof error.constructor === "function" && error.constructor.name) || String(error.name),
      ...(typeof message === "string" ? { message: redactToolErrorText(message) } : {}),
      ...(typeof stack === "string" ? { stack: redactToolErrorText(stack) } : {}),
      ...(typeof code === "string" ? { code: redactToolErrorText(code) } : {}),
      ...(typeof code === "number" ? { code } : {}),
      ...(cause !== undefined && depth < MAX_LOGGED_CAUSES ? { cause: toolErrorForLog(cause, depth + 1) } : {})
    };
  } catch {
    return { type: "unknown" };
  }
}
