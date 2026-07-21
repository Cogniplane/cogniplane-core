# Getting Started

A 5-minute walkthrough that gets Cogniplane Core running on your machine and walks you through your first agent session.

If you want production-grade deployment instead, see [self-hosting.md](self-hosting.md).

## Prerequisites

You need:

- **Node.js 24 LTS or later**. Check with `node --version`. The workspace pins `engines.node` to `>=24.0.0` in `package.json`; older versions will fail `pnpm install` with an `EBADENGINE` error.
- **pnpm** via Corepack — `corepack enable` is enough; pnpm itself is pinned via the workspace.
- **Docker** with the Compose plugin (`docker compose version` should work). The `make dev` flow runs Postgres in a container.
- **Git**.

And two service accounts:

- **An `ANTHROPIC_API_KEY`** — the model key for the Deep Agents runtime. Without it (or a per-tenant key), the model selector is empty and no agent turn can run. A paid API key from [console.anthropic.com](https://console.anthropic.com) is required; **consumer Free/Pro/Max subscriptions are not supported**, and OAuth tokens from the consumer apps cannot be used.
- **An `E2B_API_KEY` + `E2B_TEMPLATE_ID`** — the runtime executes shell and file tools inside per-session [E2B](https://e2b.dev) sandboxes; there is no unsandboxed local-execution mode, and the backend fails fast at boot without them. Run `make e2b-build` once to build the code-execution template in your E2B account, then set `E2B_TEMPLATE_ID` to the printed id. Sandboxes are created lazily — chat-only sessions never start one.

Cogniplane Core does not bundle a free model — agents need a paid model-provider account.

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

The defaults in `.env.example` are tuned for the make-dev flow: dev-headers auth (no SSO required), local Postgres on the standard port. Open `apps/backend/.env` and confirm:

- `AUTH_MODE=dev-headers` — bypasses WorkOS for local hacking.
- `DATABASE_URL` and `MIGRATION_DATABASE_URL` — the make target stands these up automatically.
- `ANTHROPIC_API_KEY=sk-ant-...` — the model key for agent turns.
- `E2B_API_KEY` and `E2B_TEMPLATE_ID` — from your E2B account and the `make e2b-build` output.

**Where the model key lives (env vs. per-tenant).** `ANTHROPIC_API_KEY` in `.env` is the **server-level fallback**. The runtime resolves a key as: per-tenant key (saved in admin → org settings, encrypted at rest) → env-var fallback → null. For local solo dev, putting the key in `.env` is the fastest path. For production multi-tenant deployments, prefer the per-tenant path so each tenant uses its own billing account and the key never leaves the database.

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

1. Pick a model in the selector (top right). The selector lists the available models when an Anthropic key is configured (server-level env var or per-tenant). With no key, the selector is empty and the frontend shows a "configure a model provider key" empty state.
2. Type "What files are in this workspace?" and hit send.
3. Watch the streaming response. You'll see the agent invoke a tool (`ls`, `session_context`, …), and the tool result streams back inline.

A few things to notice:

- **Tool calls show up as collapsible cards** in the chat. Click into one to see the arguments and the (redacted) result.
- **The session is warm.** Your second message in the same session reuses the same agent state and sandbox — no cold start, and conversation history survives backend restarts thanks to the Postgres checkpointer.
- **Open a second session** (left sidebar, "New session") and you get a fresh agent with a fresh workspace. Sessions are fully isolated.

## 6. Visit the admin workbench

`http://localhost:3000/admin` is where tenant settings, skills, and MCP servers are configured. In dev-headers mode the seeded `local-dev-user` is an admin of `local-dev-tenant`, so everything is editable.

Worth poking at:

- **Skills** — the catalog of structured agent operating documents. The seeded `write-artifact` skill teaches the agent to generate downloadable files via the `write_artifact` managed tool.
- **MCP servers** — gateway for Model Context Protocol tool servers. Add an external MCP server here and its tools become available to the agent at the next session start.
- **Tenant settings** — native approval policy, Policy Center enforcement mode, enabled tools/MCP servers, command-execution posture, and the system-prompt overlay applied to every turn.

## 7. Try human-in-the-loop approvals

In `Tenant settings`, use native approvals to require review for runtime actions, or use Policy Center to create a `require_approval` rule for a specific MCP tool such as `write_artifact` and then switch `policy_enforcement_mode` to `enforce`. Send a new message that asks the agent to write a file (e.g. "Write hello.md with the contents 'hi'"). The turn pauses before the gated action runs, and you'll see an approval card in the chat. Approve it and the turn resumes; reject it and the agent gets a denied tool result and adapts.

You've now seen the platform's core security primitive in action: the model never holds tool credentials directly, every flagged tool call passes through the approval coordinator, and the audit trail captures the decision.

## What's next

- **Read the architecture overview** — [ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit together.
- **Run in production** — [self-hosting.md](self-hosting.md) walks through the production checklist (RLS verification, WorkOS setup, S3 storage, E2B sandboxes, secrets management).
- **Understand the security model** — [SECURITY_FEATURES.md](SECURITY_FEATURES.md) is the full inventory of controls.
- **Learn the runtime** — the agent loop is LangChain's [Deep Agents](https://reference.langchain.com/javascript/deepagents) (planning, subagents, human-in-the-loop interrupts, durable checkpointing).
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

### The model selector is empty / turns fail with a key error

The backend lists models only when an Anthropic key is available — either at the server level (`ANTHROPIC_API_KEY` in `apps/backend/.env`, requires a restart) or saved per-tenant in admin → org settings (no restart needed; takes effect on the next session start).

A paid API key from [console.anthropic.com](https://console.anthropic.com) is required. Consumer Free/Pro/Max subscriptions and OAuth tokens from the consumer apps cannot be used.

### Boot fails with "E2B_API_KEY is required" or "E2B_TEMPLATE_ID is not configured"

The runtime executes shell/file tools inside E2B sandboxes, so both are required at boot. Create an account at [e2b.dev](https://e2b.dev), set `E2B_API_KEY`, run `make e2b-build`, and set `E2B_TEMPLATE_ID` to the printed template id.

### Tool calls fail with "MCP server not reachable"

`RUNTIME_GATEWAY_BASE_URL` must be a URL the backend's MCP client can reach. For `make dev`, `http://localhost:3001` works — the agent loop and its MCP client run in the backend process itself. See [self-hosting.md](self-hosting.md) for networked deployments.
