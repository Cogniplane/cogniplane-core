# Docker Deploy

A `docker compose up` walkthrough for self-hosters who want the full Cogniplane Core stack on a single host without installing Node/pnpm/Postgres on the bare metal.

For local dev (host-side `pnpm dev`, Docker only for Postgres), see [getting-started.md](getting-started.md). For production-grade deployment with sandboxing, SSO, and managed infra, see [self-hosting.md](self-hosting.md).

## What you get

- Postgres 17 (data persists in a named volume)
- Redis 7 (data persists in a named volume)
- Backend (Fastify + the bundled `codex` CLI) at `localhost:3001`
- Frontend (Next.js) at `localhost:3000`
- `dev-headers` auth — no SSO, no WorkOS account needed
- `RUNTIME_BACKEND=local` — agent runtimes execute in the backend container; **no E2B sandbox isolation**

This is the simplest path to "running Cogniplane on my machine." It is **not** production-safe — see "What this is not" below.

## Prerequisites

- Docker 24+ with the Compose plugin (`docker compose version` should work)
- ~4 GB free disk for the images
- One of:
  - `OPENAI_API_KEY` (Codex runtime, paid key from [platform.openai.com](https://platform.openai.com))
  - `ANTHROPIC_API_KEY` (Claude runtime, paid key from [console.anthropic.com](https://console.anthropic.com) — consumer subscriptions are not supported by the Claude Agent SDK; use is governed by Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms))

You don't need a Postgres install, a Node install, an E2B account, or a WorkOS account.

## Quickstart

```bash
git clone https://github.com/Cogniplane/cogniplane-core.git
cd cogniplane-core

# Pick at least one. Set both if you want both providers.
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

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

The compose file reads two optional env vars from the host:

| Var | What it does |
|---|---|
| `OPENAI_API_KEY` | Enables the Codex runtime. Without it, Codex is hidden in the model selector. |
| `ANTHROPIC_API_KEY` | Enables the Claude runtime. Without it, Claude is hidden in the model selector. |
| `APP_USER_PASSWORD` | Optional. Overrides the default `app_user` Postgres password. Defaults to `local-dev-app-user-password`. Don't set this unless you have a specific reason to. |

Drop any of these in a `.env` file at the repo root if you'd rather not export them in your shell:

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

Compose picks them up automatically.

## What's running where

```
Browser  ──▶  localhost:3000   ──▶  cogniplane-frontend  (next start)
                                         │
                                         ▼
              localhost:3001   ──▶  cogniplane-backend   (Fastify + codex CLI)
                                         │
                                         ├──▶  cogniplane-postgres:5432
                                         └──▶  cogniplane-redis:6379
```

Internal Docker DNS gives the backend `postgres` and `redis` as hostnames; the frontend hits the backend via `localhost:3001` (mapped from the container's port 3001) because `NEXT_PUBLIC_API_URL` is baked into the bundle at build time.

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

## What this is not

This compose stack is for **trusted internal use** — your laptop, a dev VM, an internal team's intranet box. Do not put it on the public internet without these changes:

- **Switch `AUTH_MODE` to `workos`** (or another real auth provider). Dev-headers mode reads `X-User-Id` from the request — anyone who can reach the backend can impersonate any user. See [self-hosting.md](self-hosting.md#authentication) for the full WorkOS setup.
- **Switch to E2B sandbox runtimes** (`RUNTIME_BACKEND=e2b`, `CLAUDE_RUNTIME_BACKEND=e2b`). With `local`, the agent's tool calls execute inside the backend container's filesystem — a malicious prompt can read whatever the backend process can read.
- **Front it with TLS.** The compose stack speaks plain HTTP. Put it behind a reverse proxy (nginx, Caddy, Traefik) terminating TLS before exposing it.
- **Restrict bucket ACLs.** This stack doesn't use object storage at all (artifacts persist on the named volume `runtime-workspaces`). If you switch to `ARTIFACT_STORAGE_BACKEND=bucket`, lock the bucket down — the artifact download flow uses presigned URLs, so no object should be public.

If you want the hardened production posture, follow [self-hosting.md](self-hosting.md) instead.

### Optional: re-enable seccomp + read-only rootfs

`docker/seccomp-codex.json` is a seccomp profile sized for the Codex runtime. The default compose stack does not use it because it adds friction and the no-sandbox first-run is already trust-bounded. If you want to layer it back on, edit `compose.yaml` and add to the `backend` service:

```yaml
    security_opt:
      - seccomp=docker/seccomp-codex.json
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:mode=1777,size=512m
      - /home/appuser:mode=0755,uid=1001,gid=1001,size=1g
```

## Troubleshooting

**`docker compose up` exits immediately with `pull access denied`.** You're behind a registry that needs auth, or Docker Hub is rate-limiting unauthenticated pulls. `docker login` before retrying.

**Backend exits with `MIGRATION_DATABASE_URL is required` or similar.** Make sure you ran `docker compose up`, not `docker compose run backend` — the latter doesn't apply the `environment:` block from the compose file. The compose-up path provisions the env correctly.

**`http://localhost:3000` shows "Could not load the model list" or auth errors.** The backend probably failed to boot. Check `docker compose logs backend` — common causes: Postgres not yet healthy (the backend retries; wait 30s and refresh), or the host's port 3001 was already in use (the backend bound but the frontend can't reach it through the mapped port).

**Models don't appear in the selector.** Either no provider key is set (export `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` and restart) or the key is rejected by the provider. The backend logs the provider error on the first turn attempt.

**The first `docker compose up --build` is very slow.** The backend image installs `uv`, `bun`, the GitHub CLI, and the Codex CLI, plus Python 3 with `python-is-python3`. ~10 min on a cold cache; ~1 min on rebuild. The Codex CLI install dominates.

**`pnpm install` fails inside the build with `EBADENGINE`.** Your local Node version pinned by Docker (we use `node:24-trixie-slim`) is older than the workspace expects. Pull the latest base image: `docker compose build --pull`.

## What's next

- [getting-started.md](getting-started.md) — local dev with `make dev` (Postgres in Docker, apps on the host)
- [self-hosting.md](self-hosting.md) — production deployment with WorkOS, E2B sandboxing, S3 storage
- [ARCHITECTURE.md](ARCHITECTURE.md) — the system you just deployed, in detail
