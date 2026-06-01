# Change Log

Date-based project history while Cogniplane has no formal versioning.

How to update this file:
1. Add a new section at the top using `## YYYY-MM-DD`.
2. Summarize at the feature level, not commit-by-commit. One bullet per shipped outcome, even if it took ten commits.
3. Group bullets under `Added`, `Changed`, `Fixed`, or `Docs` when helpful.
4. Each bullet should be understandable to someone who didn't read the code or PRs.
5. Skip low-signal internal cleanup unless it matters to the audience.

## 2026-05-31

Changed

- Simplified Policy Center around four condition dimensions (`toolNames`, `categories`, `severities`, `turnContexts`) and three effects (`allow`, `require_approval`, `block`). Removed connector/role/PII conditions, transform rules, coverage rollups, and the redundant policy-level `auto_approve` effect.
- Moved Policy Center from per-rule monitor/enforce behavior to tenant-level `policy_enforcement_mode`, snapshotted into each runtime tool context so gateway decisions do not need a hot-path settings read.
- Kept native runtime approvals separate from Policy Center approvals while routing both through the same approval events and decision endpoint.

## 2026-04-25

Added

- `tenant_integrations` admin surface (`/admin/integrations`) replaces ad-hoc per-integration toggles with a single per-tenant store. Lists 13 registered integrations (Notion, GitHub, Microsoft, plus 10 coming-soon), supports per-integration reads/writes/config, invalidates running runtimes on state change, and hides settings nav for non-enabled providers.
- Notion as a per-user OAuth integration with six managed tools (`notion_search`, `notion_fetch_page`, `notion_query_database`, `notion_create_page`, `notion_update_page`, `notion_append_blocks`). Reads auto-approve via the existing capability flag; writes flow through the approval coordinator.
- Tenant-scoped session review panel under `/admin/sessions` with list filters, alert badges (PII / approvals / errors), saved-view presets, "Load more" pagination, and per-session investigation tabs (Overview / Alerts / Approvals / Tools / Artifacts / PII / Audit / Raw) plus PII annotations in the read-only chat replay.
- Inline skill editing in admin: "Paste SKILL.md" tab and Edit-as-new-revision flow for single-file skills. Single-file zip and GitHub imports auto-promote to inline storage; multi-file bundles stay read-only. Inherited (system) skills surface as read-only.
- Deployed-version indicator (sha + build date) for backend and frontend in the sidebar, sourced from `/health` and Next.js build-time env vars.
- Skill bundle persistence to S3 (`SKILL_BUNDLE_STORAGE_BACKEND=bucket`) so revisions survive ECS task replacement; bundles materialize on demand into a content-addressed local cache.
- Auto-titling for new sessions: first user message triggers a fire-and-forget call to a cheap model (Haiku for Claude, gpt-5.4-nano for Codex) for a 3–6 word title.

Changed

- Codex runtime → `0.125.0`, Claude Agent SDK → `0.2.119`. Pre-warmed Claude SDK subprocess at session bootstrap (~20× faster first turn) and disabled the SDK's redundant internal title generation.
- Frontend migrated from `@cloudflare/next-on-pages` to `@opennextjs/cloudflare` (`cf:build` + `wrangler deploy`).
- Backend and frontend Docker images on `node:24-trixie-slim`; minimum Node engine bumped to `>=24.0.0`.
- Refactored largest backend modules (`runtime-manager`, `claude-code-runtime-adapter`, `tool-broker`) into focused units; introduced shared `@cogniplane/shared-types`; migrated frontend hooks from manual `useState` + polling to TanStack Query.
- "Remember for turn" approval option auto-approves the same tool kind for the rest of the turn; approval retry idempotency in the decision route.

Fixed

- `/models` render loop in chat shell (unstable dependency was retriggering ~10×/sec).
- Claude tool-call rendering parity with Codex: tool cards show streamed args, completion state, exit code, duration, real Bash/Shell command line.
- Multi-step turns now stay in `streaming` until final `response.completed/failed` (no more premature completion pill on first token of a multi-block Claude turn).
- E2B JS SDK's 60s background-command timeout was killing the codex/claude stdio bridge mid-turn — disabled.
- Hardened skill bundle imports against malformed inputs.
- Backend Docker image includes `@cogniplane/shared-types` (was failing on `TS2307`).

## 2026-04-23

Changed

- Security review pass (S1–S11): tightened approval ownership against IDOR, required non-default JWT secret + separate `DATA_ENCRYPTION_SECRET` in production auth, verified upload magic bytes vs. declared MIME, dual-encoded `Content-Disposition` filenames per RFC 5987, switched Claude MCP URLs to header-only auth (no `?token=` in URL), added SSRF deny list for private/reserved IPs, added `pnpm audit --audit-level=high --prod` to deploy workflows. Bumped Fastify, Next.js, AWS SDK, multipart, Claude Agent SDK, WorkOS SDK, TypeScript, React, and others.

## 2026-04-22

Added

- Skill revisions previewable from admin UI (text with syntax highlighting, markdown, inline images, CSV table for first 100 rows), capped at 1 MB.
- HTML artifacts render inline via sandboxed `srcdoc` iframe instead of source code.
- Pre-installed `pandas` and `jinja2` in the E2B sandbox image.

Changed

- E2B template build migrated to v2 Template SDK; unified `agent-runtime-dev` template builds in place.

## 2026-04-20

Added

- Admin UI to edit org skill marketplace manifest URL — orgs can repoint marketplace at their own `marketplace.json` without redeploy.

Changed

- Consolidated Claude Code runtime on the in-process Agent SDK; removed the E2B Claude CLI execution path. Fixed several issues that blocked managed MCP tools — most notably stripping an invalid top-level `outputSchema` on `tools/list` that caused the SDK's MCP client to silently drop every managed tool.

## 2026-04-19

Added

- Three-tier `toolContextId` resolution in MCP gateway (call args / URL token / session fallback) so managed tools work across Codex runtime, Claude Agent SDK, and Claude CLI in E2B without leaking per-turn state.

Fixed

- Several Claude-runtime regressions around managed tools: pass `--allowedTools` so MCP tools are first-class, set `--strict-mcp-config`, disable SDK's tool search to keep MCP tools visible, preserve session memory across turns by reusing the runtime session in `createSession`, accept GET/DELETE on `/mcp/:serverId` (responding 405) so Streamable HTTP clients fall back to POST-response mode.
- Folded Claude cache-read and cache-creation tokens into the `inputTokens` total for cost calc; registered Opus / Sonnet / Haiku pricing tiers.

## 2026-04-18

Changed

- v2 visual pass across workspace, admin, and settings: redesigned sidebar (pin/attention/busy signals), restyled header/messages/tool-cards/approval-dock, new composer, brand-glyph empty state with tagged suggestions, tabbed right panel split between Context and Artifacts. Admin and settings share unified navigation, card layout, primitives.
- Polished admin token usage chart, split scheduled jobs form and queue into separate cards, redirected `/admin` and `/settings` to overview subroutes.

Fixed

- Dark-mode contrast on several screens.

## 2026-04-17

Added

- **Organization-level PII protection.** Tenants configure detect / block / transform behavior for chat prompts, uploaded files, and Microsoft imports. Detection runs through a new orchestration layer backed by an OpenRouter LLM provider and a rule-based fallback, with persistence for both message and artifact findings and an async scan worker for queued jobs.
- **Claude Code runtime as a first-class provider** alongside Codex, including reasoning and plan streaming and per-tenant Anthropic API keys.

Changed

- Replaced `RuntimeAdapterRegistry` with a plain record.

Fixed

- Claude runtime in E2B mode bypasses permissions correctly; MCP servers in `.mcp.json` use the right `"http"` type.
- Backend image builds multi-arch and requires E2B Claude template to be set explicitly.

## 2026-04-15

Changed

- **Replaced capability profiles with a single tenant policy surface** in the admin area, collapsing several overlapping configuration concepts into one model.

## 2026-04-14

Added

- Smart auto-scroll and one-click session copy in the workspace.
- Session artifacts now sync to the sandbox workspace at the start of each turn so Codex can read PDFs, images, and other files natively through the filesystem.

## 2026-04-13

Added

- Restored `write_artifact` managed MCP tool for E2B sandbox compatibility, wired into capability profiles with per-tool authorization, plus `filePath` support for placing generated files at specific workspace paths.

Changed

- Simplified and optimized backend hot paths.

Fixed

- E2B runtimes auto-restart on process death and surface exit diagnostics instead of silently stalling.
- Disabled Codex `shell_snapshot` in E2B (unsupported there).
- Enforced tenant boundary on artifact download route.
- Microsoft file selector search results scrolling.

## 2026-04-12

Added

- E2B sandboxed runtime support, including MCP server discovery inside sandboxes (dual config in workspace `codex.toml` and global `~/.codex/config.toml`).
- Auto-approve `mcpServer/elicitation/request` events from Codex 0.120.

Changed

- Codex runtime + generated app-server contract: `0.118.0` → `0.120.0`. Aligned backend Docker and local compose pins.
- Managed MCP tools advertise `outputSchema` for newer Codex runtimes.
- Runtime tokens embedded in MCP server URLs (Codex Streamable HTTP transport doesn't reliably send `Authorization` headers on `initialize`).
- `/.well-known/` OAuth discovery returns 404 instead of 401, preventing Codex from entering the OAuth flow when static Bearer tokens are intended.
- Removed `trusted-echo` from phase 4 capability profile.

Fixed

- MCP server discovery in E2B sandboxes.
- Runtime MCP token lifetime aligned to full session duration.
- MCP elicitation response format: `action: "accept"` (not `decision`/`allow`).

## Pre-April 2026 (build-out summary)

The pre-April history covered the initial product build-out. Highlights:

- **Codex runtime + streaming SSE chat** (mid-March): initial app shell, runtime transport, chat state management, containerized dev, smoke tests. Codex `0.118.0` runtime integration with capability-profile `developerInstructions`.
- **Approval system + MCP gateway**: pause-for-approval on flagged tool calls; first artifact workflow; first admin config for skills, MCP servers, and capability profiles. Request limits, on-demand PDF processing.
- **Skill bundle rollout**: AgentSkills bundle architecture, zip + GitHub imports, revision activation APIs, admin review UI, provenance display, runtime manifest typing. Refocused PRD around bundle-backed skills.
- **Multi-tenancy and security**: tenant-aware auth + Postgres RLS, OpenAPI route docs, custom domains.
- **Project rename**: Enterprise Agent Framework → Cogniplane. Consolidated 19 migrations into a single initial schema.
- **Scheduler**: run-history workflow with worker service, lifecycle wiring, history UI.
- **Editorial UI direction**: workspace shell aligned with the editorial design, typography and theme controls.
- **Token usage + cost tracking**: per-turn token visibility in UI, persisted usage and cost. Token usage dashboards in admin and personal settings.
- **Model selection**: models API + UI selector + saved preference. Default model `gpt-5.4-mini`. Per-tenant OpenAI API key configuration.
- **Deployment**: first production deployment + marketing site. Branding refresh.
- **Auth hardening**: WorkOS login flow with cross-site refresh-token cookie handling, auth-callback race fix, `/auth/me` middleware fix.
- **Workspace artifact sweep**: post-turn workspace sweep replaces the earlier explicit write tool. Broader MIME allowlist.
- **GitHub managed tools**: `github_read_file`, `github_write_file`, `github_create_pr` via the user's connected GitHub account. GitHub App integration replaces OAuth flow.
- **Per-org private skill marketplace**: tenants configure custom manifest URL fetched via the org's GitHub installation token. SSRF-safe (HTTPS-only, public schemes rejected).
- **Beta gating + token usage**: tester access control, published/draft states for skills and MCP servers.
- **Inline preview + thumbs feedback**: inline preview for text/code/markdown/images/PDFs/CSVs; thumbs up/down ratings on assistant messages with per-model breakdown.
