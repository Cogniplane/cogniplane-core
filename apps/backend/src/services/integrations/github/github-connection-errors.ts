/**
 * The tenant has no GitHub App configured, so no user can connect one.
 *
 * Deliberately model-facing: it surfaces through the MCP gateway when a GitHub
 * managed tool is called, and "the integration is not configured" is something
 * the model can report and the user can act on. `statusCode` 400 is the app's
 * convention for that, and it is what `clientSafeToolErrorMessage` reads —
 * without it the message collapses to a generic "Tool call failed." and the
 * user is told nothing.
 */
export class GithubConnectionNotConfiguredError extends Error {
  readonly statusCode = 400;

  constructor(message = "GitHub App integration is not configured.") {
    super(message);
    this.name = "GithubConnectionNotConfiguredError";
  }
}
