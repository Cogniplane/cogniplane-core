# Development and verification

Use Node 24 and the pnpm version in `package.json` from the repository root.

```bash
corepack pnpm install --frozen-lockfile
make dev
make lint
make test
make test-integration
pnpm --filter @cogniplane/frontend cf:build
```

Copy the backend and frontend `.env.example` files to `.env` and `.env.local`
before local development. Keep credentials in these ignored files. Do not commit
generated build output or local environment files.

The root test suite includes the backend, frontend, SharePoint integration and
script tests. Real database tests need `INTEGRATION_DATABASE_URL`; Redis tests
also need `INTEGRATION_REDIS_URL`. Use an isolated test server. Integration tests
create and drop their own databases and roles.

CI checks lint, types, unit coverage, real Postgres/Redis integration, dependency
licenses, secrets, frontend Workers and Docker builds on hosted runners. Public
pull requests do not need deployment credentials or access to a private runner.

Rebuild `@cogniplane/shared-types` after contract changes before checking consumers.
Run the Cloudflare build after frontend build changes. A passing unit mock does
not prove provider behavior or database isolation.

## Demo build outputs

After successful push CI on public `main`, the `Demo build` workflow publishes
an exact-commit prerelease named `demo-build-<SHA>`. It contains the backend
image, prebuilt frontend and sandbox Workers, and a manifest with file checksums,
image identity and source CI/build run IDs. The build uses public demo origins
and has no deployment credentials. It can also be dispatched manually on `main`
when that commit already has successful push CI.

Deployment is a separate private promotion step. A build release does not change
the live demo. Promotion verifies the commit, public checks and downloaded outputs
before it applies migrations or deploys either Worker.
