// Guard for `pnpm test:integration`.
//
// The Vitest project skips itself when INTEGRATION_DATABASE_URL is absent, which
// is exactly right for the root `pnpm test:all` aggregate: the workspace run
// stays green on a machine with no Postgres. It is wrong for a command whose
// name promises integration tests. "86 skipped, exit 0" reads as a pass and is
// how an RLS regression reaches main unnoticed.
//
// So the explicit command fails loudly; the aggregate keeps skipping.
if (!process.env.INTEGRATION_DATABASE_URL) {
  console.error(
    [
      "INTEGRATION_DATABASE_URL is not set, so there is no database to test against.",
      "",
      "This command runs the Postgres-backed RLS suite and refuses to report a",
      "pass without one. (The root `pnpm test:all` deliberately skips the project",
      "instead, so the workspace run stays green without Postgres.)",
      "",
      "Start one and point at it:",
      "  make test-integration",
      "",
      "Or against a server you already have (a SUPERUSER connection to the",
      "server, not to a specific database -- the suite creates and drops its own):",
      "  INTEGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \\",
      "    pnpm test:integration"
    ].join("\n")
  );
  process.exit(1);
}
