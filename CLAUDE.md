# Working in Cogniplane Core

Cogniplane Core is a multi-tenant browser workspace built with Fastify, Next.js,
and shared TypeScript contracts. Deep Agents runs the agent loop in the backend;
E2B supplies lazy shell and file execution.

## Delivery and contributions

Carry the requested change through implementation and verification. Trace the
HTTP route, runtime, persistence, and frontend paths that participate. Keep a
small change small. Preserve existing work and security boundaries.

Do not commit, push, publish, merge, or deploy without explicit user authorization.
When authorized, use conventional commits, batch related changes, and run the
required checks. Do not bypass hooks. See [CONTRIBUTING](CONTRIBUTING.md) for the
contribution process. Do not add AI attribution to commits or PRs.

Report what changed, which checks ran, and what remains unverified. Passing unit
mocks does not prove a live provider call or a database policy.

## Code map and security boundaries

- `apps/backend/src/routes/`: HTTP entrypoints. `services/` contains stores,
  workers, integrations, and the Deep Agents runtime. `lib/` contains auth and DB access.
- `apps/frontend/src/app/`, `components/`, `hooks/`, `lib/`: routes, UI, state,
  and clients. AG-UI chat connects through `lib/agui/deep-agents-browser-agent.ts`
  and `components/copilot-chat-host.tsx`.
- `packages/shared-types/src/`: shared Zod contracts. Consumers import built
  `dist/`; rebuild this package after edits before testing consumers.
- `apps/backend/db/migrations/`: authoritative SQL. Never edit applied migrations;
  add a numbered migration. The runner checks each applied file's hash.
- Tenant queries use `withTenantScope`, a transaction-local tenant setting, and
  the RLS-constrained `app_user`. Privileged maintenance needs an explicit
  authorization reason. Checkpointer tables in `deep_agents` have no RLS;
  validate session ownership before reaching them.
- MCP identity and credentials come from backend context. Preserve approval
  proof binding, tenant isolation, expiry, and secret redaction. Classify public
  error messages; unexpected SDK or DB errors must not expose internal details.
- Native and Policy Center approvals pause the checkpointed graph. Keep resume
  values keyed by interrupt id and preserve gateway approval-proof verification.
- E2B workspaces hold artifacts across turns. Artifact checkboxes select prompt
  context; they do not revoke access to files already synced to the workspace.
- Skills use a read-only `/skills/` library. Trace import, revision metadata,
  activation, runtime config, and library construction when changing that path.
- Frontend middleware is a redirect hint. Backend authentication is the security
  boundary. Preserve the chat host's live-stream and reload-seeding behavior.

Read [architecture](docs/ARCHITECTURE.md) for the affected subsystem.
[Configuration](docs/CONFIGURATION.md) is generated from
`apps/backend/src/config.ts`; do not maintain a second list of defaults here.
[Self-hosting](docs/self-hosting.md) owns infrastructure and setup requirements.

## Commands and verification

Use Node 24 and the Corepack pnpm version pinned in `package.json`, from repo root.

```bash
make dev                  # configured local stack; see README prerequisites
make test                 # root Vitest suite and workspace typechecks
make lint                 # workspace ESLint
pnpm test:integration     # requires INTEGRATION_DATABASE_URL (see below)
pnpm --filter @cogniplane/shared-types build
pnpm exec vitest run apps/backend/src/services/managed-tools/factory.test.ts
pnpm exec vitest run -t "write_artifact" apps/backend/src/services/managed-tools/factory.test.ts
make e2b-build
```

For `pnpm test:integration`, set `INTEGRATION_DATABASE_URL` to a superuser
connection URL for the test Postgres server. The suite creates and drops its
own isolated database. The guard's `make test-integration` suggestion applies
to the private tree; that target is absent from this public Makefile.

Backend unit tests use Vitest and shared fakes under
`apps/backend/src/test-helpers/`, including `test-runtime-policy.ts`. Check those
helpers before adding a fake. Real Postgres security tests live under
`apps/backend/src/integration/`; unit fakes cannot validate RLS.

[Contributing](CONTRIBUTING.md) describes contributor checks and CI gates.
Verify frontend build changes with `pnpm --filter @cogniplane/frontend cf:build`.
[README](README.md#quickstart) owns local setup.
