/**
 * A tool-call failure whose message is written for the *model* and safe to
 * return verbatim over the MCP gateway.
 *
 * Same contract as `AdminConfigError`, at a different boundary and with a
 * harsher audience. A JSON-RPC error from `/mcp/:serverId` is read by the model,
 * shown in the tool card, and persisted to the transcript and the LangGraph
 * checkpointer. Relaying `error.message` unconditionally put E2B sandbox ids,
 * S3 bucket names and Postgres relation names into all three.
 *
 * Throw this for a refusal the model can act on ("that tool is not enabled").
 * Everything else — SDK, driver and filesystem errors — is collapsed by
 * `clientSafeToolErrorMessage` and only survives in the request log.
 */
export class ToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCallError";
  }
}

/**
 * Message for a JSON-RPC tool-call error. Mirrors
 * `clientSafeTurnFailureMessage` in the Deep Agents adapter: deliberately
 * user-facing errors pass through, everything else collapses.
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
