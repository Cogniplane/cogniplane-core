# Getting Started

A 5-minute walkthrough that gets Cogniplane Core running on your machine and walks you through your first agent session.

If you want production-grade deployment instead, see [self-hosting.md](self-hosting.md).

## Prerequisites

You need:

- **Node.js 24 LTS or later**. Check with `node --version`. The workspace pins `engines.node` to `>=24.0.0` in `package.json`; older versions will fail `pnpm install` with an `EBADENGINE` error.
- **pnpm** via Corepack — `corepack enable` is enough; pnpm itself is pinned via the workspace.
- **Docker** with the Compose plugin (`docker compose version` should work). The `make dev` flow runs Postgres in a container.
- **Git**.

Optional, for the full agent experience:

- **An `OPENAI_API_KEY`** — required to use the Codex runtime. Without it, the Codex provider is hidden from the model selector. Get a paid key at [platform.openai.com](https://platform.openai.com).
- **An `ANTHROPIC_API_KEY`** — required to use the Claude runtime. Without it, the Claude provider is hidden from the model selector. The Claude Agent SDK requires a paid API key from [console.anthropic.com](https://console.anthropic.com); **consumer Free/Pro/Max subscriptions are not supported**, and OAuth tokens from the consumer apps cannot be used. Your use of the SDK is governed by Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms).
- **An `E2B_API_KEY`** — required if you want runtimes to execute inside isolated sandboxes (`RUNTIME_BACKEND=e2b` or `CLAUDE_RUNTIME_BACKEND=e2b`). For the quickstart you can leave these on `local` and skip E2B entirely.

**You need at least one of `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` for any agent turn to actually work.** Cogniplane Core does not bundle a free model — agents need a paid model-provider account.

## 1. Clone and install

```bash
git clone https://github.com/Cogniplane/cogniplane-core.git
cd cogniplane-core
pnpm install
```

Installation pulls dependencies for both `apps/backend` and `apps/frontend`, plus the shared types package. Expect this to take a minute or two on a cold install.

## 2. Configure environment

```bash
cp apps/backend/.env.example apps/backend/.env
cp apps/frontend/.env.example apps/frontend/.env.local
```

The defaults in `.env.example` are tuned for the make-dev flow: dev-headers auth (no SSO required), local Postgres on the standard port, in-process runtime mode. Open `apps/backend/.env` and confirm:

- `AUTH_MODE=dev-headers` — bypasses WorkOS for local hacking.
- `DATABASE_URL` and `MIGRATION_DATABASE_URL` — the make target stands these up automatically.
- Add `ANTHROPIC_API_KEY=sk-ant-...` if you want Claude as a runtime option.

**Where API keys live (env vs. per-tenant).** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in `.env` are the **server-level fallback**. The runtime resolves a key as: per-tenant key (saved in admin → org settings, encrypted at rest) → env-var fallback → null. For local solo dev, putting the key in `.env` is the fastest path. For production multi-tenant deployments, prefer the per-tenant path so each tenant uses its own billing account and the key never leaves the database.

## 3. Start the stack

```bash
make dev
```

This single command:

1. Starts Postgres in a Docker container and waits for it to accept connections.
2. Runs migrations against the new database (creates the `app_user` role, enables Row-Level Security policies, seeds platform-default tenant settings).
3. Starts the Fastify backend on `http://localhost:3001`.
4. Starts the Next.js frontend on `http://localhost:3000`.

You should see logs from both servers interleaved. The first run takes the longest because Docker pulls the Postgres image. Subsequent runs reuse the container and migration state.

If something goes wrong, the [Troubleshooting](#troubleshooting) section at the bottom covers the common cases.

### Common Make targets

| Target | What it does |
|---|---|
| `make dev` | Start Postgres in Docker, run migrations, start backend + frontend (the quickstart path). |
| `make test` | Run unit tests across the workspace + typecheck. |
| `make lint` | ESLint across the workspace. |
| `make typecheck` | `tsc --noEmit` across the workspace. |
| `make build` | Production build (`pnpm build`). |
| `make migrate` | Run DB migrations against the configured `DATABASE_URL`. |
| `make smoke` | Local end-to-end smoke test — boots the stack and runs one `/messages` turn. Requires API keys. |

`make help` lists all targets, including the build helpers under the [self-hosting guide](self-hosting.md) (E2B template builds, Docker images).

## 4. Open the app

Visit **`http://localhost:3000`** in your browser.

In dev-headers mode there is no login screen — the frontend sends `X-User-Id: local-dev-user` and `X-Tenant-Id: local-dev-tenant` headers automatically, and the backend's auth middleware accepts them.

## 5. Send your first message

You'll land on the chat workspace. To send a message:

1. Pick a runtime in the model selector (top right). The selector lists every provider whose API key is configured (server-level env var or per-tenant). With both keys set you'll see "Codex" and "Claude"; with only one, just that one. With neither, the selector is empty and the frontend shows a "configure a model provider key" empty state.
2. Type "What files are in this workspace?" and hit send.
3. Watch the streaming response. You'll see the agent invoke a tool (`session_context` or filesystem-listing depending on the runtime), and the tool result streams back inline.

A few things to notice:

- **Tool calls show up as collapsible cards** in the chat. Click into one to see the JSON-RPC arguments and the (redacted) result.
- **The runtime is per-session.** Your second message in the same session reuses the same runtime process — no cold start.
- **Open a second session** (left sidebar, "New session") and you get a fresh runtime with a fresh workspace. Sessions are fully isolated.

## 6. Visit the admin workbench

`http://localhost:3000/admin` is where tenant settings, skills, and MCP servers are configured. In dev-headers mode the seeded `local-dev-user` is an admin of `local-dev-tenant`, so everything is editable.

Worth poking at:

- **Skills** — the catalog of structured agent operating documents. The seeded `write-artifact` skill teaches the agent to generate downloadable files via the `write_artifact` managed tool.
- **MCP servers** — gateway for Model Context Protocol tool servers. Add an external MCP server here and it materializes into the agent workspace at the next session start.
- **Tenant settings** — runtime provider, native approval policy, Policy Center enforcement mode, enabled tools/MCP servers, and the system-prompt overlay applied to every turn.

## 7. Try human-in-the-loop approvals

In `Tenant settings`, use native approvals to require review for runtime actions, or use Policy Center to create a `require_approval` rule for a specific MCP tool such as `write_artifact` and then switch `policy_enforcement_mode` to `enforce`. Send a new message that asks the agent to write a file (e.g. "Write hello.md with the contents 'hi'"). The turn pauses before the gated action runs, and you'll see an approval card in the chat. Approve it and the turn resumes; reject it and the agent gets a denied tool result and adapts.

You've now seen the platform's core security primitive in action: the model never holds tool credentials directly, every flagged tool call passes through the approval coordinator, and the audit trail captures the decision.

## What's next

- **Read the architecture overview** — [ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit together.
- **Run in production** — [self-hosting.md](self-hosting.md) walks through the production checklist (RLS verification, WorkOS setup, S3 storage, E2B sandboxes, secrets management).
- **Understand the security model** — [SECURITY_FEATURES.md](SECURITY_FEATURES.md) is the full inventory of controls.
- **Pick a runtime** — [guides/runtime-selection.md](guides/runtime-selection.md) explains when Codex vs Claude is the right choice.
- **Add a skill** — [guides/skill-bundle-decisions.md](guides/skill-bundle-decisions.md) covers the skill bundle format and lifecycle.

---

## Troubleshooting

### "Port 3000 / 3001 already in use"

Something else on your machine is using the dev port. Either stop it, or set `API_PORT` (backend) or use `pnpm --filter @cogniplane/frontend dev -p 3010` (frontend) to pick a different port. If you change the backend port, also update `NEXT_PUBLIC_API_URL` in `apps/frontend/.env.local`.

### "Cannot connect to the Docker daemon"

Docker isn't running. Start Docker Desktop (Mac/Windows) or `sudo systemctl start docker` (Linux), then retry `make dev`.

### Postgres connection refused

`make dev` waits for Postgres to be ready, but on slow machines the wait sometimes times out. Run `docker compose ps` — if the postgres container shows `Up`, just rerun `make dev`. If it shows `Exit`, run `docker compose logs postgres` to see why.

### Migrations fail with "permission denied"

The `MIGRATION_DATABASE_URL` must be a **superuser** DSN (`postgres://postgres:...`), not the `app_user` DSN. The migration runner uses superuser privileges to create the `app_user` role and enable RLS policies. Check `apps/backend/.env`.

### Claude runtime says "ANTHROPIC_API_KEY missing"

The backend only registers the Claude provider when an Anthropic key is available — either at the server level (`ANTHROPIC_API_KEY` in `apps/backend/.env`, requires a restart) or saved per-tenant in admin → org settings (no restart needed; takes effect on the next session start). Without either, you can still use Codex.

The Claude Agent SDK requires a paid API key from [console.anthropic.com](https://console.anthropic.com). Consumer Free/Pro/Max subscriptions and OAuth tokens from the consumer apps cannot be used with the SDK.

### Tool calls fail with "MCP server not reachable"

`RUNTIME_GATEWAY_BASE_URL` must be a URL the runtime process can reach. For `make dev` (in-process runtime mode), `http://localhost:3001` works. If you're running runtimes in E2B sandboxes, they need a publicly-reachable URL — see [self-hosting.md](self-hosting.md).
