# Getting started

Scope: run Cogniplane Core on one machine for development. For a container
stack, see [Docker deploy](docker-deploy.md). For production, see
[self-hosting](self-hosting.md).

## Prerequisites

- Node.js 26 (`engines.node`). pnpm through Corepack: Node 25 and later do not
  include Corepack, so run `npm install -g corepack`, then `corepack enable`.
  `package.json` pins the pnpm version.
- Docker with the Compose plugin. `make dev` runs PostgreSQL in a container.
- `lsof` (the port check of `make dev` uses it) and Poppler's `pdftotext` (PDF
  text extraction; `PDFTOTEXT_BINARY_PATH`).
- An API key for at least one [model
  provider](architecture/models.md#model-providers). For Anthropic, a paid API
  key; consumer Claude subscriptions do not work.
- An E2B account. The backend does not start without `E2B_API_KEY` and a real
  `E2B_TEMPLATE_ID`. There is no local execution mode.

## Steps

```bash
git clone https://github.com/Cogniplane/cogniplane-core.git
cd cogniplane-core
corepack pnpm install --frozen-lockfile
cp apps/backend/.env.example apps/backend/.env
cp apps/frontend/.env.example apps/frontend/.env.local
E2B_API_KEY=e2b_... make e2b-build    # builds template deep-agents-runtime-dev
```

In `apps/backend/.env`, set:

- `E2B_API_KEY`, and `E2B_TEMPLATE_ID`: the id of template
  `deep-agents-runtime-dev` (build log or E2B dashboard).
- One provider key, for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. You can
  also save a key per tenant later in Admin > Models.

Keep the defaults for the rest: `AUTH_MODE=dev-headers`, local database URLs. Do
not commit `.env` files.

```bash
make dev
```

`make dev` starts PostgreSQL, waits until it is healthy, runs migrations, then
starts the backend (`http://localhost:3001`) and the frontend
(`http://localhost:3000`).

## Check that it works

1. Open `http://localhost:3000`. In `dev-headers` mode there is no sign-in: the
   frontend sends `X-User-Id: local-dev-user` and `X-Tenant-Id:
   local-dev-tenant`. Users in `ADMIN_USER_IDS` (by default the dev user) are
   owners; others are members.
2. Select a model and send "What files are in this workspace?". A tool card
   appears and the answer streams.
3. Open `http://localhost:3000/admin` for tenant settings, skills and MCP
   servers.
4. To see an approval: in Admin > Policies, add a rule `require_approval` for
   `write_artifact`, set enforcement to `enforce`, then ask the agent to write a
   file. The turn pauses at an approval card.

## Local accounts and email in development

`dev-headers` skips sign-in. To test local accounts, MFA, passkeys or email:

1. Stop `make dev`. Start Redis: `docker compose up -d redis`. For email, also
   start the mail catcher: `docker compose --profile mail up -d mailpit` (web UI
   on `http://localhost:8025`).
2. In `apps/backend/.env`, set `AUTH_MODE=jwt`, `AUTH_LOGIN_TYPES=local`,
   `REDIS_URL=redis://localhost:6379`, your own `JWT_SECRET` and
   `DATA_ENCRYPTION_SECRET` (the built-in defaults are refused), and optionally
   `WEBAUTHN_RP_ID=localhost`. For email: `SMTP_URL=smtp://localhost:1025`,
   `MAIL_FROM=...`, `SMTP_ALLOW_PLAINTEXT=true`.
3. In `apps/frontend/.env.local`, remove `NEXT_PUBLIC_DEV_USER_ID` and
   `NEXT_PUBLIC_DEV_TENANT_ID`.
4. Start `make dev` again, so that both servers load the new values.
5. Create a tenant and owner ([operator
   commands](architecture/local-accounts.md#operator-commands)):
   ```bash
   MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/cogniplane \
     pnpm --filter @cogniplane/backend auth:bootstrap --tenant-name Dev --owner-email you@example.test
   ```
   Open the printed setup link (or the email in Mailpit).

Startup rules for these values: [configuration](configuration.md#startup-rules).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port 3000 or 3001 in use | `make dev` needs both ports (`scripts/check-dev-ports.mjs`). Stop the other process. |
| `make dev` waits forever for PostgreSQL | Run `docker compose ps` and `docker compose logs postgres`. Port 5432 may be in use. |
| Migration `permission denied` | `MIGRATION_DATABASE_URL` must be a superuser URL. |
| Empty model list | No provider has a key, or Admin > Models turns the providers or models off. Set a key in `.env` and restart, or save a tenant key in Admin > Models; then check that the provider and models are on there. |
| Shell or file tools fail | `E2B_TEMPLATE_ID` must exist in the E2B account of `E2B_API_KEY`. |

Next: [development](development.md) for tests and checks;
[architecture](architecture/overview.md) for the code.
