/**
 * A validation failure. Its message is for the admin API client and is safe to
 * return as is. The admin route helpers (`respondAdminMutationError`,
 * `respondSkillConfigError`) return `.message` for this class only. The helpers
 * rethrow other errors, so the global handler logs them and returns an opaque
 * 500. Raw Postgres, SDK, or filesystem error text must never reach the client.
 */
export class AdminConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminConfigError";
  }
}
