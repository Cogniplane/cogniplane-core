# Security Features — Cogniplane Core

> **Audience:** Operators evaluating Cogniplane Core's security posture; contributors auditing the security model.
> **Scope:** Security control inventory for the Deep Agents runtime. References and selected historical claims were reconciled on 2026-10-11; this is not a complete security audit or proof of deployed configuration.
> **Companion doc:** `ARCHITECTURE.md`.

Inventory of security controls, defensive mechanisms, and isolation boundaries, grouped by domain. Each entry names the control, its location in code, and the relevant config.

---

## 1. Authentication

### 1.1 JWT access tokens
- **Format:** HS256-signed, 15-minute TTL.
- **Claims:** `sub`, `tid`, `role`, `email`, `kid`, `iat`, `exp`.
- **Signing:** `JWT_SECRET`; verified on every authenticated request.
- File: `apps/backend/src/lib/jwt.ts`.

### 1.2 Refresh tokens with reuse detection (RFC 6749 §10.4)
- **Format:** HS256 JWTs, 7-day TTL, carry `jti` and `fid` (family id).
- **Storage:** Redis — `refresh_jti:<jti>` → familyId, `refresh_family:<fid>` → `active|revoked`.
- **Rotation:** `jti` consumed atomically via `GETDEL`.
- **Replay defense:** concurrent refreshes can reuse the completed rotation result within a 60-second grace window. Reuse of a consumed `jti` after that window revokes the active family and forces re-auth.
- File: `apps/backend/src/lib/refresh-token-store.ts`.

### 1.3 Auth modes
| Mode | Behavior | Usage |
|---|---|---|
| `dev-headers` | Reads `X-User-Id` / `X-Tenant-Id` headers | Local dev only — rejected at boot when `NODE_ENV=production` |
| `workos` | Verifies WorkOS JWTs, looks up role from `tenant_memberships` | Production |

Files: `apps/backend/src/lib/auth.ts`, `apps/backend/src/lib/auth-workos.ts`, `apps/backend/src/config.ts`.

### 1.4 Public-path allowlist
- **Match:** exact, after stripping query string — defends against `/auth/login.attack` smuggling.
- **Allowed:** the static set `/auth/login`, `/auth/callback`, `/auth/refresh`, `/auth/logout`, plus the integration OAuth callback paths sourced from the integration registry (e.g. the GitHub user callback).
- Files: `apps/backend/src/lib/auth-public-paths.ts`, `apps/backend/src/lib/auth-workos.ts`.
- `GET /downloads/:token` is also public: the single-use token is the credential (see §10.1).
- **OAuth callbacks are bound to the browser that started the connect (GitHub and Notion).** Authorize sets a random nonce in an httpOnly cookie scoped to the callback path, and the signed state carries only its SHA-256. The callback requires the cookie, compares the hashes in constant time before it spends the single-use state `jti`, and clears the cookie. A provider URL sent to another person therefore cannot bind that person's account to the attacker's user. The cookie is `SameSite=None; Secure` for an https redirect URI, because the authorize call can be a cross-site fetch.

### 1.5 Frontend session-hint cookie
- **Cookie:** `cogniplane_session_hint=1`, Max-Age 7d, `SameSite=Lax`, `Secure` over HTTPS.
- **Role:** UI-only short-circuit for the redirect-to-login flow; not a credential.
- Files: `apps/frontend/src/lib/auth-context.tsx`, `apps/frontend/src/middleware.ts`.

### 1.6 Refresh cookie hardening
- **Cookie:** `cogniplane_refresh` — `httpOnly`, `Secure`, `SameSite=None`, scoped to backend domain.
- Frontend JS cannot read it; route protection is therefore handled by `AuthGuard`.

### 1.7 Access token storage
- **Storage:** held in React state (memory) only — never written to `localStorage` or `sessionStorage`, so no persistence surface for XSS to read; a page reload re-authenticates via the refresh cookie.
- File: `apps/frontend/src/lib/auth-context.tsx`.

### 1.8 JWT key id (`kid`) for forward-compatible rotation
- Every token stamped with `kid` (env `JWT_KEY_ID`, default `"default"`); enables future multi-key rotation without invalidating in-flight tokens.

---

## 2. Authorization

### 2.1 RBAC roles
- **Roles:** `owner`, `admin`, `member`, stored per-tenant in `tenant_memberships` and looked up on every authenticated request.
- File: `apps/backend/src/lib/auth-workos.ts`.

### 2.2 `requireRole` middleware
- `requireRole(request, reply, ...roles)` returns 403 on insufficient role.
- **Helpers:** `isElevatedRole`, `canManageTenant`, `canManageMembers`, `canAccessAdmin`.
- File: `apps/backend/src/lib/rbac.ts`.

### 2.3 Tenant membership enforcement
- A valid JWT alone is insufficient — the user must be a member of the target tenant or the request returns 403 `not_a_member`.

### 2.4 Frontend route guards
- `<AuthGuard requiredRoles={…}>` blocks render until auth is resolved; redirects unauthenticated users and renders an insufficient-permission state otherwise.
- File: `apps/frontend/src/lib/auth-guard.tsx`.

---

## 3. Multi-Tenancy & Isolation

### 3.1 Postgres Row-Level Security (RLS)
- **Coverage:** every tenant-scoped table has `ENABLE ROW LEVEL SECURITY` and a `USING (tenant_id = app.current_tenant_id)` policy.
- **Tables:** `sessions`, `messages`, `runtime_sessions`, `approvals`, `audit_events`, `tool_execution_contexts`, `artifacts`, `tenant_settings`, `policy_rule`, `policy_decision`, `pii_scan_runs`, `pii_scan_jobs`, `tenant_integrations`, all `user_*_connections`.

### 3.2 `withTenantScope`
- Tenant-scoped store methods take `tenantId` first and run inside `withTenantScope(db, tenantId, fn)`, which calls `set_config(..., true)` for the transaction. PostgreSQL policies enforce the tenant predicate in addition to route and store authorization.
- File: `apps/backend/src/lib/db.ts`.

### 3.3 Two database pools
| Pool | Role | Purpose |
|---|---|---|
| `db` | `app_user` (non-superuser) | All normal app queries — subject to RLS |
| `privilegedDb` | `maintenance_user`, BYPASSRLS without DDL authority | Authentication, claims, retention, recovery, provider-key reads, and token-authorized downloads |

### 3.4 Migration runner separation
- Runs as superuser via `MIGRATION_DATABASE_URL`, intentionally bypasses RLS.
- File: `apps/backend/src/scripts/migrate.ts`.

---

## 4. Sandboxing & Runtime Isolation

### 4.1 E2B sandbox isolation (Deep Agents code execution)
- The agent loop runs **in-process in the backend**; only shell/file tools execute inside a per-session E2B sandbox. The template (`docker/template.ts`, built by `make e2b-build`) is a dumb code-execution box — Python data stack, **no agent CLIs or SDKs, no secrets in the sandbox env**.
- **Lazy:** the sandbox is created on first shell/file tool use and memoized per session; chat-only sessions never create one. `allowCommandExecution=false` attaches no sandbox at all, so the `execute` tool is never exposed.
- **Workspace:** isolated per session at `/home/user/workspace/<sessionId>/`.
- **Network egress (default deny):** a sandbox has no network unless the tenant approves hosts (`approved_sandbox_egress_domains`, admin-editable, at most 25 exact host names or `*.` wildcards over a registered name). E2B enforces the policy on its side, so root in the guest cannot undo it. The network of a sandbox is fixed when it is created and is never changed afterwards. A sandbox is created under the policy as it is read from the tenant settings at that moment, and the provider reports the network back before any command runs. At the first use of each turn or job, and at a reconnect, one live read compares the sandbox with the policy as it is then, and a sandbox that differs, for example because the admin changed the list, is replaced with a notice. The old sandbox is killed with up to four tries, and the session lease is checked before each try. No command and no file operation runs in a sandbox that was not confirmed in the current turn, and none runs for a turn that ended, was cancelled, was replaced by the next one, or whose runtime was disposed. The creation request is sent once, and a report that has a setting that was not requested fails the check. Every provider request in a check has a timeout, failed reads are tried again, and one deadline covers the check. If the sandbox cannot be read in time, the call fails and the sandbox is kept. A change of the list applies at the next turn start, not inside a running turn. Limits: a replaced sandbox that cannot be killed after all tries is logged as an error and runs until the provider expires it, with the network that it was created with, and the lease check before a kill cannot be atomic with the kill request, so an owner whose kill is delayed can destroy a sandbox that the next owner adopted (the network stays restricted, and files that only existed in that sandbox are lost). Limits of the provider filter: it judges a web request by the host name it states, and while any host is approved, DNS works for every name. Details: the header comment of `sandbox-network-policy.ts`.
- **Guest privileges:** commands run as the unprivileged `user`. The template removes the stock image's passwordless `sudo` and empty root password in its start command, because E2B adds them back while it finalizes a template. Sandboxes from an older template keep the grant until `E2B_TEMPLATE_ID` points at a rebuilt one.
- Files: `apps/backend/src/services/deep-agents/deep-agents-e2b-backend.ts`, `apps/backend/src/services/runtime/sandbox-network-policy.ts`, `docker/template.ts`.

### 4.2 Workspace path validation
- All model-visible paths are remapped into the session workspace and confined by a shared traversal guard (`resolveInsideSandbox`); paths that escape the workspace return a structured error to the model instead of silently retargeting.
- File: `apps/backend/src/services/runtime/sandbox-path.ts`.

### 4.3 Sandbox + turn timeouts
- `E2B_SANDBOX_TIMEOUT_MS` (default 30 min) — hard sandbox lifetime cap.
- `DEEP_AGENTS_EXECUTE_TIMEOUT_MS` (default 2 min) — per-command ceiling inside the sandbox, with a 64k output cap.
- `RUNTIME_TURN_TIMEOUT_MS` (default 20 min) — turn watchdog; a wedged model/tool call aborts the graph run and frees the session slot. Disarmed while a human approval is pending.
- `RUNTIME_IDLE_TIMEOUT_MS` (default 5 min) — idle session teardown.

### 4.4 Per-session workspace identity
- Workspace dir keyed by session id; sandboxes are never shared across sessions.

---

## 5. Secrets Handling

### 5.1 `redactSecrets()` — redaction before persistence
Recursively sanitizes payloads before audit, message, or skill-corpus persistence.
- **Patterns:** `Authorization: Bearer …`, GitHub tokens (`gh_`, `ghp_`, `github_pat_`), PEM private keys (RSA / EC / ED25519 / PKCS#8), Anthropic (`sk-ant-…`) and OpenAI (`sk-…`) keys, AWS access keys (`AKIA` / `ASIA`), Slack tokens (`xox…`), Google API keys (`AIza…`), and any field whose key matches `/authorization|token|secret|api.?key|password/i`.
- **Credentials in URL query strings:** a query parameter with a credential name (`token`, `apiKey`, `api-key`, `key`, `secret`, `sig`, …) is redacted. Log sanitizing uses the same check, which covers every name that MCP URL validation refuses (`lib/sensitive-query-params.ts`).
- **MCP gateway responses:** before a tool response reaches the runtime or telemetry, the gateway removes the MCP server's upstream secret (personal or organization, raw and URL-encoded) from the result and error, but not from the JSON-RPC envelope or their own field names, and applies `redactSecrets()` to both the `result` and the JSON-RPC `error` envelope (`routes/mcp.ts`, `services/mcp/scrub-upstream-credential.ts`).
- File: `apps/backend/src/services/redact-secrets.ts`.

### 5.2 ToolExecutionContext — model-blind credential envelope
- Model receives an opaque `toolContextId`; backend resolves and injects credentials at the MCP gateway.
- **TTL:** `TOOL_CONTEXT_TTL_MS` (default 25 min), per-turn; boot validation pins it strictly above the turn watchdog so a long turn never loses tool access mid-flight.
- File: `apps/backend/src/services/auth/tool-execution-context-store.ts`.

### 5.3 At-rest encryption for connection credentials
- **Algorithm:** AES-256-GCM for GitHub and Notion OAuth tokens.
- **Key derivation:** `scrypt(N=16384, r=8, p=1)` from `DATA_ENCRYPTION_SECRET`.
- **Format:** base64(iv ‖ ciphertext ‖ authTag).
- File: `apps/backend/src/lib/crypto-utils.ts`.

### 5.4 Boot-time secret validation (Zod)
- `config.ts` fails fast on missing required secrets.
- **Requirements:** `E2B_API_KEY` + a real `E2B_TEMPLATE_ID` (unconditional — the runtime executes shell/file tools inside E2B; the migration runner is exempt), `PII_LLM_API_KEY` when `PII_PROVIDER_ENABLED=true`, all three `GITHUB_OAUTH_*` values when any one is set (the GitHub integration is a GitHub OAuth App). At least one model-provider key (Anthropic / OpenAI / Google / OpenRouter / Z.AI — per-tenant or the matching platform env var) is validated at session start.

### 5.5 URL sanitization for logging
- `sanitizeUrl()` strips `token`, `toolContextId`, etc. from any URL logged at warn/error.
- File: `apps/backend/src/lib/sanitize-url.ts`.

---

## 6. Human-in-the-Loop Approvals

### 6.1 Runtime approval-policy gating
- `tenant_settings.approval_policy` gates runtime-native shell/file/permission actions. When a request needs review, the frontend receives an AG-UI `CUSTOM` event named `approval_required`; the user resolves it via `POST /approvals/:approvalId/decision`.
- File: `apps/backend/src/routes/approvals.ts`.

### 6.2 Interrupt-based native HITL
- Gated tools (all MCP gateway tools plus the mutating built-ins `execute`/`write_file`/`edit_file`) pause the LangGraph run **before execution** via `interruptOn` and checkpoint. The adapter persists an `approvals` row, emits an AG-UI `CUSTOM` event named `approval_required`, and resumes the graph with the decision.
- Resume is **keyed per interrupt id**, so concurrent interrupts (parallel subagents each hitting a gated tool) cannot mis-route decisions.
- Files: `apps/backend/src/services/deep-agents/deep-agents-graph.ts`, `apps/backend/src/services/deep-agents/deep-agents-runtime-adapter.ts`.

### 6.3 Auto-approve read-only tools
- `tenant_settings.auto_approve_read_only_tools` skips prompts for tools tagged `readOnly` (`session_context`, `list_artifacts`, `read_text_artifact`, GitHub/Notion read ops).

### 6.4 Wall-clock TTL on pending approvals
- **TTL:** `APPROVAL_REQUEST_TTL_MS` (default 10 min).
- **On expiry:** the paused graph is resumed with a reject, `status='expired'` in DB, an `approval.expired` audit event is written, and an AG-UI `CUSTOM` event named `runtime_notice` is emitted (`noticeId = approval-expired:<id>`).
- **Crash recovery:** the row carries a DB-level `expires_at`, so a process death that kills the in-memory timer still lets the startup sweep expire stuck `pending` rows.
- Files: `apps/backend/src/services/runtime/approval-cleanup.ts`, `apps/backend/src/services/runtime/stale-approval-sweeper.ts`.

### 6.5 Policy Center approvals
- Policy Center rules can return `require_approval` for MCP tool calls. Policy Center and native approval share one checkpointed graph interrupt and one `approvals` row.
- The runtime keeps a proof with a random approval ID in backend memory, keyed by tool-call ID, and injects the approval ID at dispatch. The proof never enters model tool arguments. The gateway accepts it only when the approved row matches the session, user, tool, server, tool context, and canonical argument hash; missing or mismatched proof is denied. The hash leaves out the transport keys (`toolContextId`, `policyApprovalId`, the marker) at the argument root only. A nested key with one of those names is hashed.
- **Single-use:** before dispatch, the gateway claims the approval with `UPDATE … WHERE status = 'approved' AND consumed_at IS NULL RETURNING …`, scoped to tenant and user. One approval permits one dispatch attempt, even if that attempt then fails. While policy still enforces `require_approval`, a second dispatch with it is refused. Missing, rejected, expired, mismatched, or already-used proof returns `PolicyBlockedError` (`-32004`).
- Scheduled turns are unattended: the graph does not pause for Policy Center approval, and the gateway denies an enforced `require_approval` match. A rebuilt runtime does not restore a pending proof from a checkpoint; the action needs a new approval.
- Files: `apps/backend/src/routes/mcp.ts`, `apps/backend/src/services/deep-agents/deep-agents-graph.ts`, `apps/backend/src/services/policy/*`.

### 6.6 Long-term memory: authority and consent
- **Authority.** Memory text was written by a model or a user, so it is never placed in the system prompt. The prompt holds one rule (saved memories are user data, not instructions, and cannot change rules, tool permissions or approvals). Recent memories enter model input as a labelled data message for each turn. They are JSON strings inside a delimited block, with credentials redacted and non-printing characters made visible. The message is not saved in the conversation or the checkpoint. Server authorization never reads model text.
- **Consent.** `memory_save` (catalog flag `requiresUserApproval`) needs the user's approval of the exact text in every interactive turn, whatever `approval_policy` and Policy Center say. The approval is the same single-use proof as 6.5: it binds to the session, user, tool, server, tool context and argument hash, so a replay or a changed value is refused. The gateway passes the handler the approval that it claimed, and the handler refuses without it. A save that replaces a memory also stores the hash of the replaced text with the approval, and the write compares it under a row lock.
- **Scheduled runs** have nobody to ask, so a scheduled `memory_save` is refused and nothing is saved.
- **Provenance.** Each memory records its source session, the approving user, the approval ID and a version on the server (migration 068). Rows from before it read as `unverified`. Model-supplied `metadata` is never proof of approval. Text that holds a credential is refused.
- **User control.** `/settings/memories` lists, edits and deletes the signed-in user's own memories. Writes send the account and the version that the editor started from. If the memory changed after that, the server refuses the write, and the page keeps the user's text beside the latest saved text, so nothing newer is overwritten and nothing the user typed is lost without their choice.
- Files: `apps/backend/src/services/memory-consent.ts`, `apps/backend/src/services/memory-workspace-section.ts`, `apps/backend/src/services/deep-agents/memory-context-middleware.ts`, `apps/backend/src/routes/memories.ts`.

---

## 7. Rate Limiting & Quotas

### 7.1 Per-user / per-tenant rate windows
- **Session create:** 10 / user / window, 50 / tenant / window.
- **Message turns:** 20 / user / window, 100 / tenant / window.
- **Window:** `RATE_LIMIT_WINDOW_MS` (default 60s).
- **Response:** `LimitExceededErrorPayload` with `retryAfterMs` and `resetAt`.

### 7.2 Daily turn quotas
- 200 / user / day, 1000 / tenant / day, bucketed by `YYYYMMDD` UTC.

### 7.3 Implementation note
- In-memory per-process; configure `REDIS_URL` for multi-instance deployments.
- File: `apps/backend/src/services/request-limits.ts`.

---

## 8. Input Validation

### 8.1 Zod-based request validation
- `parseRequestInput(reply, schema, input)` returns a typed value or sends a structured 400.
- Common schemas (UUID, runtime enum, etc.) in `apps/backend/src/lib/route-schemas.ts`.
- File: `apps/backend/src/lib/route-validation.ts`.

### 8.2 Artifact upload validation
- **Size:** `ARTIFACT_MAX_UPLOAD_BYTES` (default 25 MB).
- **MIME allowlist:** PDF, JPEG, PNG, WebP, GIF, text, CSV.
- **Magic-byte check:** declared Content-Type cross-validated against actual bytes via `file-type`; mismatch = 415.
- **Filename sanitization:** Content-Disposition stripped of `"`, `\`, CR, LF, `;`; encoded per RFC 6266.
- **Storage key:** `{userId}/{sessionId}/{uuidv7}{safeExtension}` — extension restricted to alnum/`._-`.
- File: `apps/backend/src/lib/allowed-mime-types.ts`.

### 8.3 Skill bundle archive validation (zip / tar)

Applied to admin zip uploads, GitHub zipballs, and tarballs materialized from S3.

- **Compressed size cap:** archive ≤ `ARTIFACT_MAX_UPLOAD_BYTES` (default 25 MB), checked before parsing.
- **Zip-bomb accounting:** per-file uncompressed cap 10 MB, total uncompressed cap 25 MB, file-count cap 50. Declared uncompressed size required per entry; decoded byte length must match it.
- **Zip-slip / path traversal:** entry paths posix-normalized; absolute paths and `..` segments rejected; resolved path must stay under the extraction root.
- **Symlinks / non-regular files:** symlinks rejected as errors; FIFOs, sockets, and devices skipped.
- **Top-level allowlist:** only `SKILL.md`, `README.md`, `LICENSE` files and `assets`, `references`, `scripts` directories allowed at the bundle root.
- **GitHub subdirectory containment:** user-supplied subdir must resolve inside the extracted archive root.
- **Tar extraction filter:** S3-materialized `.tar.gz` bundles extracted with `strict: true`, admitting only `File` and `Directory` entries.

Files: `apps/backend/src/services/skills/skill-import-service.ts`, `skill-bundle-validator.ts`, `skill-bundle-storage.ts`, `skill-bundle-limits.ts`.

---

## 9. MCP Gateway Security

### 9.1 Two modes, both authenticated
| Mode | Description |
|---|---|
| `managed` | Tool dispatched to the internal `ManagedToolCatalog` (session tools, `write_artifact`, memory tools, GitHub, Notion) |
| `proxy` | Forwarded to upstream URL with HMAC-signed framework context headers |

File: `apps/backend/src/routes/mcp.ts`.

### 9.2 Runtime token authentication
- **Token:** `rt_…`, HMAC-derived from `DATA_ENCRYPTION_SECRET`.
- **Transport:** the runtime's MCP client sends `Authorization: Bearer rt_…` as a header on every request. Query-param tokens are rejected; MCP URLs never carry `?token=`.
- **Scope:** the token is session-scoped (HMAC claims bind tenant/user/session/runtime); only the per-turn `toolContextId` rotates.
- File: `apps/backend/src/lib/auth-runtime-token.ts`.

### 9.3 `toolContextId` resolution chain
1. `toolContextId` in the request's trusted `params._meta["cogniplane.ai/invocation"]` entry — the primary path. The runtime attaches it at call time, outside the tool arguments. When this entry is present, the gateway ignores a `toolContextId` in the arguments, because the model wrote that value.
2. `toolContextId` in the RPC args (older callers).
3. `toolContextId` in the URL.
4. Session fallback via `findLatestActiveBySession()` keyed on the runtime token's `sid` claim.

Every path binds the resolved context to the tenant, session, user and runtime of the runtime token. The gateway reads an approval proof only from the trusted `_meta` entry.

### 9.4 Proxy signature (v2)
- Each request to a proxy upstream carries HMAC-SHA256 signed headers: `X-Framework-Signature-Version` (`v2`), `X-Framework-Tenant-Id`, `X-Framework-Server-Id`, `X-Framework-User-Id`, `X-Framework-Session-Id`, `X-Framework-Runtime-Id`, `X-Framework-Timestamp`, `X-Framework-Nonce` (128 random bits, base64url), `X-Framework-Body-Sha256` (base64url SHA-256 of the exact body bytes sent) and `X-Framework-Signature`.
- **Key per server:** the key for one (tenant, server) pair comes from HKDF-SHA256 of the upstream signing secret (`MCP_UPSTREAM_SIGNING_ROOT_SECRET`, or a subkey of `DATA_ENCRYPTION_SECRET` under a v2 label), with the tenant ID and the server ID in the HKDF info. Give an upstream only its own key (`proxyServerSigningKey`). That key cannot sign for a different server or tenant. The upstream signing secret is never a value that a v1 upstream held, because anyone with it can derive every per-server key. Boot refuses the v1 override `MCP_UPSTREAM_SIGNING_SECRET`.
- **Source of identity:** the tenant ID comes from the runtime token and the server ID from the tenant's server registration, never from the model or the request body.
- **Replay:** the upstream calls `verifyProxyHeaders` with the raw body and its server ID. It must keep each returned nonce for `maxAgeMs` and reject a nonce that it already has.
- v1 signing (no tenant, server, nonce or body hash; one key for all upstreams) is removed. Upstreams that verify v1 must change to v2.
- File: `apps/backend/src/lib/mcp-proxy-signature.ts`.

### 9.5 Managed tool allowlist
- Only entries registered in the `ManagedToolCatalog` are invocable; unknown tool names rejected.
- Files: `apps/backend/src/services/managed-tools/catalog.ts` (the allowlist) and `apps/backend/src/services/managed-tools/factory.ts` (dispatch).

---

## 10. Artifact Security

### 10.1 Short-lived download tokens
- `POST /artifacts/:id/download-token` issues an opaque HMAC token (TTL `ARTIFACT_DOWNLOAD_TTL_MS`); `GET /downloads/:token` redeems it. No long-lived signed URLs leave the API.
- The token is the credential: browser navigations and `<img>` tags cannot send the Bearer header, so `GET /downloads/:token` is public in every auth mode and takes identity from the token row. The token gate checks the token user's current tenant membership and session access in SQL.

### 10.2 Privileged token read
- `getDownloadToken` uses `privilegedDb` because the opaque token is the initial authorization input. The method scopes its lookup to one token and applies the token's identity and consumption checks before serving bytes. Other reviewed privileged paths exist for lifecycle, scheduler, authentication, and bootstrap work.

### 10.3 S3 storage (`ARTIFACT_STORAGE_BACKEND=bucket`)
- **Key:** `{userId}/{sessionId}/{uuidv7}{safeExtension}`.
- **Download URLs:** presigned, default 15 min TTL.

### 10.4 Artifact-checkbox UI is not a security boundary
- `artifactIds` in `POST /messages` is a prompt-context hint; the agent retains filesystem access to all synced artifacts in `./artifacts/`.

---

## 11. PII Handling

### 11.1 Optional PII provider (off by default)
- **Toggle:** `PII_PROVIDER_ENABLED` (requires the configured provider's API key).
- **Default model:** `google/gemini-2.5-flash` via OpenRouter — substitute whatever provider you want; the env-var contract is in `apps/backend/src/config.ts`. The logging and retention posture is whatever your chosen vendor provides.
- **Sync budget:** `PII_PROVIDER_TIMEOUT_MS` (default 5000 ms).

### 11.2 Policy modes
| Mode | Behavior |
|---|---|
| `off` | No detection |
| `detect` | Findings reported; user decides |
| `block` | Reject input on detection (fail-closed if provider unavailable) |
| `transform` | Redact/replace PII before persistence |

### 11.3 Per-scope policy
- Independently configured for chat prompts and file uploads.

### 11.4 Sync vs async routing
- **Sync:** `block`, `transform`, and `detect` for chat (so scan-run id can attach to the message).
- **Async:** `detect` for uploads (background scan job).

### 11.5 Rule-based fallback
- Deterministic detector still catches obvious patterns when the LLM provider is unavailable or times out.

### 11.6 Tenant-scoped scan storage
- `pii_scan_runs` and `pii_scan_jobs` are RLS-protected.

---

## 12. Audit Logging

### 12.1 `audit_events` table
- **Coverage:** artifact upload, approval decision, tool invocation, skill import, integration connect/disconnect, etc.
- **Fields:** `tenant_id`, `session_id`, `user_id`, `event_type`, `payload` (JSONB), `ip_address`, `user_agent`, `created_at`.
- **Access:** wrapped in `withTenantScope`.

### 12.2 Pre-persistence redaction
- All payloads pass through `redactSecrets()` before insert.

### 12.3 Approval audit trail
- Every decision writes `approval.approved` / `approval.rejected` / `approval.expired` with full context.

### 12.4 Auth-failure logging
- 401 / 403 rejections logged at warn with method + sanitized URL + reason.

---

## 13. Network, CORS & Security Headers

### 13.1 CORS
- `@fastify/cors` with explicit `origin` allowlist (`API_ORIGIN`).
- **Methods:** GET, HEAD, POST, PUT, DELETE, OPTIONS.
- **Headers:** `Content-Type`, `X-User-Id`, `X-Tenant-Id`.
- Files: `apps/backend/src/app.ts`, `apps/backend/src/lib/cors.ts`.

### 13.2 Manual CORS for SSE
- `/messages` hijacks the reply; CORS headers set explicitly via the same `isCorsOriginAllowed` allowlist.

### 13.3 Strict security headers (every response)
| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `X-XSS-Protection` | `0` (defer to CSP) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` (2 years) |
| `X-Request-Id` | per-request id |

File: `apps/backend/src/lib/security-headers.ts`.

### 13.4 Cookie hardening
- **`cogniplane_session_hint`:** `SameSite=Lax`, `Secure`, 7d TTL, non-credential.
- **`cogniplane_refresh`:** `httpOnly`, `Secure`, `SameSite=None`, scoped to backend domain.

---

## 14. Database Security

### 14.1 RLS everywhere data is tenant-scoped
- Enforced by Postgres kernel; not bypassable from app code without `privilegedDb` (§3.1).

### 14.2 Parameterized queries throughout
- All SQL uses `$1, $2, …` placeholders; no string-interpolated user input.

### 14.3 No plaintext stored secrets
- Integration tokens encrypted with AES-256-GCM (§5.3).

### 14.4 Superuser scope minimized
- The normal app pool runs as `app_user`. Code must opt into `privilegedDb`, and each caller needs an authorization reason that RLS cannot express, such as a cross-tenant worker claim, bootstrap lookup, or opaque-token lookup.

---

## 15. Frontend Security

### 15.1 `<AuthGuard>` route protection
- Blocks render until auth resolved; redirects unauthenticated users; shows insufficient-permission state on role mismatch.
- File: `apps/frontend/src/lib/auth-guard.tsx`.

### 15.2 Edge middleware
- `src/middleware.ts` does a fast pre-render check via the session-hint cookie; non-allowlisted paths redirect to `/login`.

### 15.3 Token storage
- Access token held in memory (React state) only; no `localStorage` or `sessionStorage` persistence.

### 15.4 No `dangerouslySetInnerHTML`
- Codebase contains no `dangerouslySetInnerHTML`; model markdown rendered through a sanitizing renderer.

### 15.5 Auth callback hardened against pre-render
- `/auth/callback/page.tsx` exports `dynamic = "force-dynamic"` so edge hosts cannot serve a static prerender that skips the token exchange.

### 15.6 Auth-callback race-condition mitigation
- The callback page awaits `completeLogin(accessToken)` — which sets the in-memory token and populates the user — before `router.replace("/")`, so `AuthProvider` is ready without a `/auth/refresh` round-trip.

---

## 16. Supply-Chain & Dependency Hygiene

### 16.1 Pinned runtime versions
- The agent runtime is an in-process library: `deepagents` (+ LangChain/LangGraph) is version-pinned in `apps/backend/package.json` and locked by `pnpm-lock.yaml` — there is no separately-versioned agent CLI to drift.

### 16.2 SDK bump guard
- `deep-agents-graph.test.ts` pins the hardcoded builtin-tool-name list against `createDeepAgent`'s actual collision behavior, so a library bump that changes the builtin tool set fails the suite loudly instead of silently changing which MCP tool names are dropped.

### 16.3 Template contents pinned
- `docker/template.ts` installs a pinned Python package set into the E2B template; the template contains no agent code or secrets.

### 16.4 Deterministic dependency resolution
- pnpm workspace with checked-in `pnpm-lock.yaml`.

### 16.5 Rollback path
- Old E2B template ids retained in the E2B account; rollback is git revert + redeploy.

---

## 17. Logging Hygiene

- **URL scrubbing:** all warn/error URLs pass through `sanitizeUrl()` (strips `token`, `toolContextId`, etc.).
- **Audit redaction:** payloads pre-redacted via `redactSecrets()`.
- **Structured logging:** Fastify pino logger.

---

## 18. CSRF Posture

- JSON API only — no form-based state changes.
- **Frontend:** cross-domain; refresh cookie is `SameSite=None; Secure`; access token is JS-set on `Authorization`, not auto-submitted.
- **Runtime processes:** token-authenticated, not browser-driven.
- Classical CSRF does not apply; SameSite flags are defense-in-depth.

---

## 19. Session Management

| Layer | Mechanism | TTL |
|---|---|---|
| Access token | JWT, header-bound | 15 min |
| Refresh token | JWT + Redis jti, rotation + reuse detection | 7 days |
| Session-hint cookie | UI-only, lax | 7 days |
| Runtime session | in-process Deep Agents session (+ optional lazy E2B sandbox) | idle 5 min; sandbox hard cap 30 min |
| Tool execution context | per-turn credential envelope | 25 min |
| Pending approval | wall-clock TTL | 10 min |
| Artifact download token | HMAC, single-use | configurable, short |

Refresh-token reuse detection forces full re-login on replay (§1.2).

---

## 20. Tenant-Configurable Capability Gates

Per-tenant settings in `tenant_settings` (one row per tenant; `system` row is platform default).

| Setting | Effect |
|---|---|
| `approval_policy` | Native runtime approval posture (`never`, `on-request`, or granular JSON) |
| `auto_approve_read_only_tools` | Skip native prompts for read-only tools |
| `policy_enforcement_mode` | Policy Center tenant mode: `monitor` records matched decisions; `enforce` gates matched actions |
| `allow_command_execution` | Permit shell-command tool calls |
| `enabled_tool_ids` | Allowlist of managed tools available to the runtime |
| `enabled_mcp_server_ids` | Allowlist of MCP servers wired into the workspace |
| `developer_instructions` | Per-tenant system-prompt overlay |

File: `apps/backend/src/services/tenant-settings-store.ts`.

Policy Center rules live in `policy_rule` and are evaluated before and at the MCP gateway. Active dimensions are `toolNames`, `categories` (managed-tool domain or proxy MCP server id), `severities`, and `turnContexts`; effects are `allow`, `require_approval`, and `block`. Only matched rules write `policy_decision` evidence rows.

---

## 21. Runtime Config Snapshots

- Every runtime turn captures the effective runtime policy in the runtime manifest and the per-turn `ToolExecutionContext`, frozen for the duration of the turn. Admin config changes mid-turn cannot retroactively widen or narrow what the agent can do.
- Tenant-setting updates invalidate active runtimes. If any adapter cannot refresh, the settings route returns `503 runtime_refresh_failed` instead of silently leaving a stale runtime active.
- File: `apps/backend/src/domain/runtime-manifest.ts`.

---

## 22. Feature Flags & Kill Switches

| Flag | Purpose |
|---|---|
| `PII_PROVIDER_ENABLED` | Opt-in PII detection provider |
| `SCHEDULER_ENABLED` | Background job scheduler |
| `SCHEDULER_MAX_CONCURRENT_JOBS`, `SCHEDULER_JOB_TIMEOUT_MS` | Scheduler bounds |
| `RUNTIME_TURN_TIMEOUT_MS` | Turn watchdog; `0` disables |
| `ARTIFACT_STORAGE_BACKEND` | `local` vs `bucket` (S3) |
| `SKILL_BUNDLE_STORAGE_BACKEND` | `local` vs `bucket` (S3) |
| `AUTH_MODE` | `dev-headers` vs `workos` (production-locked to `workos`) |

---

## 23. Configuration Versioning

- Skills, MCP servers, and tenant settings compiled into a config bundle hashed with SHA-256; hash stored in the runtime manifest, manifest version increments on change. Enables verifiable rollbacks of agent capabilities.
- File: `apps/backend/src/lib/crypto-utils.ts` (`computeConfigHash`).

---

## 24. Skill Bundle Integrity

- **Local:** `<SKILL_BUNDLE_STORAGE_ROOT>/<bundleName>/<contentHash>/` — content-addressed.
- **S3:** `s3://<bucket>/<prefix>/skills/<tenantId>/<skillId>/<revisionNumber>-<contentHash>.tar.gz`.
- **Tamper detection:** content-hash addressing means tampering yields a different path; cache idempotent across deploys.
- Archive-level structural defenses (size caps, zip-bomb accounting, path traversal, symlink filtering, top-level allowlist, tar filter) live in §8.3.

---

## 25. Test Coverage

- **CI thresholds:** `pnpm test:coverage` and `pnpm test:coverage:frontend` are CI gates. They count every eligible production file, including files that no test imports. `.coverage-thresholds.json` holds the floors and the dated measurements they come from. The imported-module runs use a different denominator and are a nonblocking trend. Backend unit coverage does not include the Postgres integration suite, and unit-test fakes do not prove database policies.
- **Scope:** the backend (`apps/backend`) and the frontend (`apps/frontend`) have separate floors.
- **Security-critical paths covered:** refresh-token rotation/reuse, `redactSecrets` patterns, RLS scoping helpers, approval coordinator timeouts, MIME-type/magic-byte validation, route-validation rejection paths.
- **Runner:** `vitest run --coverage` (v8 provider).

---

## Appendix A — Defense-in-Depth Summary

| Threat | Primary control | Backup control |
|---|---|---|
| Cross-tenant data access | Postgres RLS | App-level `withTenantScope` |
| Credential exfiltration via model | `toolContextId` envelope (model-blind) | `redactSecrets` on all persisted I/O |
| Token theft (XSS) | Access token held in memory only (not `localStorage`/`sessionStorage`); no `dangerouslySetInnerHTML`; strict CSP | Short access-token TTL (15m) + refresh reuse detection |
| Token theft (network) | HTTPS (HSTS preload) + httpOnly refresh cookie | Cookie `Secure` + `SameSite=None` |
| Refresh-token replay | jti consume + family revoke on reuse | 7d TTL ceiling |
| Sandbox escape | E2B isolated workspace per session | Sandbox + request + idle timeouts |
| Tool abuse | Native HITL approvals, Policy Center rules, and capability allowlists | Tenant-level monitor/enforce switch + read-only auto-approve scoping |
| Approval flooding | Wall-clock TTL on every pending approval + startup sweep of stale rows | Turn abort rejects all pending approvals for the session |
| Upload-based attacks | MIME allowlist + magic-byte verify + size cap | Filename sanitization + sandboxed processing |
| Archive-based attacks (zip bomb, zip-slip, symlink escape) | Per-file + total uncompressed caps, file-count cap, posix-normalized path containment, declared-vs-actual size check | Validator rejects symlinks/non-regular files; tar extraction filter admits only `File`/`Directory` |
| Log-based credential leak | `redactSecrets` + `sanitizeUrl` | Structured logger filtering |
| SQL injection | Parameterized queries everywhere | RLS as last line of defense |
| MCP request spoofing | Runtime token (HMAC) + proxy signature | toolContextId resolution chain |
| Stale config mid-turn | Runtime policy snapshot frozen per turn | Config hash + manifest versioning; settings updates invalidate active runtimes |
| PII leakage | Provider + rule-based fallback, fail-closed in `block` mode | Per-scope opt-in, scan-job audit trail |
| Dependency drift | Runtime library pinned in `package.json` + lockfile | Builtin-tool-name pin test on SDK bumps |

---

## Appendix B — Files for Quick Reference

| Concern | File |
|---|---|
| JWT issuance / verify | `apps/backend/src/lib/jwt.ts` |
| Refresh token store | `apps/backend/src/lib/refresh-token-store.ts` |
| Auth (dev-headers) | `apps/backend/src/lib/auth.ts` |
| Auth (WorkOS) | `apps/backend/src/lib/auth-workos.ts` |
| RBAC | `apps/backend/src/lib/rbac.ts` |
| Tenant scope / RLS | `apps/backend/src/lib/db.ts` |
| Secret redaction | `apps/backend/src/services/redact-secrets.ts` |
| URL sanitization | `apps/backend/src/lib/sanitize-url.ts` |
| Crypto / encryption | `apps/backend/src/lib/crypto-utils.ts` |
| Runtime token | `apps/backend/src/lib/auth-runtime-token.ts` |
| MCP proxy signature | `apps/backend/src/lib/mcp-proxy-signature.ts` |
| MCP gateway | `apps/backend/src/routes/mcp.ts` |
| Native HITL (interrupts + approval loop) | `apps/backend/src/services/deep-agents/deep-agents-runtime-adapter.ts`, `apps/backend/src/services/deep-agents/deep-agents-graph.ts` |
| Policy approval proof | `apps/backend/src/services/policy/policy-approval-proof.ts` |
| Rate limits / quotas | `apps/backend/src/services/request-limits.ts` |
| Security headers | `apps/backend/src/lib/security-headers.ts` |
| CORS | `apps/backend/src/lib/cors.ts` |
| Route validation | `apps/backend/src/lib/route-validation.ts` |
| MIME allowlist | `apps/backend/src/lib/allowed-mime-types.ts` |
| Skill archive zip extraction + path/zip-bomb checks | `apps/backend/src/services/skills/skill-import-service.ts` |
| Skill bundle limits (file count, sizes) | `apps/backend/src/services/skills/skill-bundle-limits.ts` |
| Skill bundle validator (symlink + top-level allowlist) | `apps/backend/src/services/skills/skill-bundle-validator.ts` |
| Skill tar extraction filter (S3 materialize) | `apps/backend/src/services/skills/skill-bundle-storage.ts` |
| Audit events | `apps/backend/src/services/audit-event-store.ts` |
| Tenant settings | `apps/backend/src/services/tenant-settings-store.ts` |
| ToolContext store | `apps/backend/src/services/auth/tool-execution-context-store.ts` |
| Approval store | `apps/backend/src/services/auth/approval-store.ts` |
| Frontend AuthGuard | `apps/frontend/src/lib/auth-guard.tsx` |
| Frontend middleware | `apps/frontend/src/middleware.ts` |
| Sandbox backend + path guard | `apps/backend/src/services/deep-agents/deep-agents-e2b-backend.ts`, `apps/backend/src/services/runtime/sandbox-path.ts` |
| E2B template | `docker/template.ts` |
| RLS migrations | `apps/backend/db/migrations/*.sql` |

---

*Maintainers: keep this document in sync when adding security-relevant code paths. Update Appendix A and Appendix B in the same PR.*
