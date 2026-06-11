/**
 * A validation failure whose message is written for the admin API client and
 * safe to return verbatim. The admin route helpers
 * (`respondAdminMutationError`, `respondSkillConfigError`) surface `.message`
 * for this class only; any other thrown error is rethrown so the global
 * error handler logs it and returns an opaque 500 — raw Postgres / SDK /
 * filesystem error strings must never reach the client.
 */
export class AdminConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminConfigError";
  }
}
