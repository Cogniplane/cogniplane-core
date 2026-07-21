# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git workflow

Use conventional commits (`feat`, `fix`, `chore`, `docs`, `refactor`, etc.). Batch related changes into meaningful commits rather than committing every small step. Push when the working tree is in a coherent state — the pre-push hook runs lint, typecheck, and coverage; please don't bypass it.

For contribution mechanics (CLA, PR conventions), see [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

Package manager is `pnpm` (via Corepack). All commands from repo root.

```bash
make dev          # starts Postgres via Docker, runs migrations, starts both servers
make test         # all tests + typecheck

pnpm --filter @cogniplane/backend test                        # backend tests only
pnpm --filter @cogniplane/backend exec vitest run apps/backend/src/services/foo.test.ts          # single test file
pnpm --filter @cogniplane/backend exec vitest run -t "my test" apps/backend/src/services/foo.test.ts

pnpm db:migrate   # run DB migrations
pnpm test:e2e:local  # E2E smoke test (requires running stack)

make e2b-build          # build the Deep Agents code-execution E2B template
```

Backend: `http://localhost:3001` — Frontend: `http://localhost:3000` — Admin workbench: `http://localhost:3000/admin`

## Architecture Overview

This is a **multi-tenant agent platform** built as a pnpm workspace:

- `apps/backend` — Fastify API (ESM TypeScript, `tsx` for dev/tests)
- `apps/frontend` — Next.js 16 UI
- `packages/shared-types` — shared schema/contract types consumed by both apps

### Request → Runtime → SSE flow

The agent runtime is **Deep Agents** (LangChain [deepagentsjs](https://reference.langchain.com/javascript/deepagents)); the agent loop runs **in-process in the Fastify backend**, with a lazy per-session E2B sandbox for code execution.

1. `POST /messages` (`routes/messages.ts`) validates input, enforces rate limits and quotas, resolves the model via `resolveRuntimeModel` (`services/runtime/runtime-model-resolver.ts` — models come from `AVAILABLE_MODELS` in `domain/models.ts`, ids namespaced `<catalog>/<vendorModel>` e.g. `deepagents/claude-sonnet-5`, `openai/gpt-5.4`, `openrouter/meta-llama/...`; unknown ids 400; the resolver gates on the selected model's provider key), then calls `streamAssistantReply` (`services/sse-stream-writer.ts`).
2. `streamAssistantReply` hijacks the raw socket, sets SSE headers, creates a `ToolExecutionContext` (short-lived per-turn credential carrier), and calls `runtimeAdapter.runMessage`.
3. `DeepAgentsRuntimeAdapter` (`services/deep-agents/deep-agents-runtime-adapter.ts`) lazily builds a per-session deepagentsjs agent (`createDeepAgent`) and runs the turn as a LangGraph `streamEvents` (v2) stream in the backend process, returning an `AsyncIterable<RuntimeEvent>`.
4. Stream events are normalized to `RuntimeEvent` via `deep-agents-event-mapper.ts` and streamed as SSE to the browser. Assistant text and tool results are persisted incrementally to the `messages` table.

### Deep Agents runtime

Key files (all under `apps/backend/src/services/deep-agents/`):

- `deep-agents-runtime-adapter.ts` — the `RuntimeAdapter` implementation. Session lifecycle (idle teardown, invalidation), the per-turn interrupt/approval loop, the `RUNTIME_TURN_TIMEOUT_MS` watchdog (aborts a wedged turn via `config.signal`; disarmed while an approval prompt is pending), token-usage capture from stream `usage_metadata`, and client-safe turn-failure messages (4xx provider errors pass through; internals collapse to a generic message).
- `deep-agents-graph.ts` — compiles the agent: `initChatModel` (multi-provider — `resolveModelConstruction` maps a catalog id to `<initPrefix>:<vendorModel>` + base URL per `MODEL_PROVIDER_META`; supports Anthropic, OpenAI, Google (`google-genai`), OpenRouter and Z.AI (both via the OpenAI client with a custom base URL). Reasoning effort is baked in per provider by `applyReasoningEffort`; a missing provider key raises `ProviderKeyMissingError` (400)), the shared checkpointer, the lazy E2B sandbox backend, MCP gateway tools via `MultiServerMCPClient` (streamable HTTP, `Authorization: Bearer rt_...` header only, never `?token=`), and `interruptOn` HITL gating. Per-turn `toolContextId` is injected into managed tool args at call time via the client's top-level `beforeToolCall` hook — always overriding any model-supplied value. MCP tools load per-server with degradation (one broken server skips its tools, not all), and tool names colliding with deepagents built-ins (`RESERVED_BUILTIN_TOOL_NAMES`) or duplicated across servers are dropped with a warning instead of crashing `createDeepAgent`. MCP tool names are **unprefixed** under `MultiServerMCPClient` defaults.
- `deep-agents-e2b-backend.ts` — `E2bDeepAgentsSandbox extends BaseSandbox` (deepagents' sandbox protocol; the library has no official E2B backend). Implements `execute()`/`uploadFiles()`/`downloadFiles()` over the E2B JS SDK and overrides `ls`/`read`/`grep`/`glob` to remap "/"-rooted paths into the session workspace (workspace-escaping paths return the protocol's structured `{error}`). **Lazy:** the sandbox is created on first use, memoized per session; chat-only sessions never create one. Per-command timeout (`DEEP_AGENTS_EXECUTE_TIMEOUT_MS`) and a 64k output cap are enforced at this layer.
- `deep-agents-checkpointer.ts` — durable `PostgresSaver` in its own Postgres schema **`deep_agents`** with an explicit named pool. DDL runs from `migrate.ts` (superuser) via `setupDeepAgentsCheckpointer`; the runtime saver connects as `app_user`. **The checkpointer tables have no tenant column and no RLS** — isolation is app-layer: `thread_id` IS the session id, and every route that reaches the checkpointer resolves the session through the RLS-scoped `sessions` table first. Session deletion purges the thread; idle teardown does not (threads resume across process restarts).
- `deep-agents-event-mapper.ts` — LangGraph `streamEvents` v2 envelopes → `RuntimeEvent`. The wire shapes are a deliberate frontend contract — do not "modernize" them. Subagent namespaces (multi-segment `langgraph_checkpoint_ns`) are dropped; `write_todos` renders as the plan pane; MCP card server attribution comes from the load-time toolName→serverId map.
- `deep-agents-types.ts` — the factory/session-runtime contracts.

Runtime behavior notes:

- **Execution backend: E2B only, lazy.** Shell/file tools run inside a per-session E2B sandbox (`docker/template.ts`, a slim Python + data-stack image). `E2B_API_KEY` and a real `E2B_TEMPLATE_ID` are required at boot; `config.ts` fails fast otherwise (the migration runner skips runtime checks). When the tenant's `allowCommandExecution` is false, **no sandbox is attached at all** — deepagents then never exposes the `execute` tool and file tools fall back to the checkpointed StateBackend.
- **System prompt assembly happens at session start** in the adapter: tenant `developerInstructions` + recent long-term memories (gated on `memory_search` enablement and a Policy Center evaluation). Skills are NOT inlined into the prompt — they are served as a read-only `/skills/` file library via the native deepagents skills middleware (progressive disclosure: only name/description/path reach the prompt; the model reads each SKILL.md on demand). There is no rendered workspace config on disk.
- Session workspaces live at `/home/user/workspace/<sessionId>/` inside the sandbox; the model is steered to relative paths (file tools root "/" at the workspace; `execute` sees the real filesystem).
- Images are not supported yet — image inputs emit a `framework:runtime_notice` and the turn proceeds text-only.
- The model API key is provider-aware (`services/runtime/provider-credentials.ts`): for the selected model's provider it resolves the tenant's stored key first, then the platform env fallback (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GOOGLE_API_KEY`/`OPENROUTER_API_KEY`/`ZAI_API_KEY`). The in-process loop calls each provider's API directly.
- **SDK bump guard:** the library does not export its builtin tool-name list, so `RESERVED_BUILTIN_TOOL_NAMES` is hardcoded in `deep-agents-graph.ts` and pinned by `deep-agents-graph.test.ts` against `createDeepAgent`'s actual collision behavior — a version bump that changes the builtin set fails the suite loudly.

### MCP gateway and managed tools

`/mcp/:serverId` (`routes/mcp.ts`) receives JSON-RPC 2.0 from the runtime's MCP client. Two modes:
- **managed** — tool call dispatched to the `ManagedToolFactoryRegistry` (`services/managed-tools/factory.ts`, `createDefinitions`). The `ManagedToolCatalog` (`services/managed-tools/catalog.ts`, registered in `register-builtin-managed-tools.ts`) aggregates per-domain catalogs: session tools, `write_artifact`, memory tools, the skill-corpus tool, GitHub tools, and Notion tools.
- **proxy** — forwarded to an upstream URL with framework context headers injected.

Every tool call requires a `toolContextId` resolved against `ToolExecutionContextStore`. The context carries `userId`, `sessionId`, `runtimeId`, and a snapshot of the tenant's effective runtime config (compiled from `tenant_settings`) — the model never sees credentials directly.

Tool results are passed through `redactSecrets()` (`services/redact-secrets.ts`) before persistence to strip auth headers and tokens from the audit trail.

### Approval flow

Native runtime approvals and Policy Center approvals share the same frontend event shape and decision route, but they are separate control planes.

**Native HITL approvals** are LangGraph **interrupt-based**: `tenant_settings.approval_policy` (`"never"` bypasses gating) drives an `interruptOn` map built in `deep-agents-graph.ts` — all MCP gateway tools (minus read-only ones when `auto_approve_read_only_tools` is on) plus the mutating built-ins (`execute`, `write_file`, `edit_file`), plus the read-only built-ins when the read-only bypass is off. An interrupt pauses the graph BEFORE tool execution and checkpoints; the adapter detects pending interrupts after the stream ends, persists an approval row, emits `framework:approval_required`, and resumes with a `Command` once decided. **Resume is keyed per interrupt id** so concurrent interrupts (parallel `task` subagents each hitting a gated tool) get their own decisions — do not collapse this to a flat decisions array. The frontend calls `POST /approvals/:approvalId/decision` with body `{ decision: "approve" | "reject", rememberForTurn?: boolean }` (`routes/approvals.ts`).

Policy Center can also return `require_approval` for an MCP tool call. In that path, the MCP gateway holds the JSON-RPC response open, stores an approval row through the policy approval coordinator (`services/runtime/policy-approval-coordinator.ts`), emits `framework:approval_required`, then proceeds or denies based on the decision. If no active turn can receive a prompt (for example an unattended scheduled run), the tool call is denied.

Pending approvals carry a wall-clock TTL (`APPROVAL_REQUEST_TTL_MS`, default 10 min). On expiry the DB row moves to `status='expired'`, an `approval.expired` audit event is written, a `framework:runtime_notice` (`noticeId = approval-expired:<approvalId>`) is pushed to the active turn, and the paused graph is resumed with a reject. The row also carries a DB-level `expires_at` so a process death still lets the startup sweep recover it.

### Scheduler

A background worker (`services/scheduler-worker.ts`) polls `scheduled_jobs` every `SCHEDULER_POLL_INTERVAL_MS` (default 30s), claims due jobs atomically, and runs them as synthetic agent turns. Results land in `scheduled_job_runs`. Controlled by `SCHEDULER_ENABLED`, `SCHEDULER_MAX_CONCURRENT_JOBS`, `SCHEDULER_JOB_TIMEOUT_MS`.

### Admin config (skills, MCP servers, tenant settings)

Runtime constraints (enabled tools, enabled MCP servers, native approval policy, Policy Center enforcement mode, etc.) live in **one row per tenant** in `tenant_settings`. There is no separate per-profile concept.

Three admin entities, all tenant-scoped with `tenant_id = 'system'` for platform defaults:

| Entity | Store | Key behavior |
|--------|-------|--------------|
| Skills | `SkillConfigStore` + `SkillRevisionStore` | `instructions` lives in `revision.metadata->>'instructions'` (NOT a column). Revisions must have `skillName`, `description`, and `instructions` in metadata to be activatable. Skills with a null `bundle_storage_uri` use inline instructions. |
| MCP servers | `McpServerStore` | Mode is `managed` or `proxy` |
| Tenant settings | `TenantSettingsStore` (`tenant-settings-store.ts`) | One row per tenant. Controls `enabledToolIds`, `enabledMcpServerIds`, `approvalPolicy`, `approvalReviewer`, `autoApproveReadOnlyTools`, `policyEnforcementMode`, `allowCommandExecution`, `allowUserTokenForwarding`, `developerInstructions`, `webSearchMode`, and `showEffortSelector`. The `system` tenant's row acts as the platform default. |

`allowCommandExecution` and `allowUserTokenForwarding` are owner-controlled security posture. Admins can edit other Agent Settings, but the backend rejects changes to these two fields and strips unchanged full-form values before persistence so stale admin forms cannot overwrite an owner's decision.

Policy Center rules live in `policy_rule` and are evaluated at the MCP gateway. Active dimensions are `toolNames`, `categories` (MCP server id), `severities`, and `turnContexts`; effects are `allow`, `require_approval`, and `block`. `tenant_settings.policy_enforcement_mode` is the tenant-level monitor/enforce switch.

### Multi-tenancy and database access

Every store method takes `tenantId` as its first argument. All queries run inside `withTenantScope(db, tenantId, fn)` (`lib/db.ts`), which sets `SET LOCAL app.current_tenant_id` and activates PostgreSQL Row-Level Security. Migrations run as superuser and bypass RLS. The migration runner is `src/scripts/migrate.ts`; it also runs the Deep Agents checkpointer DDL (schema `deep_agents`, no RLS — see the Deep Agents section).

Two DB pools exist in production:
- `db` — `app_user` (non-superuser, subject to RLS)
- `privilegedDb` — superuser, used only for `getDownloadToken` and migration

(The Deep Agents checkpointer additionally manages its own named `app_user` pool.)

### Authentication

`AUTH_MODE`: `dev-headers` (reads `X-User-Id`/`X-Tenant-Id` headers — local development only) or `workos` (JWT 15min + httpOnly refresh cookie, Redis jti revocation). Auth lives in `lib/auth.ts` (dev-headers) + `lib/auth-workos.ts` (WorkOS JWT). Route-level elevation: `requireRole(request, reply, ...roles)` in `lib/rbac.ts`.

The Deep Agents runtime requires at least one model-provider API key (Anthropic, OpenAI, Google, OpenRouter, or Z.AI) — a tenant-level per-provider key or a platform env fallback. `/models` filters `AVAILABLE_MODELS` to models whose provider is configured, returning an empty list as the "configure a key" state when none is present.

### Artifact pipeline

Artifacts live in the `artifacts` table. Download requires a short-lived token (`POST /artifacts/:id/download-token` → `GET /downloads/:token`); `getDownloadToken` uses `privilegedDb` to bypass RLS.

**Workspace sync:** At the start of each turn, scoped artifacts are downloaded from object storage and written to `./artifacts/` in the sandbox workspace so the agent can read them natively (PDFs, images, etc.). Files persist across turns for the lifetime of the sandbox — **do NOT clean `./artifacts/` between turns**. When no sandbox is attached (`allowCommandExecution=false`), artifact context degrades to the turn-input builder's inline excerpts (`services/turn-input-builder.ts`, `buildArtifactTurnInputs`).

**Artifact checkbox scoping (important):** The frontend lets users select artifacts via checkboxes when sending a message (`artifactIds` in `POST /messages`). This controls which artifacts appear in the turn's prompt context — it is a **UI convenience**, not a security boundary. The agent always has filesystem access to all previously synced artifacts in `./artifacts/`. Do not treat `artifactIds` as an access control mechanism or delete unselected artifacts from the workspace. The checkbox simply tells the agent "I'm referring to these files in this message."

### Skill pipeline — critical data flow

When adding or modifying skills, trace this full chain:

```
SKILL.md body → validateSkillBundle → buildSkillImportPayload
  → importSkillBundle (merges skillName/description/instructions INTO metadata JSONB)
  → activateSkillRevision (reads metadata.skillName + metadata.instructions — fails if absent)
  → compileRuntimeConfig → DeepAgentsRuntimeAdapter.createSession
  → buildSkillsLibraryFiles → read-only /skills/<slug>/ library (generated SKILL.md + bundle companions)
  → native deepagents skills middleware (progressive disclosure in the system prompt)
```

Skills are served as **files at `/skills/`** (an in-memory read-only backend routed by a `CompositeBackend`) and surfaced by the native deepagents skills middleware — only name/description/path go into the system prompt; the model `read_file`s the full SKILL.md on demand. Bundle companion files ARE materialized into the library (readable via the file tools, not visible to `execute` shell commands).

The `write-artifact` skill (seeded in `002_seed_system_data.sql`) instructs the agent to call the `write_artifact` managed tool for generated files.

### Skill bundle storage

Skill bundles (zipped `SKILL.md` + companion files) have two storage backends, chosen by `SKILL_BUNDLE_STORAGE_BACKEND` and wired in `services/skills/skill-bundle-storage.ts`:

- **`local`** (default): bundles live at `<SKILL_BUNDLE_STORAGE_ROOT>/<bundleName>/<contentHash>/`. `storageUri = file://<absolute path>`. Suitable for `make dev`; **ephemeral on container deployments** because `/tmp` does not survive task replacement.
- **`bucket`**: bundles upload as `.tar.gz` objects to S3 at `s3://<bucket>/<prefix>/skills/<tenantId>/<skillId>/<revisionNumber>-<contentHash>.tar.gz`. On session start, `installBundle` downloads and extracts on demand into `<SKILL_BUNDLE_CACHE_ROOT>/<tenantId>/<skillId>/<revisionNumber>-<contentHash>/`. The cache is content-addressed and idempotent, so `/tmp` ephemerality is fine — S3 is the source of truth. Reuses `ARTIFACT_BUCKET_*` credentials (same account, same region).

Each `admin_skill_revisions` row stores the canonical `bundle_storage_uri` (`file://` or `s3://`); the scheme selects the backend at runtime. The S3 key is derived from columns already on the revision — no new schema for versioning.

### Idempotent seed SQL pattern

For SQL that inserts dependent rows (e.g. skill + revision + link), do NOT use CTE chaining with `ON CONFLICT DO NOTHING` — the final `UPDATE ... FROM revision_insert` gets no rows when a prior partial run already inserted the revision. Use three separate statements instead:

```sql
INSERT INTO admin_skills ... ON CONFLICT DO NOTHING;
INSERT INTO admin_skill_revisions ... WHERE NOT EXISTS (...);
UPDATE admin_skills SET active_revision_id = (SELECT ... LIMIT 1) WHERE active_revision_id IS NULL;
```

### Non-obvious environment variables

Full schema with defaults is in `apps/backend/src/config.ts`. These are the ones that aren't self-explanatory:

```
RUNTIME_GATEWAY_BASE_URL  # URL the runtime's MCP client uses to reach /mcp (default: http://localhost:3001)
RUNTIME_TURN_TIMEOUT_MS   # per-turn watchdog (default 20 min); must exceed APPROVAL_REQUEST_TTL_MS and stay under E2B_SANDBOX_TIMEOUT_MS; 0 disables
TOOL_CONTEXT_TTL_MS       # per-turn tool-context lifetime; validated strictly above RUNTIME_TURN_TIMEOUT_MS
ARTIFACT_STORAGE_BACKEND  # local | bucket — bucket uses S3-compatible API; set ARTIFACT_BUCKET_* accordingly
SKILL_BUNDLE_STORAGE_BACKEND  # local | bucket — bucket tars bundles into S3 and materializes on demand
SKILL_BUNDLE_BUCKET_NAME      # required when backend=bucket; reuses ARTIFACT_BUCKET_* creds
SKILL_BUNDLE_BUCKET_PREFIX    # optional S3 key prefix
SKILL_BUNDLE_CACHE_ROOT       # local extraction cache root (default: <os.tmpdir()>/cogniplane-skill-cache)
MIGRATION_DATABASE_URL    # superuser URL; bypasses RLS — only used by migrate.ts (incl. checkpointer DDL)
REDIS_URL              # optional; without it, rate limits are per-process (not shared across instances)
AUTH_MODE              # dev-headers reads X-User-Id/X-Tenant-Id headers — never use in production
ADMIN_USER_IDS         # comma-separated; only applies in dev-headers mode
ANTHROPIC_API_KEY          # platform-level Anthropic key for the Deep Agents runtime (per-tenant key overrides). Peers: OPENAI_API_KEY / GOOGLE_API_KEY / OPENROUTER_API_KEY / ZAI_API_KEY — one per supported provider; the runtime resolves whichever the selected model needs
E2B_API_KEY                # REQUIRED — the runtime executes shell/file tools inside E2B; boot fails fast without it (+ a real E2B_TEMPLATE_ID)
E2B_TEMPLATE_ID            # the Deep Agents code-execution template id (docker/template.ts, `make e2b-build`)
E2B_SANDBOX_TIMEOUT_MS     # sandbox lifetime cap (default 30 min)
DEEP_AGENTS_EXECUTE_TIMEOUT_MS  # per-execute() wall-clock budget inside the sandbox (default 2 min)
PII_PROVIDER_ENABLED       # opt-in switch for the PII detection provider; validates config at boot when true
PII_LLM_BASE_URL           # OpenAI-compatible /chat/completions endpoint for PII detection — a hosted API or a self-hosted Ollama/vLLM. Default: https://openrouter.ai/api/v1
PII_LLM_API_KEY            # bearer token for the endpoint above — supply whatever provider you want via the env-var contract
PII_LLM_MODEL              # default: "google/gemini-2.5-flash" (see config.ts comment for retention posture)
PII_LLM_WIRE_FORMAT        # "openai" (default; POSTs <base>/chat/completions) or "ollama" (POSTs <base>/api/chat, base is host root with NO /v1)
PII_PROVIDER_TIMEOUT_MS    # sync-path budget for detect/transform; default 5000ms
PII_RETENTION_KEK          # 32-byte hex (openssl rand -hex 32); required when any tenant uses rawRetention='reversible_encrypted' — without it, that mode throws pii_kek_missing rather than silently downgrading. Per-tenant DEKs derived via HKDF-SHA256(KEK, salt=tenantId).
```

**PII detection — bring your own model.** The PII detection pipeline is a generic "send-text-to-an-LLM-for-detection" path parameterized by the `PII_LLM_*` env vars — it speaks either the OpenAI `/chat/completions` wire format or the Ollama `/api/chat` one. You configure whatever model provider you want (a hosted API or a self-hosted Ollama/vLLM) — the logging and retention posture is whatever your chosen vendor provides. See `apps/backend/src/config.ts` for the full env-var contract.

## Testing

Backend and frontend tests use **Vitest**. Test files colocate with the service they test (`*.test.ts` / `*.test.tsx`). Use `expect` from `vitest` for assertions and `vi.fn()` / `vi.spyOn()` for mocks. Hand-rolled in-memory fakes (constructed with full store types) are still the default for store-level testing — there is no test database; integration-style tests stub the store layer. Coverage runs via `vitest run --coverage` with a v8 provider.

Shared test infrastructure lives in `src/test-helpers/`: `fake-database.ts`, `in-memory-audit-events.ts`, `mcp-route-test-support.ts`, `phase4-runtime-policy.ts`, `routes-test-support.ts`, `silent-logger.ts`, `test-config.ts`. Check here before writing new fakes.

To run a single named test, pass `-t`:
```bash
pnpm --filter @cogniplane/backend exec vitest run -t "write_artifact" apps/backend/src/services/managed-tools/factory.test.ts
```

## Frontend (`apps/frontend/`)

The app frontend is a Next.js 16 app. It can be deployed to any host that supports Next.js (Cloudflare Workers via `@opennextjs/cloudflare`, Vercel, a Node container, etc.).

### Auth mode

- `NEXT_PUBLIC_DEV_USER_ID` set → dev-headers mode (no real auth, bypasses WorkOS)
- `NEXT_PUBLIC_DEV_USER_ID` unset → WorkOS JWT mode (production)
- Do NOT set `NEXT_PUBLIC_DEV_USER_ID` in production builds

### Middleware

- Auth guard lives in `src/middleware.ts` (NOT `proxy.ts` — Next.js 16 uses `proxy.ts` for Node.js runtime only)
- Public-path allowlist (`/login`, `/auth/callback`) is hard-coded inline; everything else either has a session-hint cookie or is redirected to `/login`
- Next.js 16 middleware runs on the Workers runtime under `@opennextjs/cloudflare`; no explicit `runtime` export is needed (and `proxy.ts` does not support a runtime config at all)

### WorkOS SSO cookie (cross-domain deployments)

If your frontend and backend are on different domains, the refresh cookie must use `SameSite=None; Secure=true` — without it, browsers silently reject the cookie on cross-site requests. The cookie is scoped to the **backend domain**, so the frontend middleware cannot read it; route protection on the frontend is handled client-side by `auth-guard.tsx`.

### Auth callback handoff

The callback page calls `completeLogin(accessToken)` (`auth-context.tsx`) and **awaits** it before `router.replace("/")` — `completeLogin` synchronously sets the in-memory access token and runs `/auth/me` to populate the user, so by the time we navigate the AuthProvider is already populated. `AuthProvider` is mounted in the root layout above the route, so `router.replace` does not remount it; there is no `/auth/refresh` race on this path. The backend auth middleware uses an explicit `publicAuthPaths` allowlist (login/callback/refresh/logout, GitHub install + user callbacks) in `apps/backend/src/lib/auth-workos.ts`.

### Auth callback page

Must export `export const dynamic = "force-dynamic"` to prevent edge hosts from serving a prerendered static version (which would prevent the `useEffect` from running).

## E2B template

`docker/template.ts` defines the **Deep Agents code-execution template** (name `deep-agents-runtime-dev`) using the v2 E2B Template SDK. The agent loop runs in the backend, so the template is deliberately a dumb code-execution box: the stock `e2bdev/base` image plus Python 3 with a pinned knowledge-worker data stack (pandas, openpyxl, matplotlib, jinja2), ripgrep/sqlite3/git, and a prepared `/home/user/workspace` — **no agent CLIs or SDKs**.

`make e2b-build` runs `docker/build.ts`. Building under the existing template name **updates it in place**, preserving the template id; the resulting id is wired via `E2B_TEMPLATE_ID` (env — the config default is a placeholder that fails boot with a clear error). To cut over to a new template, build under a different name, verify, then point `E2B_TEMPLATE_ID` at it; old template ids stay in your E2B account so rollback is an env change.

Session workspaces live at `/home/user/workspace/<sessionId>/`. Sandboxes are created lazily per session (first shell/file tool use) and killed on session teardown.

## Docs

Public documentation:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — deeper architecture reference
- [docs/SECURITY_FEATURES.md](docs/SECURITY_FEATURES.md) — security model overview
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — release notes
- [docs/DECISIONS.md](docs/DECISIONS.md) — key architectural decisions
- [docs/guides/skill-bundle-decisions.md](docs/guides/skill-bundle-decisions.md) — skill bundle architecture decisions
- [docs/overlays.md](docs/overlays.md) — writing an overlay (add tools, integrations, routes without forking core)
- [deepagentsjs API reference](https://reference.langchain.com/javascript/deepagents) — the library the runtime is built on
