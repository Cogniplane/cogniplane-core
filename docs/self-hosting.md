# Self-Hosting Cogniplane Core

A production-grade deployment guide. For local dev, see [getting-started.md](getting-started.md). For the architecture this guide deploys, see [ARCHITECTURE.md](ARCHITECTURE.md). For the security model you're inheriting, see [SECURITY_FEATURES.md](SECURITY_FEATURES.md).

This guide is opinionated. Where there's a fork in the road, it picks the production-safe option and explains the trade-off.

## What you're about to deploy

Three runtime components plus their dependencies:

```
[ Frontend (Next.js) ] -- HTTPS --> [ Backend (Fastify) ]
                                          |
                                          +--> PostgreSQL (RLS)
                                          +--> Redis (jti revocation, rate limits)
                                          +--> Object storage (artifacts, skill bundles)
                                          +--> E2B (per-session agent sandboxes)
                                          +--> WorkOS (SSO)
```

The agent runtimes — Codex and Claude — run **inside the E2B sandboxes**, not on the backend host. The backend brokers JSON-RPC over stdio for Codex and over a Node harness for Claude, normalizes events, and writes to Postgres.

## Required infrastructure

| Component | Why | Notes |
|---|---|---|
| **PostgreSQL 14+** | Sole persistence layer. RLS is critical to multi-tenant isolation. | Any managed Postgres works (Neon, RDS, Cloud SQL, self-hosted). Must support `SET LOCAL` and RLS policies (Postgres 9.5+; in practice you want 14+). |
| **Redis 6+** | Refresh-token `jti` revocation, shared rate limits across multiple backend instances. | Any managed Redis (Upstash, ElastiCache, Memorystore, self-hosted). Without Redis, rate limits and quotas are per-process — fine for a single instance, broken for a horizontal-scaled deployment. |
| **S3-compatible object storage** | Artifact uploads and (in `bucket` mode) skill bundles. | AWS S3, Cloudflare R2, MinIO, GCS with S3 compat. The skill-bundle backend reuses `ARTIFACT_BUCKET_*` credentials by design. |
| **E2B account** | Per-session agent sandboxes. | Sign up at [e2b.dev](https://e2b.dev). You'll need an API key and you'll build a custom template (next section). |
| **WorkOS** | SSO. Optional if you can live with `dev-headers` mode, but **do not run `dev-headers` in production** — it accepts user/tenant ids from request headers with no verification. | [workos.com](https://workos.com) — set up an organization, configure SAML/OIDC, get the API key + client id. |
| **Node.js 24 LTS** | Runtime for the backend. The workspace pins `engines.node` to `>=24.0.0`. | The frontend is a Next.js app; deploy it however you deploy Next apps (Vercel, Cloudflare Workers via `@cloudflare/next-on-pages`, a Node container, etc). |

## Build the E2B sandbox template

The backend boots without `E2B_API_KEY` — it just falls back to in-process runtime mode, which is **not** production-safe (no sandboxing). Production wants `RUNTIME_BACKEND=e2b` and `CLAUDE_RUNTIME_BACKEND=e2b`.

The unified template hosts both Codex and Claude:

```bash
E2B_API_KEY=e2b_xxx make e2b-build-codex
```

This runs `docker/build.prod.ts`, which calls the v2 E2B Template SDK to build an `agent-runtime-dev` template. It installs:

- `@openai/codex` CLI at the version pinned in `apps/backend/src/codex-release.json`
- `@anthropic-ai/claude-agent-sdk` at the matching pinned version
- `docker/sandbox-agent/sandbox-agent.mjs` (the Claude harness) at `/opt/cogniplane/sandbox-agent.mjs`

Building with the existing template name updates it in place, preserving the template id. Note the template id printed at the end — you'll set it as `E2B_TEMPLATE_ID`.

The default value in `codex-release.json.e2bTemplateId` is the placeholder `replace-with-your-template-id` — the backend refuses to start with `RUNTIME_BACKEND=e2b` (or `CLAUDE_RUNTIME_BACKEND=e2b`) until you provide a real template id, either by setting the env var directly or by committing the JSON change that `make e2b-build-codex` produces.

**Bumping versions later:** edit `apps/backend/src/codex-release.json` (`codexVersion` or `claudeAgentSdkVersion`), update `apps/backend/package.json` to match if you bumped the Claude SDK, and rebuild the template. The drift test (`apps/backend/src/codex-release.test.ts`) will fail in CI if these get out of sync.

## Backend environment

Full env-var schema with defaults is in `apps/backend/src/config.ts` — boot fails fast on missing required secrets via Zod. Below is the production configuration in dependency order.

### Database

```bash
# RLS-active runtime pool (non-superuser).
DATABASE_URL=postgres://app_user:<strong-password>@<host>:5432/<dbname>?sslmode=require

# Superuser DSN — used only by db:migrate. Bypasses RLS to apply schema, create roles, and enable policies.
MIGRATION_DATABASE_URL=postgres://postgres:<superuser-password>@<host>:5432/<dbname>?sslmode=require
```

The migration runner (`apps/backend/src/scripts/migrate.ts`) uses `MIGRATION_DATABASE_URL` to:
1. `CREATE ROLE app_user WITH LOGIN` if missing.
2. `ALTER ROLE app_user WITH PASSWORD '<from DATABASE_URL>'` so the runtime DSN actually works.
3. Apply migrations idempotently.
4. Grant minimal privileges to `app_user`; `app_user` is the role subject to RLS at runtime.

`pnpm db:migrate` is what you run after deployment. It's safe to re-run — migrations track applied state in `_migrations`.

**Verifying RLS is active:** after `db:migrate` succeeds, connect as `app_user` and try `SELECT * FROM sessions` without setting `app.current_tenant_id`. You should get zero rows. If you get rows, RLS is misconfigured.

### Authentication

```bash
AUTH_MODE=workos                      # Production. dev-headers is a security hole in production.
JWT_SECRET=<32+ random bytes>         # Refresh-token signing. Rotate via JWT_KEY_ID infrastructure.
JWT_KEY_ID=v1                         # Stamp on tokens; lets you rotate JWT_SECRET without invalidating in-flight tokens.
DATA_ENCRYPTION_SECRET=<32+ random bytes>  # AES-256-GCM key for OAuth-token at-rest encryption.

WORKOS_API_KEY=<from WorkOS dashboard>
WORKOS_CLIENT_ID=<from WorkOS dashboard>
WORKOS_REDIRECT_URI=https://your-backend-host/auth/callback
```

`JWT_SECRET` and `DATA_ENCRYPTION_SECRET` MUST differ from the placeholder values in `.env.example`. The boot-time validator will reject placeholders in production.

The WorkOS redirect URI must match exactly what's registered in your WorkOS dashboard. The backend handles the OAuth code exchange in `POST /auth/callback`.

### Redis

```bash
REDIS_URL=rediss://default:<password>@<host>:6379  # TLS-required for production
```

Required for `AUTH_MODE=workos`. The refresh-token `jti` is consumed atomically via `GETDEL` on every refresh; without Redis, you have no replay defense. Also used for shared rate limits and quotas across multiple backend instances.

### Object storage

```bash
ARTIFACT_STORAGE_BACKEND=bucket
ARTIFACT_BUCKET_NAME=<your-bucket>
ARTIFACT_BUCKET_REGION=<region>
ARTIFACT_BUCKET_ENDPOINT=<S3-compatible endpoint>   # Optional; default is AWS S3
ARTIFACT_BUCKET_ACCESS_KEY_ID=<credential>
ARTIFACT_BUCKET_SECRET_ACCESS_KEY=<credential>

SKILL_BUNDLE_STORAGE_BACKEND=bucket
SKILL_BUNDLE_BUCKET_NAME=<usually same as ARTIFACT_BUCKET_NAME>
SKILL_BUNDLE_BUCKET_PREFIX=skills                   # Optional key prefix
```

Skill bundles are content-addressed: the same bundle hash always points at the same S3 key, so re-deploys never re-upload identical bundles. The local extraction cache (`SKILL_BUNDLE_CACHE_ROOT`, default `<os.tmpdir()>/cogniplane-skill-cache`) is also content-addressed and idempotent — `/tmp` ephemerality on container restart is fine because S3 is the source of truth.

### Runtime sandboxing

```bash
RUNTIME_BACKEND=e2b
CLAUDE_RUNTIME_BACKEND=e2b
E2B_API_KEY=<from e2b.dev>
E2B_TEMPLATE_ID=<from your template build>

# RUNTIME_GATEWAY_BASE_URL is the URL the sandbox dials back to for /mcp.
# Must be reachable from inside the E2B sandbox — meaning, publicly resolvable.
RUNTIME_GATEWAY_BASE_URL=https://your-backend-host
```

`RUNTIME_GATEWAY_BASE_URL` is the most common misconfiguration. The sandbox runs in E2B's infrastructure, not yours — `localhost` and VPC-internal addresses won't resolve. Your backend needs a publicly-reachable URL for the runtime to call back into.

### Model provider keys (Anthropic, OpenAI)

```bash
# Server-level fallback — used when no per-tenant key is configured.
ANTHROPIC_API_KEY=<from console.anthropic.com>   # Optional. Enables Claude runtime.
OPENAI_API_KEY=<from platform.openai.com>        # Optional. Enables Codex runtime.
CLAUDE_CODE_MODEL=sonnet                          # Default Claude model
```

Two paths are supported and you should pick the right one for your deployment shape:

- **Per-tenant keys** (preferred for multi-tenant production). Saved via the admin UI in org settings, encrypted at rest with `DATA_ENCRYPTION_SECRET`, scoped per tenant. Each tenant uses its own billing account; the key never appears in environment variables or process listings. This is the default path for SaaS-style deployments where you don't want one Anthropic invoice covering every tenant.
- **Server-level env-var fallback**. Used when no per-tenant key is set. Right for single-tenant or solo-operator self-hosters where one Anthropic account covers everything.

The runtime resolves the key for a turn as: per-tenant key → env-var fallback → null. If both resolve to null, the affected runtime (Claude or Codex) is not registered for that tenant.

**Anthropic Commercial Terms apply.** The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is bundled with Cogniplane Core but is governed by Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms), not by Cogniplane Core's AGPL license. The SDK requires a paid API key from `console.anthropic.com` — **consumer Free/Pro/Max subscriptions are not supported**, and OAuth tokens from the consumer apps cannot be used. Each tenant (or operator, for the env-var path) is responsible for maintaining their own Anthropic account and complying with Anthropic's terms.

### Optional: PII detection

```bash
PII_PROVIDER_ENABLED=false
PII_LLM_BASE_URL=https://openrouter.ai/api/v1   # any OpenAI-compatible endpoint
PII_LLM_API_KEY=<provider key>
PII_LLM_MODEL=google/gemini-2.5-flash
PII_PROVIDER_TIMEOUT_MS=5000
```

PII detection is opt-in. The pipeline targets any OpenAI-compatible `/chat/completions` endpoint — point `PII_LLM_BASE_URL` at OpenRouter, a cloud provider, or a model you self-host (e.g. a local Ollama or vLLM server). Whatever provider you choose, you accept that vendor's logging posture; self-hosting the model keeps inference entirely within your own infrastructure.

### Workers

```bash
SCHEDULER_ENABLED=true
SCHEDULER_MAX_CONCURRENT_JOBS=10
SCHEDULER_JOB_TIMEOUT_MS=900000             # 15 min hard cap per job
SCHEDULER_POLL_INTERVAL_MS=30000

SKILL_JUDGE_WORKER_ENABLED=false            # Off by default; per-tenant config is the second gate
```

The scheduler claims due jobs atomically (`FOR UPDATE SKIP LOCKED`) so it's safe to run multiple backend instances; only one will pick up any given job.

### CORS

```bash
API_ORIGIN=https://your-frontend-host       # Exact match, single origin. Comma-separate for multiple.
```

The backend rejects requests from any origin not on this list. CORS for SSE responses is set explicitly via the same allowlist (the response is hijacked, so Fastify's automatic CORS doesn't fire).

## Frontend deployment

The frontend is a Next.js 16 app. Deploy it however you deploy Next apps. Required env vars at **build time** (not runtime — these get baked into the bundle):

```bash
NEXT_PUBLIC_API_URL=https://your-backend-host
# Do NOT set NEXT_PUBLIC_DEV_USER_ID in production builds. Setting it bypasses WorkOS.
```

If your frontend and backend are on different domains (typical), the WorkOS refresh cookie must use `SameSite=None; Secure=true` — without it, the browser silently rejects the cookie on cross-site requests. The cookie is scoped to the **backend domain**, so the frontend middleware can't read it; route protection on the frontend is handled client-side by `auth-guard.tsx`.

## Production checklist

Before you point real users at it:

- [ ] **RLS is active.** Connect as `app_user` (not superuser), forget to set `app.current_tenant_id`, query a tenant-scoped table — should return zero rows. If it returns rows, stop and fix.
- [ ] **`AUTH_MODE=workos`**, NOT `dev-headers`.
- [ ] **`JWT_SECRET` and `DATA_ENCRYPTION_SECRET` are not placeholder values.** The boot validator will reject `local-dev-jwt-secret-change-in-production!!`.
- [ ] **`REDIS_URL` is configured.** Without it, refresh-token reuse detection is broken.
- [ ] **TLS in front of the backend.** HSTS is sent on every response (2-year preload); serving HTTPS is required for it to make sense.
- [ ] **Object storage bucket has restrictive ACLs.** The artifact download flow always issues short-lived presigned URLs — there's no reason for any object in your bucket to be public.
- [ ] **`E2B_TEMPLATE_ID` matches what `make e2b-build-codex` produced.** The drift test (`apps/backend/src/codex-release.test.ts`) catches this in CI; verify locally if you skipped CI.
- [ ] **Database backups configured.** Postgres is the only durable state — sessions, messages, audit events, integrations all live there. Treat it like the production database it is.
- [ ] **Log retention policy set.** Tool events (`tool_events`) and audit events (`audit_events`) accumulate. Decide your retention before they fill the disk.
- [ ] **At least one user is `owner` of each tenant.** First-member owner promotion is automatic on the first WorkOS callback, but verify it actually happened.

## Operating concerns

### Scaling out the backend

The backend is stateless modulo Redis and Postgres. Run multiple instances behind a load balancer — that's the intended deployment shape. Each instance:

- Holds in-memory rate limits/quotas only when Redis isn't configured (so configure Redis for multi-instance).
- Runs its own scheduler poll loop, but `FOR UPDATE SKIP LOCKED` makes job claiming safe across instances.
- Has its own `runtime_sessions` map for active sandboxes. There's no shared sandbox pool — sandboxes are per-instance per-session.

What this means: a session's runtime sandbox lives on whichever backend instance accepted the first message of that session. Subsequent messages on the same session need to land on the same instance, OR the new instance has to spin up a fresh sandbox and resume the runtime via `runtime_sessions`. Sticky sessions (load-balancer level) is the simplest path; resume-via-DB works but adds a cold-start hit on instance failover.

### Rotating secrets

- **`JWT_SECRET`**: stamp `kid` (`JWT_KEY_ID`) on every token already; bump the env-var, deploy, and existing tokens with old `kid` continue to validate against the old secret until they expire (15 min for access tokens, 7d for refresh tokens). Plan one full refresh window before retiring the old key.
- **`DATA_ENCRYPTION_SECRET`**: this encrypts at-rest OAuth tokens. Rotating means re-encrypting every `user_*_connections` row. There's no automated rotation in the OSS code — script it as a one-off migration if you need to.
- **`WORKOS_API_KEY`** / **provider keys**: bump the env-var and redeploy. WorkOS-issued JWTs survive the API key rotation; only the server-to-server WorkOS client uses the API key.

### Bumping pinned versions

`apps/backend/src/codex-release.json` pins three things: `codexVersion`, `claudeAgentSdkVersion`, `e2bTemplateId`. Bumping is:

1. Edit `codex-release.json` (and `apps/backend/package.json` for the Claude SDK).
2. Run `make e2b-build-codex` to rebuild the template.
3. The template id in `codex-release.json` may have updated — commit it.
4. Update `E2B_TEMPLATE_ID` in your deployment environment to match.
5. Run `pnpm codex:release:check` to confirm the drift test passes.
6. Deploy.

The drift test (`codex-release.test.ts`) asserts `E2B_TEMPLATE_ID` matches the JSON and that the sandbox-agent harness file exists. CI runs it on every PR.

### Monitoring

The OSS code emits structured logs via Fastify's pino logger. There's no built-in metrics endpoint or dashboard — wire your usual observability stack (Datadog, Grafana, OpenTelemetry, etc.) at the log/metric layer.

What's worth alerting on:

- Backend 5xx rate.
- `audit_events` rows where `event_type LIKE 'auth.%' AND payload->>'reason' = '%'` — auth failures.
- `approvals` rows stuck in `pending` past their TTL — approval flow is wedged.
- `runtime_sessions` rows in unexpected states (long-running, crashed-but-not-cleaned).
- `scheduled_jobs` failure rate — usually means a tenant's scheduled prompt is broken.

Cost tracking: per-turn `usage` is persisted on `messages` (`token_input`, `token_output`, model, estimated cost). `SELECT SUM(estimated_cost) FROM messages WHERE created_at > now() - interval '1 day'` is a starting point for daily spend.

## Where to go from here

- [ARCHITECTURE.md](ARCHITECTURE.md) — the system you just deployed, in detail
- [SECURITY_FEATURES.md](SECURITY_FEATURES.md) — full inventory of security controls; useful for security review questionnaires
- [DECISIONS.md](DECISIONS.md) — why the architecture is shaped the way it is
- [guides/runtime-selection.md](guides/runtime-selection.md) — choosing Codex vs Claude per tenant
- [guides/skill-bundle-decisions.md](guides/skill-bundle-decisions.md) — skill bundle storage and lifecycle
- [COMMERCIAL.md](../COMMERCIAL.md) — commercial license terms if AGPL doesn't fit your distribution model
