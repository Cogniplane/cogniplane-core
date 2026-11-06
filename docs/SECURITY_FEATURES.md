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
| `jwt` (alias `workos`) | Verifies backend-issued JWTs; looks up role, tenant login type, and the user's login path from `tenant_memberships`, `tenants`, and `users` on every request | Production |

Each tenant has a login type (`tenants.login_type`), fixed at creation by a database trigger. A token acts only when the tenant's login type is enabled and equals the user's `users.auth_source`. WorkOS provisioning refuses a tenant of another login type, and never adopts an existing `users` row it does not already own (409 `email_in_use`).

Files: `apps/backend/src/lib/auth.ts`, `apps/backend/src/lib/auth-jwt.ts`, `apps/backend/src/lib/auth-admission.ts`, `apps/backend/src/config.ts`.

### 1.4 Public-path allowlist
- **Match:** exact, after stripping query string — defends against `/auth/login.attack` smuggling.
- **Allowed:** `/auth/config`, `/auth/refresh`, and `/auth/logout`; `/auth/login` and `/auth/callback` only when WorkOS login is enabled (`AUTH_LOGIN_TYPES`); `/auth/local/login`, `/auth/local/setup`, `/auth/local/password/reset`, `/auth/local/mfa/totp`, `/auth/local/mfa/recovery`, and `/auth/local/enroll/totp/start` and `/confirm` only when local login is enabled; the passkey ceremonies `/auth/passkey/login/options` and `/verify`, `/auth/local/mfa/passkey/options` and `/verify`, and `/auth/local/enroll/passkey/options` and `/verify` only when passkeys are on (`WEBAUTHN_RP_ID`); `/auth/local/password/forgot` only when local login and email are on (`SMTP_URL`, `MAIL_FROM`); plus the integration OAuth callback paths sourced from the integration registry (e.g. the GitHub user callback).
- Files: `apps/backend/src/lib/auth-public-paths.ts`, `apps/backend/src/lib/auth-jwt.ts`.
- `GET /downloads/:token` is also public: the single-use token is the credential (see §10.1).
- **OAuth callbacks are bound to the browser that started the connect (GitHub and Notion).** Authorize sets a random nonce in an httpOnly cookie scoped to the callback path, and the signed state carries only its SHA-256. The callback requires the cookie, compares the hashes in constant time before it spends the single-use state `jti`, and clears the cookie. A provider URL sent to another person therefore cannot bind that person's account to the attacker's user. The cookie is `SameSite=None; Secure` for an https redirect URI, because the authorize call can be a cross-site fetch.

### 1.5 Frontend session-hint cookie
- **Cookie:** `cogniplane_session_hint=1`, Max-Age 7d, `SameSite=Lax`, `Secure` over HTTPS.
- **Role:** UI-only short-circuit for the redirect-to-login flow; not a credential.
- Files: `apps/frontend/src/lib/auth-context.tsx`, `apps/frontend/src/middleware.ts`.

### 1.6 Refresh cookie hardening
- **Cookie:** `cogniplane_refresh` — `httpOnly`, `Secure`, `SameSite=None`, scoped to backend domain.
- Frontend JS cannot read it; route protection is therefore handled by `AuthGuard`.
- **Deletion:** only an explicit sign-out deletes the cookie (`/auth/logout`, `/me/security/sessions/revoke`). A refused `/auth/refresh` keeps it: all tabs share the cookie, and another tab can have a newer one when the answer arrives. A refused cookie grants nothing, because its family is revoked or it is not valid.

### 1.7 Access token storage
- **Storage:** held in memory only (the API client module; the auth context shows it as React state) — never written to `localStorage` or `sessionStorage`, so no persistence surface for XSS to read; a page reload re-authenticates via the refresh cookie.
- **Order of session changes:** a call whose answer sets or deletes the refresh cookie (sign-in, an account change that starts a new session, sign-out) holds a session-change gate. A refresh does not send the cookie while such a call runs, and such a call waits for a refresh on the wire. Each such call has a 30-second time limit; after it, the call is aborted and the gate opens. If the answer had not arrived, its cookie does not apply; if its headers had arrived, the browser has the new cookie and the next refresh uses it. Thus a refresh cannot send a cookie that a new session replaces, and a late refresh answer cannot delete the cookie of a newer session. A session epoch makes sure that a late answer for an older session does not replace a newer one in memory.
- Files: `apps/frontend/src/lib/api-client.ts`, `apps/frontend/src/lib/auth-context.tsx`.

### 1.8a Local accounts (email and password)
- **Hashing:** Argon2id with Node's built-in `crypto.argon2` (19 MiB, 2 passes, 1 lane), PHC strings, rehash on sign-in when parameters change. A per-process limit on concurrent hashes answers 503 instead of queueing. Unknown emails run the same work against a dummy hash.
- **Password rules:** 15 to 128 characters after NFKC normalisation, no composition rules, a block list, no email address (NIST SP 800-63B-4).
- **Uniform answers:** unknown, disabled, removed, not-set-up, and wrong-password sign-ins all get `401 invalid_credentials`.
- **Throttle:** per normalised email, keyed by HMAC in Redis: after 5 failures a wait of 30 s doubling to 15 min; refused requests do not extend it; at most 2 checks in flight per email. Fails closed. The per-IP limit on these routes also fails closed.
- **Revocation:** tokens carry the account's `security_version` (`sv`); every security change increments it and ends every older session at its next request. Turns that already run stop too: after the commit, the replica that made the change stops the account's runtimes, and every tool execution context keeps the version that admitted its turn, so the MCP gateway refuses the tool calls of an older turn on every replica (`apps/backend/src/services/auth/security-change.ts`, migration `081_tool_context_owner_security_version.sql`).
- **One-time links:** 32 random bytes in the URL fragment; only the SHA-256 is stored, with the account version; single use; a setup link only activates a new account, a reset link only changes the password and starts no session.
- **Step-up:** a single-use token (5 min) bound to the user, tenant, session family, version, and action. A logout ends it. An access token alone cannot grant a sign-in credential, a Cogniplane account, or a tenant role, or end an account or a factor. For managers: create, role change, password reset, disable, enable, removal, and second-factor reset of a local member. For the user's own account: password change (with a second factor), a new authenticator or passkey, new recovery codes, and removing a factor. Tenant settings that change where data goes need step-up too (see "Data routes" below). The 403 names the action. Scheduled jobs and personal connections (GitHub, Notion, Jira, saved MCP credentials) keep the security version of the session that saved them. After a security change of the owner's local account, the scheduler pauses a job, and a connection is suspended until the owner connects again; a GitHub connection, or a Notion connection with an email that Notion attests, can also be confirmed (Jira and MCP have no confirm). Changes that make a control weaker, and skill releases, need step-up too (see "Weaker controls and skill releases" below). Known gaps: other things that a session creates stay after the session is revoked, such as scheduled jobs and connections of WorkOS accounts.
- **Data routes (tenant settings that change where data goes):** a provider API key, a tenant settings save (providers, models, the default model, sandbox network hosts, enabled MCP servers and tools, agent instructions), an MCP server's address and secret (create, update, and both setup routes), who uses a shared MCP server, an approved widget domain, and an integration's settings. A stolen owner or admin token could otherwise send every user's prompts and data to another server, and the change would stay after the victim's password change or "sign out everywhere". Each route is in the step-up list and calls `DataRouteControl.requireStepUp` (`apps/backend/src/services/data-route-control.ts`) before the change: a local session needs a single-use step-up token for the route's action, one prompt per save (the browser's request layer shows one shared dialog and sends the same request once more). A WorkOS session needs none, because Cogniplane cannot ask WorkOS for a fresh proof; a session's login path always equals the tenant's login type, so a local tenant never skips it. Every change, from every kind of session, emails each owner of the tenant with an address (WorkOS owners too): who, which setting and object, which fields, and when, never a value. The notice is written in the transaction of the change's audit event, so it exists only if the change commits. With email off, the audit event is the only record, and startup logs a warning when WorkOS login is on. A tenant settings save needs step-up and a notice only when it changes a field that routes data or a control (the approval reviewer included), and an integration save only when a setting changes or access turns on (one list in `apps/backend/src/routes/admin/data-route-fields.ts`); a save without step-up never writes a protected field, and an integration save writes only the toggles and settings keys that differ from its read, onto the row locked at the write, so it cannot write back an older toggle or secret. An MCP route checks that the server exists before the step-up check, so a 404 does not spend the token. Data routes outside `/admin/` use the admin rate limit too. An overlay protects its own data route with `requireStepUpForOverlay`.
- **Weaker controls and skill releases:** the same checks (step-up from a local session, none from a WorkOS session, a notice to every owner, the same shared dialog) protect a change that makes a control weaker for every user, and a skill release. With a stolen token, such a change opens a blocked tool, sends unmasked personal data to the model provider, or gives every user's agent new instructions, and it stays after the victim signs out. The rule is the route and the stored key, not what is registered or shared at the moment: every route and every stored key that can make a change live is protected.
  - **Policy Center rules** (create, update, delete, new order): only a change that makes the policy weaker. Weaker means that at least one tool call gets a less strict outcome after the change (allow < approval < block), whatever the enforcement mode. `apps/backend/src/services/policy/policy-weakening.ts` decides it exactly: it runs the real engine on the rules before and after the change, for one sample action of each case that the rules can tell apart (each listed value, one unlisted value, and no value, per dimension), only for the actions that a changed rule matches. The check runs in the request, so its work has a limit: when the sample actions times the enabled rules before and after exceed 200,000, the change counts as weaker (step-up), for example a broad rule changed in a large rule set. A rename, a stricter effect, a new block rule, or an allow rule that matches only allowed calls needs neither step-up nor a notice.
  - **PII protection** (`PUT /tenant/settings/pii`): only a save that makes the protection weaker (`apps/backend/src/services/pii/pii-weakening.ts`), compared as the scan reads both policies: protection off (or a stored policy that is not valid, which stops content, made valid), a lower mode (block > transform > detect), a scope turned off, an entity type removed, more raw values kept (never > reversible encrypted > admin only), reports to admins off, or another detection model. Scopes include every key in the stored policy or the save, also one that no overlay registers now: a save accepts the legacy `microsoftImports` key without its overlay and keeps every stored key that it does not name, so the value applies when the overlay comes back. Such a key with no stored value counts as on. When protection was off, no save is weaker. The notice names the weaker fields, never their values.
  - Both classify the change in the write's transaction, against the rows locked there, not against a copy read before (`DataRouteControl.writeWithStepUpIfWeaker`): the store refuses a weaker change that has no step-up and rolls back; the route then asks for step-up and writes again. So two changes that are not weaker alone cannot make the policy weaker together, and a PII save with no step-up cannot write an older, weaker policy back over a stronger one. The PII revision check runs first: a stale save answers 409 before it spends a step-up token, and the resend after step-up sends the same revision.
  - **Skill release:** activating a revision, publishing a skill to all members, releasing a submitted skill, and releasing a project skill (`POST /projects/:projectId/skills/:skillId/action` with `release`) always need step-up and send the notice; the notice runs in the release's transaction. A project skill release gives the skill to the project's editors (every member when the project gives the organization edit access), and later sharing of the project gives it to new members, so it needs step-up in every project. A member gets 403 on a submission release before any step-up prompt. A personal skill release needs neither: a personal skill runs only in the member's own sessions. A copy into a project, a draft, an import, and turning a skill off make nothing live.
  - **Skill marketplace address** (`PUT /tenant/settings/marketplace`): setting an address needs step-up and sends the notice; removing it needs neither.
- **Manager rights:** nobody acts on themselves or on an owner; only an owner acts on an admin or creates an admin. A manager cannot create an owner: a new account is not active yet, and only an active local account can become an owner (`account_not_active`), so an owner promotes the person after setup. Only the operator commands (`auth:bootstrap`, `auth:recover-owner`) leave an owner that is not set up. The rights are checked again under the target's identity lock, which a role change also takes; a role change cancels the target's open links, so a reset link cannot outlive a promotion. Every manager change takes the tenant's membership lock first and then reads the caller's role inside its transaction (`apps/backend/src/services/member-authority.ts`), for WorkOS and local tenants alike, so manager changes in one tenant run one at a time. Every action writes an audit event in its own transaction. A manager who holds a reset link can set the password of a member without a second factor; this is accepted for now.
- Files: `apps/backend/src/services/auth/local-account-service.ts`, `login-throttle.ts`, `step-up-store.ts`, `apps/backend/src/lib/password-hash.ts`, `apps/backend/src/routes/auth-local.ts`, `apps/backend/src/routes/tenant-local-members.ts`, migration `071_local_accounts.sql`.

### 1.8b Second factors for local accounts
- **TOTP:** RFC 6238 (SHA-1, 6 digits, 30 s, one step of drift). The secret is encrypted at rest with AES-256-GCM under `DATA_ENCRYPTION_SECRET`. A code is accepted once: `last_used_step` advances with a conditional update.
- **Recovery codes:** 10 codes of 80 bits, shown once, stored as HMAC-SHA256 under a key derived with HKDF (`cogniplane/recovery-code/v1`). A recovery code does not open a session; the person must enrol a new authenticator first.
- **Sign-in state:** after a correct password, the second step lives in Redis for 5 minutes (not extended), bound to an httpOnly cookie on `/auth/local`; 5 wrong codes end it. The record never changes after it is written: a recovery code consumes it and starts a new flow with the same deadline, and a Lua script counts wrong codes only while the flow exists, so a consumed flow cannot come back. A step that spends a code or a passkey answer takes the flow (`GETDEL`) before its database work and puts it back only on failure (one script also counts the wrong secret), so two requests never spend on one flow and every commit is answered. A recovery code is only checked at the sign-in step; the enrolment that follows spends it in the same transaction as the new factor. An enrolment prepares its new session before its commit, so a Redis failure rolls the enrolment back. Code checks share the per-email throttle (kind `second_factor`). The session token records `amr: ["pwd","otp"]`.
- **Strong step-up:** when the account has an authenticator, every step-up must use a code from it; a password alone answers `403 strong_step_up_required`. This covers password change, a new authenticator, turning it off, and new recovery codes. A required policy blocks turning it off. Adding a factor always needs step-up, also the first one: without a factor, the password is the proof, so an access token alone cannot add a factor.
- **Tenant rule:** `optional`, `required_for_admins`, or `required_for_all`. A stricter rule ends the sessions of covered members without a factor, and they enrol at their next sign-in. Only an owner, with strong step-up when the owner has an authenticator, can make the rule weaker; the check is repeated under the tenant lock. Rule changes, confirmed or removed factors, and manager resets take the tenant lock first, so a factor change cannot pass a rule change unseen. A password change is refused when the account's version moved after the session's checks. Every manager change also compares the manager's own `security_version` with the session's under the tenant lock, so a step-up made before the manager's own factor or password change cannot be used after it.
- **Manager reset:** deletes the member's factors, requires a new enrolment at the next sign-in, and ends every session of the member. It needs step-up (`member.mfa_reset`) and writes `tenant.member.mfa_reset`.
- **Audit:** `auth.mfa_enrolled`, `auth.mfa_removed`, `auth.recovery_code_used`, `auth.recovery_codes_regenerated`, `tenant.member.mfa_reset`, `tenant.security_policy.changed`.
- Files: `apps/backend/src/services/auth/local-mfa-service.ts`, `login-flow-store.ts`, `apps/backend/src/lib/totp.ts`, `apps/backend/src/lib/recovery-codes.ts`, migration `072_local_second_factors.sql`.

### 1.8c Passkeys for local accounts
- **On only when `WEBAUTHN_RP_ID` is set**; startup checks that it is the frontend hostname or a parent domain of it.
- **Checks:** `@simplewebauthn/server` with the exact frontend origin, the RP id, user verification required, and attestation `none`. Discoverable credentials (resident keys). The signature counter must move forward (0 is accepted for synced passkeys).
- **Challenges:** single use, 5 minutes, in Redis under a hash of a random id, each with one purpose. Public ceremonies bind the record to the browser (httpOnly cookie) and, for the second step and enrolment, to the sign-in flow; signed-in ceremonies bind it to the user, session family, security version, and step-up action. A wrong-purpose, wrong-flow, or wrong-session record is refused before any check.
- **Passwordless sign-in:** the account comes from the credential id (maintenance pool, SELECT only), and the user handle must match it. A disabled or removed account gets the same `401 passkey_not_accepted` as a bad answer.
- **Second factor:** a passkey counts like the authenticator app for the sign-in step, strong step-up, the tenant rule, removal rules, and the manager reset. The last factor cannot go under a required rule. An enrolled passkey keeps the account in the second step also when passkeys are turned off; the step then offers the other methods. Adding a factor needs step-up (the password for a first factor) and an active session family, not only a valid access token. A signed-in passkey registration accepts only the challenge record that its step-up made.
- **Audit:** `auth.passkey_added`, `auth.passkey_removed`, `auth.login_succeeded` with `amr: ["pkey"]`, `auth.step_up` with `amr: ["pkey"]`.
- Files: `apps/backend/src/services/auth/local-passkey-service.ts`, `passkey-challenge-store.ts`, migration `073_local_passkeys.sql`.

### 1.8d Email
- **On only when `SMTP_URL` and `MAIL_FROM` are set, in `AUTH_MODE=jwt`, for every login type.** "Forgot password" also needs local login. TLS is required (`smtps://`, or `smtp://` with STARTTLS); `SMTP_ALLOW_PLAINTEXT` is for a local test server and is refused in production.
- **Recipient:** one plain address only; account addresses refuse address-list syntax (`<>`, `,`, `;`, quotes, control characters), and the SMTP envelope names the account's address alone. Names from the database lose control characters and Unicode format characters (category Cf, such as the right-to-left override U+202E and zero-width characters) before they go into a message.
- **Forgot password:** the same `202` for every address, sent before any lookup (origin check and per-IP limit first). Only an active local account gets a link: 30 minutes, at most one email per 5 minutes, issued under the identity lock without a new security version, so a request by someone else signs nobody out. The link sets the password only; second factors stay. A link email is checked just before each send and goes out only while its link still works, so a replaced or used link is not sent later (an email already handed to the mail server cannot be recalled). Audit: `auth.password_reset_requested`.
- **Security notices** to the account's address: password changed, a second factor added or removed, a manager password reset, a manager second-factor reset. A notice has no link and does not depend on one.
- **Manager links by email:** with email on, setup and reset links go only to the person's address; the manager's answer names the address and the expiry, never the link. With email on, an account without an address gets no link at all (`no_email_address`). "Send the link again" issues a new link without ending sessions (no step-up; audit `tenant.member.link_resent`); it and a new setup link wait one minute after any link email to the account. With email off, the manager gets the link to pass on.
- **Owner notices:** each change of a data route, each change that makes a control weaker, and each skill release sends `tenant_setting_changed` to every owner of the tenant with an address, local or WorkOS, the actor included. It names the actor, the setting, the object and the changed fields, and the time, never a value (a key, an address, a secret), and has no link. The subject and the first sentence are fixed ("A data setting of your organization was changed."); the organization name, an MCP server id, a policy rule name, a skill id, and display names are only in labelled fields, next to the organization ID, which cannot change. Notices are combined per owner: one per 15 minutes, counted from the send; a notice that waits for its first send attempt lists further changes (at most 10, then "And other changes. Examine the audit log."), and other changes wait in one follow-up until the window ends. So a loop of changes cannot flood the shared outbox. The worker sends link emails first and lets tenants take turns, so one tenant's notices cannot make another tenant's reset link expire in the queue. A rename of the organization writes an audit event and sends this notice, and a name with `://`, `www.` or `@` is refused. A notice that reaches no owner logs a warning.
- **Outbox:** each notice is written in the same transaction as the change, encrypted with `DATA_ENCRYPTION_SECRET`, under RLS. A row belongs to a member of the tenant (migration `082_email_outbox_owner_notices.sql`); removing the member deletes it. The worker uses the maintenance pool (no INSERT), `SKIP LOCKED` claims with a claim token, retries with backoff, expires a notice after 72 hours, and clears the text once a message is sent, fails, or expires. Rows keep an error code only and are deleted after 30 days; expiry and deletion continue when email is turned off later. Delivery is at least once.
- Files: `apps/backend/src/services/mail/`, `apps/backend/src/lib/smtp-settings.ts`, migrations `074_email_outbox.sql` and `082_email_outbox_owner_notices.sql`.

### 1.8 JWT key id (`kid`) for forward-compatible rotation
- Every token stamped with `kid` (env `JWT_KEY_ID`, default `"default"`); enables future multi-key rotation without invalidating in-flight tokens.

---

## 2. Authorization

### 2.1 RBAC roles
- **Roles:** `owner`, `admin`, `member`, stored per-tenant in `tenant_memberships` and looked up on every authenticated request.
- File: `apps/backend/src/lib/auth-jwt.ts`.

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
- **Replay:** the upstream calls `verifyProxyHeaders` with the raw body and its server ID. The timestamp is Unix ms as 1 to 16 ASCII digits with a value of at most 2^53 - 1. The function accepts it only if `now - maxAgeMs <= timestamp <= now + maxFutureSkewMs`. Rejections are `stale_timestamp` and `future_timestamp`. On success the function returns `keepNonceUntil` (`timestamp + maxAgeMs`). The upstream must keep the nonce for as long as any of its verifiers can accept the request again. Keeping it for `maxAgeMs` from receipt is not sufficient: when the framework clock is ahead, the request stays valid after that time and can be replayed. Expiry by wall clock, such as a store TTL, is not sufficient either when clocks differ or go backward. After a successful verification, the upstream must run these steps as one atomic operation on the nonce store (a lock in one process; a transaction or script in a shared store). `R` is one retention value for the store, at least the largest `maxAgeMs` of its verifiers, and `until = timestamp + R`:
  1. Set `now = max(callerNow, highWater)` and `highWater = now`. All verifiers share `highWater`, and it never goes backward.
  2. Reject the request as stale if `until < now`.
  3. Delete every entry whose `until < now`.
  4. Reject the request as a replay if the store holds the nonce.
  5. Insert the nonce with its `until`.

  This holds for any clock difference or delay. When one clock runs fast, the other verifiers reject requests as stale until their clocks catch up. `R` is fixed for the life of the store: a verifier can lower its `maxAgeMs` or change `maxFutureSkewMs` at any time, but raising `maxAgeMs` above `R` is not covered, because a larger `R` can make a request valid again after its nonce was deleted. The store must not lose a recorded nonce, and `highWater` must not go backward, also through restart and failover; a store that can lose them without notice (a cache without persistence, or Redis with asynchronous replication and failover) does not meet this contract. In Redis, use one Lua script with `callerNow` and `until` as arguments, `highWater` in one key and the nonces in a sorted set scored by `until`, both keys in the same cluster hash slot. Do not depend on key expiry.
- **Replay rollout (2026-10-27):** the future limit was `maxAgeMs` and is now `maxFutureSkewMs`, default 30 s. An upstream whose clock is behind the framework clock by more than this rejects requests with `future_timestamp`. To keep the old window, pass `maxFutureSkewMs: maxAgeMs`; this is safe only with the retention rule above. This change does not update deployed upstreams: each upstream must first change its own nonce retention (safe alone), then measure the clock difference, then lower the skew.
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
- Independently configured for chat prompts, file uploads, and each import source that an overlay registers.
- A stored policy that does not match the schema never turns protection off without a trace. Each valid field stays. An invalid field gets a safe value: a scope is on, matched values are not kept, and an unsupported personal data type is ignored. When the stored on/off choice cannot be trusted (for example, `enabled: true` with mode `off`, or an invalid `enabled` with an active mode), content in scope is stopped with `pii_policy_invalid` before any provider call, and nothing is deleted. The server logs the reason codes and field paths, the PII dashboard shows them, and an admin save repairs the policy. The server never saves the recovered policy itself.
- An admin save names the PII settings revision that its form loaded. When another save changed the settings first, the server refuses the save with `409 pii_settings_conflict` and writes nothing, and the admin page asks the admin to reload. For compatibility, a save without a revision (from an older frontend) is not checked.

### 11.4 Sync vs async routing
- **Sync:** `block`, `transform`, and `detect` for chat (so scan-run id can attach to the message).
- **Async:** `detect` for uploads (background scan job).
- A queued scan applies the PII policy in force when the job runs, not the policy at enqueue time. A stricter policy saved after the upload applies to queued content at once. The scan records the mode that it applied and the settings revision that it read, from the same read that made the decision: on the file's PII detail (`modeApplied`, `policyRevision`), on the scan run (`mode`, `policy_revision`), and in the `pii_reported`, `pii_blocked`, or `pii_transformed` audit event (`mode`, `policyRevision`). Mode `off` means that the scan applied no check, because protection was off or the subject was out of scope. The file list shows such a file as "PII: not scanned", not as clean, and the admin PII views show "Not scanned". The job keeps the mode at enqueue time.
- A queued scan records its decision before it applies it, so before a block deletes the bytes. A retry, or the recovery of a failed job, finishes that decision with its mode and revision and does not evaluate the subject again. A retry writes the `pii_reported`, `pii_blocked`, `pii_transformed`, or `pii_block_object_orphaned` event of the decision only when the event for the scan run does not exist yet. Two attempts of one job that run at the same time (a claim that expired while its attempt still ran) can both write an event.
- A synchronous upload scan reads the policy once. That read routes the upload, makes the decision, and gives the recorded mode and `policyRevision`. A chat prompt scan records the revision that its decision read on the scan run, the message detail, and the audit event. Every `pii_policy_invalid` event records the revision that it read.

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
- **Auth mutations** (`/auth/callback`, `/auth/refresh`, `/auth/logout`, and the local sign-in, link, step-up, and password routes): `Origin` must equal `API_ORIGIN`; a missing or `null` Origin is refused (403 `csrf_origin_mismatch`), and a form body type is refused (415). The callback also requires a JSON body. File: `apps/backend/src/lib/browser-auth-origin.ts`.
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

Per-tenant settings in `tenant_settings` (one row per tenant; `system` row is platform default). A save needs step-up from a local session and emails every owner (see "Data routes" in 1.8a).

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

- **CI thresholds:** `pnpm test:coverage` and `pnpm test:coverage:frontend` are CI gates. They count every eligible production file, including files that no test imports. `.coverage-thresholds.json` holds the floors and the dated measurements they come from. The imported-module runs use a different denominator and are a manual diagnostic that CI does not run. Backend unit coverage does not include the Postgres integration suite, and unit-test fakes do not prove database policies.
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
| Auth (WorkOS) | `apps/backend/src/lib/auth-jwt.ts` |
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
