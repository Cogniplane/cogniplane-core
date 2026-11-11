# Development and verification

Scope: commands, tests, checks, CI gates and coding conventions. Local setup is
in [getting started](getting-started.md).

## Commands

Run from the repository root with the
[prerequisites](getting-started.md#prerequisites).

| Command | Purpose |
|---|---|
| `corepack pnpm install --frozen-lockfile` | Install |
| `make dev` | PostgreSQL in Docker, migrations, backend and frontend dev servers |
| `make test` | Root Vitest suite (`pnpm test:all`), then `pnpm typecheck` |
| `make lint` | ESLint |
| `pnpm exec vitest run <file>` | One test file; add `-t "<name>"` for one test |
| `pnpm --filter @cogniplane/shared-types build` | Rebuild contracts ([conventions](#conventions)) |
| `make test-integration` | Real database suite; starts local PostgreSQL for the default URL. Redis cases skip unless `INTEGRATION_REDIS_URL` is set |
| `pnpm test:integration` | Same suite against `INTEGRATION_DATABASE_URL` (superuser URL); Redis tests also need `INTEGRATION_REDIS_URL` |
| `pnpm test:coverage`, `pnpm test:coverage:frontend` | Full-source coverage with the CI floors |
| `pnpm --filter @cogniplane/frontend cf:build` | Cloudflare frontend build |
| `make smoke` | Live local stack test (`/messages` turn); needs real keys |
| `make e2b-build` | Build the E2B template |
| `make migrate` | Run migrations |
| `make seed-dev-data` | Add sample users, token usage and PII scan runs for dashboard work (`seed-dev-data.ts`) |
| `pnpm license:check` | Dependency license gate |
| `pnpm exec tsx scripts/generate-config-reference.ts` | Regenerate [configuration](configuration.md) |
| `pnpm exec tsx scripts/generate-route-index.ts` | Regenerate [HTTP routes](routes.md) |

`make help` lists the common Make targets; the `Makefile` has all of them.

## What each check proves

- Unit tests with fakes do not prove RLS, database policies, pooled connection
  isolation, or a live provider call. Use `apps/backend/src/integration/` for
  database behavior, and say in the PR what stays unverified.
- Integration tests create and drop their own database and roles. Use an
  isolated server.

## Writing tests

- Tests sit next to the code (`*.test.ts`). Vitest runs with globals off.
- Check `apps/backend/src/test-helpers/` before you add a fake (for example
  `test-runtime-policy.ts`, `fake-database.ts`, `routes-test-support.ts`).
- Every assertion must require useful output; a check for an absent secret must
  also require the output it inspects.
- Wait for an event or a saved state, not a fixed sleep. Use fake timers for
  polling.
- Frontend: RTL cannot clean up automatically without globals. Unmount hooks and
  clear `QueryClient` instances in each test.
- Keep exhaustive input matrices next to the code that owns the rule; keep a
  smaller set of cross-layer tests for wiring and security.
- Database race tests must observe the blocked statement in PostgreSQL, and roll
  back before they release a lock.
- Keep tests that use real hashing, signing, SDK wire formats or the real graph,
  even when a mock would be faster.

## CI gates

The `ci` job of `.github/workflows/ci.yml` requires every job in its `needs:`
list; among them, `dependency-audit` runs `pnpm audit` and `gitleaks` scans for
secrets. Coverage floors are in `.coverage-thresholds.json`.
`.github/workflows/docker-images.yml` builds both images on pull requests and
`main` to prove they build; it pushes nothing (`push: false`). The project
publishes no images: operators build them
([self-hosting](self-hosting.md#deploy-with-the-images)). Public pull requests
need no deployment credentials.

The `pre-push` hook (`.husky/pre-push`) runs gitleaks on the pushed commits
(when installed) and `pnpm lint`. Do not bypass it.

## Conventions

- Commits: Conventional Commits (`type(scope): subject`).
- Migrations: never edit an applied file; add the next numbered file in
  `apps/backend/db/migrations/`. The runner checks each applied file's hash.
  A migration has no statement timeout, but it fails when it waits more than
  10 seconds for a lock ([migration limits](operations.md#migration-limits)).
- Deferred SQL (`apps/backend/db/deferred/`): changes that must not run
  automatically, for example dropping a column after every backend stopped using
  it. Each file says when to run it; run it with `psql` and the migration
  credential.
- Shared contracts (`@cogniplane/shared-types`): `src/schemas/` holds the Zod
  API schemas, `primitives.ts` the shared enums and provider metadata, and the
  other files shared rules (for example
  `packages/shared-types/src/model-availability.ts`). Export a new file from
  `packages/shared-types/src/index.ts`. Backend and frontend import the package
  name, which resolves to the built `dist/`: rebuild it ([commands](#commands))
  before you test consumers. The backend serializes responses with the schema
  (`serialize`); the frontend parses them with `parseResponse`.
- New HTTP route:
  - Validate input with `parseRequestInput` and a Zod schema.
  - Guard: wrap `/admin/*` handlers in `withAdmin`
    (`routes/admin/admin-route-helpers.ts`; owners and admins). Elsewhere, call
    `requireRole` (`lib/rbac.ts`) for an elevated route.
  - Check session or project access; run tenant queries in `withTenantScope`;
    write an audit event for admin and security actions.
  - Errors: `apiError("<code>", "<fixed text>")`, or `notFoundError` for a 404
    (`lib/http-errors.ts`). Codes are snake_case strings at the call site; there
    is no central list. The frontend matches on some codes (for example
    `step_up_required` in `lib/api-client.ts`), so do not rename a shipped code.
    Pin the status and code in the route test.
  - A route that changes where data goes, weakens a control or releases a skill
    is a [sensitive change](architecture/sensitive-changes.md#step-up).
- Configuration: add variables to `apps/backend/src/config.ts` and regenerate
  the reference. A new or changed route: regenerate the route index.
- Do not commit `.env` files or build output.
- Releases are Git tags on `main`. No workflow runs on a tag and there is no
  changelog. For upgrade notes, list the new migrations and deferred SQL between
  tags: `git log --stat <old>..<new> -- apps/backend/db/migrations
  apps/backend/db/deferred` ([upgrade](operations.md#upgrade)). For other
  changes, diff the generated references and the frontend build variables: `git
  diff <old>..<new> -- docs/configuration.md docs/routes.md
  apps/frontend/.env.example`.
