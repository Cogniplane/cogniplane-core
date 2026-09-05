# Docker Deploy

A `docker compose up` walkthrough for self-hosters who want the full Cogniplane Core stack on a single host without installing Postgres on the bare metal.

For local dev (host-side `pnpm dev`, Docker only for Postgres), see [getting-started.md](getting-started.md). For production-grade deployment with SSO and managed infra, see [self-hosting.md](self-hosting.md).

## What you get

- Postgres 17 (data persists in a named volume)
- Redis 7 (data persists in a named volume)
- Backend (Fastify, running the Deep Agents agent loop in-process) at `localhost:3001`
- Frontend (Next.js) at `localhost:3000`
- `dev-headers` auth — no SSO, no WorkOS account needed
- Code execution in **E2B sandboxes**: the agent's shell and file tools run in a lazy per-session sandbox in E2B's cloud, not in the backend container

This is the simplest path to "running Cogniplane on my machine." It is **not** production-safe — see "What this is not" below.

## Prerequisites

- Docker 24+ with the Compose plugin (`docker compose version` should work)
- ~4 GB free disk for the images
- An **E2B account** ([e2b.dev](https://e2b.dev)) — the runtime executes code inside E2B sandboxes, and the backend refuses to boot without `E2B_API_KEY` and a real `E2B_TEMPLATE_ID`
- An **`ANTHROPIC_API_KEY`** (paid key from [console.anthropic.com](https://console.anthropic.com)) — the Deep Agents runtime calls the Anthropic API; without a key no agent turn can run. Use is governed by Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms).
- Node.js 24+ with pnpm (via Corepack) — only for the **one-time E2B template build** (`make e2b-build` runs a small script on the host). Everything else runs in containers.

You don't need a Postgres install or a WorkOS account.

## Quickstart

```bash
git clone https://github.com/Cogniplane/cogniplane-core.git
cd cogniplane-core

# One-time: build the code-execution template in your E2B account.
pnpm install
export E2B_API_KEY=e2b_...
make e2b-build          # note the template id it prints

export E2B_TEMPLATE_ID=<id printed by the build>
export ANTHROPIC_API_KEY=sk-ant-...
export POSTGRES_PASSWORD=$(openssl rand -hex 32)
export APP_USER_PASSWORD=$(openssl rand -hex 32)
export DEV_HEADERS_AUTH_KEY=$(openssl rand -hex 32)

docker compose up --build
```

The first build pulls the base images and runs `pnpm install` for both the backend and the frontend — expect 5–15 min on a cold cache. Subsequent runs are fast.

When the backend is ready you'll see something like:

```
cogniplane-backend  | Server listening at http://0.0.0.0:3001
```

Open `http://localhost:3000` in a browser. You'll be auto-signed-in as `local-dev-user` (dev-headers mode), and the workspace at `/` is ready to chat.

## Stopping and cleaning up

```bash
docker compose down              # stop + remove containers, keep data
docker compose down --volumes    # also wipe Postgres + Redis data
```

## Environment variables

The compose file forwards these env vars from the host:

| Var | What it does |
|---|---|
| `E2B_API_KEY` | **Required.** The runtime executes shell/file tools inside E2B sandboxes; the backend fails fast at boot without it. |
| `E2B_TEMPLATE_ID` | **Required.** The template id printed by `make e2b-build`. The backend refuses to boot on the placeholder default. |
| `ANTHROPIC_API_KEY` | Required for agent turns. Without it (and without a per-tenant key configured in the admin UI), `/models` returns an empty list and the model selector is empty. |
| `POSTGRES_PASSWORD` | Optional on loopback. Overrides the local Postgres superuser password. |
| `APP_USER_PASSWORD` | Optional on loopback. Overrides the local application database role password. |
| `DEV_HEADERS_AUTH_KEY` | Optional on loopback. Overrides the shared browser/backend key used by dev-headers auth. Must contain at least 16 characters. |

Drop any of these in a `.env` file at the repo root if you'd rather not export them in your shell:

```
E2B_API_KEY=e2b_...
E2B_TEMPLATE_ID=...
ANTHROPIC_API_KEY=sk-ant-...
POSTGRES_PASSWORD=<generated-value>
APP_USER_PASSWORD=<different-generated-value>
DEV_HEADERS_AUTH_KEY=<different-generated-value>
```

Compose picks them up automatically.

The committed local defaults only work with the loopback Postgres bind. An
`exposure-guard` container refuses to start the stack on any other bind address
until you override all three credentials.

## What's running where

```
Browser  ──▶  localhost:3000   ──▶  cogniplane-frontend  (next start)
                                         │
                                         ▼
              localhost:3001   ──▶  cogniplane-backend   (Fastify + Deep Agents loop)
                                         │
                                         ├──▶  cogniplane-postgres:5432
                                         ├──▶  cogniplane-redis:6379
                                         ├──▶  api.anthropic.com        (model calls)
                                         └──▶  E2B cloud sandboxes      (code execution)
```

Internal Docker DNS gives the backend `postgres` and `redis` as hostnames; the frontend hits the backend via `localhost:3001` (mapped from the container's port 3001) because `NEXT_PUBLIC_API_URL` is baked into the bundle at build time. The E2B sandboxes run in E2B's infrastructure, not on your host — the backend dials out to them for shell/file execution. Managed MCP tool calls never leave the backend: the agent loop and its MCP client both run in the backend process, so `RUNTIME_GATEWAY_BASE_URL`'s default of `http://localhost:3001` works here.

## Switching to a different hostname

`NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_DEV_USER_ID` are baked into the frontend bundle by `next build`. If you want to expose the stack on a hostname other than `localhost`, override the build args and rebuild:

```bash
docker compose build \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
  --build-arg NEXT_PUBLIC_DEV_USER_ID=local-dev-user \
  frontend

# And update the backend's API_ORIGIN to match the frontend's host:
API_ORIGIN=https://example.com docker compose up
```

`RUNTIME_GATEWAY_BASE_URL` only needs to be reachable from the backend container itself (the MCP client is in-process); the default works unless you split the gateway onto another host — see [self-hosting.md](self-hosting.md).

## What this is not

This compose stack is for **trusted internal use** — your laptop, a dev VM, an internal team's intranet box. Do not put it on the public internet without these changes:

- **Switch `AUTH_MODE` to `workos`** (or another real auth provider). Dev-headers mode reads `X-User-Id` from the request — anyone who can reach the backend can impersonate any user. See [self-hosting.md](self-hosting.md#authentication) for the full WorkOS setup.
- **Front it with TLS.** The compose stack speaks plain HTTP. Put it behind a reverse proxy (nginx, Caddy, Traefik) terminating TLS before exposing it.
- **Restrict bucket ACLs.** This stack doesn't use object storage at all (artifacts persist on the named volume `runtime-workspaces`). If you switch to `ARTIFACT_STORAGE_BACKEND=bucket`, lock the bucket down — the artifact download flow uses presigned URLs, so no object should be public.

If you want the hardened production posture, follow [self-hosting.md](self-hosting.md) instead.

The Compose file runs the application containers with read-only root filesystems,
drops their Linux capabilities, and sets CPU and memory limits. Postgres only
publishes on loopback unless you explicitly change `POSTGRES_BIND_ADDR`.

## Troubleshooting

**`docker compose up` exits immediately with `pull access denied`.** You're behind a registry that needs auth, or Docker Hub is rate-limiting unauthenticated pulls. `docker login` before retrying.

**Backend exits with `E2B_API_KEY is required` or `E2B_TEMPLATE_ID is not configured`.** Both are mandatory at boot — there is no local execution fallback. Sign up at [e2b.dev](https://e2b.dev), run `make e2b-build`, and export both vars (or put them in `.env`) before `docker compose up`.

**Backend exits with `MIGRATION_DATABASE_URL is required` or similar.** Make sure you ran `docker compose up`, not `docker compose run backend` — the latter doesn't apply the `environment:` block from the compose file. The compose-up path provisions the env correctly.

**`http://localhost:3000` shows "Could not load the model list" or auth errors.** The backend probably failed to boot. Check `docker compose logs backend` — common causes: missing `E2B_*` vars (see above), Postgres not yet healthy (the backend retries; wait 30s and refresh), or the host's port 3001 was already in use (the backend bound but the frontend can't reach it through the mapped port).

**The model selector is empty.** No Anthropic key is available — export `ANTHROPIC_API_KEY` and restart, or configure a per-tenant key in the admin UI. If a key is set but rejected by the provider, the backend logs the provider error on the first turn attempt.

**Turns start but shell/file tools fail.** Check that `E2B_TEMPLATE_ID` matches a template that actually exists in the E2B account behind `E2B_API_KEY` (the backend can't detect a stale-but-real id at boot), and that outbound network access to E2B's API isn't blocked.

**The first `docker compose up --build` is slow.** The builder installs the
workspace dependencies before producing the backend bundle and frontend build.
The backend runtime image contains only production dependencies and is about
114 MB with the current lockfile.

**`pnpm install` fails inside the build with `EBADENGINE`.** The Dockerfiles pin
Node 24.11.1. Update that immutable base reference together with the workspace's
Node requirement, then rebuild.

## What's next

- [getting-started.md](getting-started.md) — local dev with `make dev` (Postgres in Docker, apps on the host)
- [self-hosting.md](self-hosting.md) — production deployment with WorkOS, S3 storage, and the full E2B setup
- [ARCHITECTURE.md](ARCHITECTURE.md) — the system you just deployed, in detail
