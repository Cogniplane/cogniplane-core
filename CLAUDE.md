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

make e2b-build-codex    # build Codex E2B sandbox template
make e2b-build-all      # build all supported E2B templates
```

Backend: `http://localhost:3001` — Frontend: `http://localhost:3000` — Admin workbench: `http://localhost:3000/admin`

## Architecture Overview

This is a **multi-tenant agent platform** built as a pnpm workspace:

- `apps/backend` — Fastify API (ESM TypeScript, `tsx` for dev/tests)
- `apps/frontend` — Next.js 16 UI
- `packages/shared-types` — shared schema/contract types consumed by both apps

### Request → Runtime → SSE flow

1. `POST /messages` (`routes/messages.ts`) validates input, enforces rate limits and quotas, then calls `streamAssistantReply` (`services/sse-stream-writer.ts`).
2. `streamAssistantReply` hijacks the raw socket, sets SSE headers, creates a `ToolExecutionContext` (short-lived per-turn credential carrier), and calls `runtimeManager.runMessage`.
3. `CodexRuntimeManager` (`services/runtime-manager.ts`) lazily starts a `codex app-server` child process per session (`services/codex-runtime-process.ts`), creates or reuses its workspace, and returns an `AsyncIterable<RuntimeEvent>`.
4. Codex events are normalized to `RuntimeEvent` via `runtime-notification-mapper.ts` and streamed as SSE to the browser. Assistant text and tool results are persisted incrementally to the `messages` table.

The platform supports two runtime providers. `routes/messages.ts` receives a `runtimeAdapters: Partial<Record<RuntimeProvider, RuntimeAdapter>>` map and `resolveRuntimeProviderAndModel` (`services/runtime/runtime-provider-resolver.ts`) picks the right adapter based on the tenant's `runtimeProvider` setting.

### Runtime workspace generation

When a session runtime starts, `createRuntimeWorkspace` (`services/runtime-workspace.ts`) materializes:
- `codex.toml` — MCP server URLs derived from the tenant's `tenant_settings` (enabled tools + MCP servers)
- `.codex/skills/<id>/SKILL.md` — one file per enabled skill; copied from `bundle_root_path` when set, otherwise written inline from `metadata->>'instructions'`
- `.framework/runtime-manifest.json` — versioned snapshot of the full config bundle

Config is compiled from Postgres by `DynamicConfigService` (`services/dynamic-config-service.ts`).

### Claude Code runtime

When `runtimeProvider = "claude-code"`, the platform uses `ClaudeCodeRuntimeAdapter` instead of `CodexRuntimeManager`.

**Two execution modes**, selected by `CLAUDE_RUNTIME_BACKEND` (default: `local`). `RUNTIME_BACKEND` controls Codex; `CLAUDE_RUNTIME_BACKEND` controls Claude — they're independent knobs.

| Mode | Where the SDK runs | When to use |
|---|---|---|
| `local` | `@anthropic-ai/claude-agent-sdk` `query()` in the backend process | Local dev, regional fallback, or tenants where sandbox isolation is unnecessary |
| `e2b` | The SDK runs inside the shared `agent-runtime` E2B sandbox, driven by `docker/sandbox-agent/sandbox-agent.mjs` (a Node harness bundled into the template) | **Default for production.** Sandbox-isolated file access and command execution, same posture as Codex. |

The same `agent-runtime` E2B template (`E2B_TEMPLATE_ID`) hosts **both** the Codex `app-server` and the Claude sandbox-agent harness — they're independent processes that share the workspace filesystem. This makes future per-turn model switching possible without rebuilding the template.

**Event + approval flow is identical in both modes.** `claude-code-event-mapper.ts` consumes typed `SDKMessage`s whether they arrive from `query()` directly (local) or over stdio from the harness (e2b). Approvals bridge through `canUseTool` in both paths — in e2b mode the `canUseTool` Promise lives inside the harness, and decisions round-trip as `approval_request` / `approval_response` frames (see `apps/backend/src/services/sandbox-agent-protocol.ts`).

**Workspace generation:** `claude-workspace-renderer.ts` generates `CLAUDE.md`, `.mcp.json`, and `.claude/commands/<name>.md` from the same compiled admin config used by Codex. In local mode the files land under `RUNTIME_WORKSPACE_ROOT/<runtimeId>/`; in e2b mode they're staged locally then uploaded to `/home/user/workspace/<sessionId>/` inside the sandbox.

**Key files:**
- `claude-code-runtime-adapter.ts` — `RuntimeAdapter` implementation, branches on `CLAUDE_RUNTIME_BACKEND`
- `claude-code-event-mapper.ts` — `SDKMessage` → `RuntimeEvent` (used in both modes)
- `claude-code-approval-handler.ts` — `canUseTool` ↔ deferred promise bridge (local mode only)
- `claude-workspace-renderer.ts` — workspace file generation; in e2b mode the renderer writes to a local staging dir tracked on the adapter state (`localStagingPath`) before upload
- `e2b-claude-runtime-process.ts` — creates the sandbox, uploads the staged workspace, and runs a long-lived stdio bridge to the in-sandbox harness (e2b mode)
- `sandbox-agent-protocol.ts` — newline-delimited JSON frame types exchanged with the harness
- `docker/sandbox-agent/sandbox-agent.mjs` — the harness itself (runs inside the E2B sandbox)

### MCP gateway and managed tools

`/mcp/:serverId` (`routes/mcp.ts`) receives JSON-RPC 2.0 from the Codex runtime. Two modes:
- **managed** — tool call dispatched to `createManagedToolDefinitions` in `services/managed-tools/factory.ts`. The `MANAGED_TOOL_CATALOG` (in `services/managed-tools/catalog.ts`) aggregates per-domain catalogs from `services/managed-tools/`: session tools (`session_context`, `list_artifacts`, `read_text_artifact`), `write_artifact`, GitHub tools, and Notion tools.
- **proxy** — forwarded to an upstream URL with framework context headers injected.

Every tool call requires a `toolContextId` resolved against `ToolExecutionContextStore`. The context carries `userId`, `sessionId`, `runtimeId`, and a snapshot of the tenant's effective runtime config (compiled from `tenant_settings`) — the model never sees credentials directly.

Tool results are passed through `redactSecrets()` (`services/redact-secrets.ts`) before persistence to strip auth headers and tokens from the audit trail.

### Approval flow

When `tenant_settings.approval_policy = "require-approval"` (or equivalent JSON form), the Codex runtime pauses before executing flagged tool calls. `RuntimeApprovalCoordinator` (`services/runtime-approval-coordinator.ts`) intercepts the JSON-RPC request, holds it in memory, and emits an `approval_requested` SSE event to the frontend. The frontend calls `POST /approvals/:approvalId/decision` with body `{ decision: "approve" | "reject", rememberForTurn?: boolean }` (`routes/approvals.ts`), which unblocks the paused runtime turn. The Codex `runtimeManager.resolveApproval` is tried first; if it returns `"missing"` the request falls through to the optional Claude resolver. `tenant_settings.auto_approve_read_only_tools` bypasses approval entirely for read-only tools.

Pending approvals carry a wall-clock TTL (`APPROVAL_REQUEST_TTL_MS`, default 10 min). On expiry: Codex sends a synthetic `reject` to the runtime process so it unblocks, the DB row moves to `status='expired'`, an `approval.expired` audit event is written, and a `framework:runtime_notice` (level `warning`, `noticeId = approval-expired:<approvalId>`) is pushed to the active turn so the frontend can clear the prompt. Claude's `ClaudeApprovalHandler` runs the same TTL on its `canUseTool` Promise (resolves with `deny`).

### Scheduler

A background worker (`services/scheduler-worker.ts`) polls `scheduled_jobs` every `SCHEDULER_POLL_INTERVAL_MS` (default 30s), claims due jobs atomically, and runs them as synthetic agent turns. Results land in `scheduled_job_runs`. Controlled by `SCHEDULER_ENABLED`, `SCHEDULER_MAX_CONCURRENT_JOBS`, `SCHEDULER_JOB_TIMEOUT_MS`.

### Admin config (skills, MCP servers, tenant settings)

Runtime constraints (enabled tools, enabled MCP servers, approval policy, etc.) live in **one row per tenant** in `tenant_settings`. There is no separate per-profile concept.

Three admin entities, all tenant-scoped with `tenant_id = 'system'` for platform defaults:

| Entity | Store | Key behavior |
|--------|-------|--------------|
| Skills | `SkillConfigStore` + `SkillRevisionStore` | `instructions` lives in `revision.metadata->>'instructions'` (NOT a column). Revisions must have `skillName`, `description`, and `instructions` in metadata to be activatable. Skills with `bundle_root_path = NULL` use inline instructions. |
| MCP servers | `McpServerStore` | Mode is `managed` or `proxy` |
| Tenant settings | `TenantSettingsStore` (`tenant-settings-store.ts`) | One row per tenant. Controls `enabledToolIds`, `enabledMcpServerIds`, `approvalPolicy`, `approvalReviewer`, `autoApproveReadOnlyTools`, `allowCommandExecution`, `allowUserTokenForwarding`, `developerInstructions`, `runtimeProvider` (`"codex"` or `"claude-code"`), `enabledRuntimeProviders`, and `showEffortSelector`. The `system` tenant's row acts as the platform default. |

### Multi-tenancy and database access

Every store method takes `tenantId` as its first argument. All queries run inside `withTenantScope(db, tenantId, fn)` (`lib/db.ts`), which sets `SET LOCAL app.current_tenant_id` and activates PostgreSQL Row-Level Security. Migrations run as superuser and bypass RLS. The migration runner is `src/scripts/migrate.ts`.

Two DB pools exist in production:
- `db` — `app_user` (non-superuser, subject to RLS)
- `privilegedDb` — superuser, used only for `getDownloadToken` and migration

### Authentication

`AUTH_MODE`: `dev-headers` (reads `X-User-Id`/`X-Tenant-Id` headers — local development only) or `workos` (JWT 15min + httpOnly refresh cookie, Redis jti revocation). Auth middleware: `lib/auth-middleware.ts`. Route-level elevation: `requireRole(request, 'admin' | 'owner')`.

Claude Code runtime requires `ANTHROPIC_API_KEY` to be set. When absent, only the Codex provider is available. The key is injected into the Claude Agent SDK environment.

### Artifact pipeline

Artifacts live in the `artifacts` table. Download requires a short-lived token (`POST /artifacts/:id/download-token` → `GET /downloads/:token`); `getDownloadToken` uses `privilegedDb` to bypass RLS.

**Workspace sync:** At the start of each turn, scoped artifacts are downloaded from object storage and written to `./artifacts/` in the sandbox workspace so Codex can read them natively (PDFs, images, etc.). Files persist across turns for the lifetime of the sandbox — **do NOT clean `./artifacts/` between turns**.

**Artifact checkbox scoping (important):** The frontend lets users select artifacts via checkboxes when sending a message (`artifactIds` in `POST /messages`). This controls which artifacts appear in the turn's prompt context — it is a **UI convenience**, not a security boundary. The agent always has filesystem access to all previously synced artifacts in `./artifacts/`. Do not treat `artifactIds` as an access control mechanism or delete unselected artifacts from the workspace. The checkbox simply tells the agent "I'm referring to these files in this message."

### Skill pipeline — critical data flow

When adding or modifying skills, trace this full chain:

```
SKILL.md body → validateSkillBundle → buildSkillImportPayload
  → importSkillBundle (merges skillName/description/instructions INTO metadata JSONB)
  → activateSkillRevision (reads metadata.skillName + metadata.instructions — fails if absent)
  → compileRuntimeConfig → createRuntimeWorkspace → .codex/skills/<id>/SKILL.md
```

The `write-artifact` skill (seeded in `002_seed_write_artifact_skill.sql`) instructs the agent to call the `write_artifact` managed tool for generated files.

### Skill bundle storage

Skill bundles (zipped `SKILL.md` + companion files) have two storage backends, chosen by `SKILL_BUNDLE_STORAGE_BACKEND` and wired in `services/skill-bundle-storage.ts`:

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
CODEX_VERSION          # pinned codex version — bump deliberately, not casually
CODEX_SCHEMA_VERSION   # codex app-server protocol version (default: v2)
RUNTIME_GATEWAY_BASE_URL  # URL the codex runtime uses to reach /mcp — must be reachable from the codex process (default: http://localhost:3001)
ARTIFACT_STORAGE_BACKEND  # local | bucket — bucket uses S3-compatible API; set ARTIFACT_BUCKET_* accordingly
SKILL_BUNDLE_STORAGE_BACKEND  # local | bucket — bucket tars bundles into S3 and materializes on demand
SKILL_BUNDLE_BUCKET_NAME      # required when backend=bucket; reuses ARTIFACT_BUCKET_* creds
SKILL_BUNDLE_BUCKET_PREFIX    # optional S3 key prefix
SKILL_BUNDLE_CACHE_ROOT       # local extraction cache root (default: <os.tmpdir()>/cogniplane-skill-cache)
MIGRATION_DATABASE_URL    # superuser URL; bypasses RLS — only used by migrate.ts
REDIS_URL              # optional; without it, rate limits are per-process (not shared across instances)
AUTH_MODE              # dev-headers reads X-User-Id/X-Tenant-Id headers — never use in production
ADMIN_USER_IDS         # comma-separated; only applies in dev-headers mode
ANTHROPIC_API_KEY          # required for Claude Code runtime; without it, only Codex is available
CLAUDE_CODE_MODEL          # default Claude model (default: "sonnet")
CLAUDE_RUNTIME_BACKEND     # local (in-process Agent SDK) | e2b (in-sandbox harness) — default: local
CLAUDE_AGENT_SDK_VERSION   # pinned Agent SDK version for diagnostics; defaults from codex-release.json
E2B_TEMPLATE_ID            # the unified agent-runtime template ID; hosts both Codex and the Claude harness
PII_PROVIDER_ENABLED       # opt-in switch for the PII detection provider; validates config at boot when true
PII_OPENROUTER_API_KEY     # API key for the configured PII detection model provider — supply whatever provider you want via the env-var contract
PII_OPENROUTER_MODEL       # default: "google/gemini-2.5-flash" (see config.ts comment for retention posture)
PII_PROVIDER_TIMEOUT_MS    # sync-path budget for detect/transform; default 5000ms
PII_RETENTION_KEK          # 32-byte hex (openssl rand -hex 32); required when any tenant uses rawRetention='reversible_encrypted' — without it, that mode throws pii_kek_missing rather than silently downgrading. Per-tenant DEKs derived via HKDF-SHA256(KEK, salt=tenantId).
```

**PII detection — bring your own model.** The PII detection pipeline is a generic "send-text-to-an-LLM-for-detection" path parameterized by the `PII_*` env vars. You configure whatever model provider you want — the logging and retention posture is whatever your chosen vendor provides. See `apps/backend/src/config.ts` for the full env-var contract.

## Testing

Backend and frontend tests use **Vitest**. Test files colocate with the service they test (`*.test.ts` / `*.test.tsx`). Use `expect` from `vitest` for assertions and `vi.fn()` / `vi.spyOn()` for mocks. Hand-rolled in-memory fakes (constructed with full store types) are still the default for store-level testing — there is no test database; integration-style tests stub the store layer. Coverage runs via `vitest run --coverage` with a v8 provider.

Shared test infrastructure lives in `src/test-helpers/`: `fake-database.ts`, `in-memory-audit-events.ts`, `mcp-route-test-support.ts`, `phase4-runtime-policy.ts`, `routes-test-support.ts`, `silent-logger.ts`, `test-config.ts`. Check here before writing new fakes.

To run a single named test, pass `--test-name-pattern`:
```bash
pnpm --filter @cogniplane/backend exec vitest run -t "write_artifact" apps/backend/src/services/managed-tools/factory.test.ts
```

## Frontend (`apps/frontend/`)

The app frontend is a Next.js 16 app. It can be deployed to any host that supports Next.js (Cloudflare Workers via `@cloudflare/next-on-pages`, Vercel, a Node container, etc.).

### Auth mode

- `NEXT_PUBLIC_DEV_USER_ID` set → dev-headers mode (no real auth, bypasses WorkOS)
- `NEXT_PUBLIC_DEV_USER_ID` unset → WorkOS JWT mode (production)
- Do NOT set `NEXT_PUBLIC_DEV_USER_ID` in production builds

### Middleware

- Auth guard lives in `src/middleware.ts` (NOT `proxy.ts` — Next.js 16 uses `proxy.ts` for Node.js runtime only)
- Public-path allowlist (`/login`, `/auth/callback`) is hard-coded inline; everything else either has a session-hint cookie or is redirected to `/login`
- Next.js 16 middleware runs on the Edge runtime by default under `next-on-pages`; no explicit `runtime` export is needed (and `proxy.ts` does not support a runtime config at all)

### WorkOS SSO cookie (cross-domain deployments)

If your frontend and backend are on different domains, the refresh cookie must use `SameSite=None; Secure=true` — without it, browsers silently reject the cookie on cross-site requests. The cookie is scoped to the **backend domain**, so the frontend middleware cannot read it; route protection on the frontend is handled client-side by `auth-guard.tsx`.

### Auth callback handoff

The callback page calls `completeLogin(accessToken)` (`auth-context.tsx`) and **awaits** it before `router.replace("/")` — `completeLogin` synchronously sets the in-memory access token and runs `/auth/me` to populate the user, so by the time we navigate the AuthProvider is already populated. `AuthProvider` is mounted in the root layout above the route, so `router.replace` does not remount it; there is no `/auth/refresh` race on this path. The backend auth middleware uses an explicit `publicAuthPaths` allowlist (login/callback/refresh/logout, GitHub install + user callbacks) in `apps/backend/src/lib/auth-workos.ts`.

### Auth callback page

Must export `export const dynamic = "force-dynamic"` to prevent edge hosts from serving a prerendered static version (which would prevent the `useEffect` from running).

## E2B Runtime + MCP Server Integration

**One unified template, two runtimes.** `docker/template.ts` defines the `agent-runtime-dev` template using the v2 E2B Template SDK (ID sourced from `apps/backend/src/codex-release.json` → `e2bTemplateId`, exposed as `E2B_TEMPLATE_ID`). It installs:
- `@openai/codex` CLI (for the Codex runtime, via `codex app-server --listen stdio://`)
- `@anthropic-ai/claude-agent-sdk` (globally, so the harness can `require()` it via `NODE_PATH=/usr/lib/node_modules`)
- `docker/sandbox-agent/sandbox-agent.mjs` copied to `/opt/cogniplane/sandbox-agent.mjs`

`make e2b-build` runs `docker/build.prod.ts`, which calls `Template.build(template, 'agent-runtime-dev', …)`. Building with the existing template name **updates it in place**, preserving `e2bTemplateId`. Both runtimes share the same sandbox image and filesystem layout (`/home/user/workspace/<sessionId>/`). Version pins (`codexVersion`, `claudeAgentSdkVersion`) are imported from `codex-release.json` by `template.ts` so drift between the pinned version and the installed version is impossible by construction.

**Template-ID rollback path.** `codex-release.json.e2bTemplateId` is the single source of truth. To cut over to a new template: build under a different name in `build.prod.ts` temporarily, update `e2bTemplateId` once verified, and redeploy. Old template IDs stay in the E2B account so rolling back is a git revert + redeploy.

Codex-specific operational notes:
- MCP server config must be in **both** the workspace `codex.toml` and the global `~/.codex/config.toml` for E2B sandboxes — `e2b-runtime-process.ts` handles this via `extractMcpServersToml()`
- Runtime tokens are embedded in MCP server URLs as `?token=rt_...` because Codex Streamable HTTP transport doesn't send `Authorization` headers on the `initialize` POST
- `/.well-known/` paths must return 404 (not 401) — Codex probes these for OAuth before connecting to MCP servers
- `mcpServer/elicitation/request` is auto-approved with `{ action: "accept" }` in `runtime-request-handler.ts` — valid values are `accept`/`decline`/`cancel` (not `allow`, not `decision`)
- After bumping `CODEX_VERSION`: rebuild E2B template, update `E2B_TEMPLATE_ID` in your deployment environment, run `pnpm codex:release:check`

Claude-specific operational notes (applies when `CLAUDE_RUNTIME_BACKEND=e2b`):
- The backend does NOT invoke the `claude` CLI — that approach forced `--dangerously-skip-permissions` because headless `claude -p` has no stdio hook for `canUseTool`. Instead, `sandbox-agent.mjs` loads the Agent SDK and speaks newline-delimited JSON over stdio. HITL approvals work identically to local mode.
- MCP servers reach the harness through the SDK's `mcpServers` option (NOT a `.mcp.json` file read) — the staged `.mcp.json` is retained for developer visibility but not consulted by the harness
- The harness emits `ready` on startup with its SDK + Node versions; `E2bClaudeRuntimeProcess` logs it for diagnostics
- `toolContextId` is threaded per turn via the `turn` frame and injected into managed MCP tool inputs inside the sandbox (mirrors `ClaudeApprovalHandler.enrichInput`)
- After bumping the Claude SDK version: update `claudeAgentSdkVersion` in `apps/backend/src/codex-release.json`, `@anthropic-ai/claude-agent-sdk` in `apps/backend/package.json`, and rebuild the E2B template
- **MCP token transport (Claude vs Codex):** Claude MCP URLs do NOT carry `?token=rt_...` — the runtime token is delivered exclusively via `Authorization: Bearer rt_...` header (set in the SDK's `mcpServers` option and in `.mcp.json`). Codex still requires `?token=` in the URL because its Streamable HTTP transport does not forward `Authorization` headers on the `initialize` POST. Do not add `?token=` back to Claude URLs — the MCP gateway already accepts both paths, headers take priority.

## Docs

Public documentation:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — deeper architecture reference
- [docs/SECURITY_FEATURES.md](docs/SECURITY_FEATURES.md) — security model overview
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — release notes
- [docs/DECISIONS.md](docs/DECISIONS.md) — key architectural decisions
- [docs/guides/codex-integration.md](docs/guides/codex-integration.md) — Codex runtime integration
- [docs/guides/runtime-selection.md](docs/guides/runtime-selection.md) — choosing between Codex and Claude
- [docs/guides/skill-bundle-decisions.md](docs/guides/skill-bundle-decisions.md) — skill bundle architecture decisions
- [docs/overlays.md](docs/overlays.md) — writing an overlay (add tools, integrations, routes without forking core)
