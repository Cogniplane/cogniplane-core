# Data and tenancy

Scope: tenant isolation, database pools, tenant settings, user settings,
retention and deletion, persistence, audit, usage, rate limits. Projects and
artifacts are in [projects and files](projects-and-files.md). PII is in [PII
protection](pii.md).
The SQL in `apps/backend/db/migrations/` is authoritative for the schema.

## Tenant isolation

- One database and schema for all tenants. Tenant-owned tables have `tenant_id`
  ([Persistence](#persistence) names the exceptions). Every tenant store method
  takes `tenantId` first.
- Wrap every tenant query in `withTenantScope(db, tenantId, fn)` (`lib/db.ts`).
  It sets `app.current_tenant_id` with `set_config(..., true)` in a transaction.
- RLS policies compare `tenant_id` with that setting, so a query without the
  setting sees no tenant rows. Exception: SELECT on `admin_skills`,
  `admin_skill_revisions` and `admin_mcp_servers` also returns `system` rows,
  which every tenant shares. RLS is the second layer, not a replacement for the
  explicit `tenant_id` predicate.
- Use parameterized SQL only (`$1`, `$2`, ...).
- Checkpoint tables: see [runtime](runtime.md#checkpointer). RLS tests are in
  `apps/backend/src/integration/`.

## Add a tenant table

1. Add a numbered migration with `tenant_id`, a foreign key to `tenants` with
   `ON DELETE CASCADE` (tenant deletion deletes the `tenants` row), and:
   ```sql
   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
   ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON <t>
     USING (tenant_id = current_setting('app.current_tenant_id', true))
     WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
   ```
   Add no grant: the migration runner grants it ([database
   roles](../database-roles.md)).
2. Write a store whose methods take `tenantId` first and use `withTenantScope`.
3. If a cross-tenant worker needs the table, add grants to `MAINTENANCE_GRANTS`
   ([database roles](../database-roles.md#maintenance-grants)).
4. Add the table and its production writer to `WRITE_PATHS` in
   `apps/backend/src/integration/rls-write-paths.integration.test.ts`.
   `rls-catalog.integration.test.ts` and that test fail for a tenant table that
   lacks either.
5. If the table holds storage keys, add them to the cleanup list in
   `services/tenant-deletion-service.ts`.

## Database pools

- `db` (`app_user`, under RLS) serves all normal requests.
- `privilegedDb` (`maintenance_user`, BYPASSRLS) is for work that RLS cannot
  authorize: sign-in lookups before the tenant is known, worker claims,
  recovery, download tokens, retention. Rules: [tenant data
  invariant](../security.md#tenant-data).
- Roles, grants and startup checks: [database roles](../database-roles.md).

## Tenant settings

- `tenant_settings` has one row per tenant and is the source of runtime policy.
  A missing value takes the code default (`buildDefaultTenantSettingsInput` in
  `services/tenant-settings-store.ts`), not the `system` row. A tenant without a
  row gets one on first read. `DynamicConfigService`
  (`services/dynamic-config-service.ts`) compiles it into the per-turn runtime
  policy snapshot.

Fields that agents change most often (the full list is `TenantSettingsSchema` in
`packages/shared-types`):

| Field | Purpose |
|---|---|
| `enabled_tool_ids`, `enabled_mcp_server_ids` | Managed tools and MCP servers available to the agent |
| `approval_policy`, `auto_approve_read_only_tools` | Native approvals |
| `policy_enforcement_mode` | [Policy Center](policy-center.md) `monitor` or `enforce` |
| `allow_command_execution` | Sandbox and `execute` tool |
| `approved_sandbox_egress_domains` | Sandbox network allowlist; empty means no network |
| `developer_instructions` | Extra system prompt text |
| `show_effort_selector` | Effort selector in the chat |

- Inert fields: `approval_reviewer` (shown in admin views; no runtime effect)
  and `web_search_mode` (recorded in the runtime manifest; no tool uses it). Do
  not build on them.
- Only owners change `allow_command_execution`. Admin writes drop unchanged
  copies of owner-only fields (`routes/admin/admin-tenant-settings-routes.ts`),
  so a stale form cannot overwrite an owner decision.
- A save that changes a protected field is a [data
  route](sensitive-changes.md#data-routes).
- After a settings save, cached session runtimes compare the config hash and
  refresh their capabilities in place before the next turn (`runtimeRefresh:
  "next_turn_in_place"`). The sandbox stays, except when its network no longer
  matches the approved hosts.
- Provider keys and model enablement fields:
  [models](models.md#model-providers).

## User settings

- `user_settings_sections` keeps one JSON config per user and section key
  (`scheduled_jobs`, `github`, `skills`, `mcp`, `model`). `PUT
  /me/settings/:section` (`routes/settings.ts`) replaces a config, adds 1 to
  its version and writes the audit event `user.settings.updated`.
- Only the scheduled jobs page reads a config: `defaultTimeZone` and
  `enableOnCreate` of `scheduled_jobs`, through `GET /me/settings`. The
  backend only stores and returns the sections; it does not check what a
  config contains. The GitHub page uses the GitHub connection routes, not the
  `github` section.
- Size limit: 65,536 bytes (`SETTINGS_SECTION_MAX_BYTES`). Fastify refuses a
  larger request body before it parses it. The route then refuses a config
  whose stored text, `JSON.stringify(config)` in UTF-8, is larger. Both
  answer 413 `settings_section_too_large` with fixed text. Rows that an
  earlier version saved can be larger; they stay as they are.
- Each save uses the `settings_write` rate limit
  (`SETTINGS_WRITE_LIMIT_PER_USER_PER_WINDOW`,
  `SETTINGS_WRITE_LIMIT_PER_TENANT_PER_WINDOW`) before any database write.
  Each request that gets to the route handler counts, also a request that
  fails validation. A body over the size limit does not count: Fastify refuses
  it first.
- A scheduled job does not copy the sections:
  [scheduler](runtime.md#scheduler).

## Retention and deletion

- Retention of `audit_events` and `tool_events`: [audit
  retention](../operations.md#audit-retention).
- Session trash and project file retention run in the scheduler worker
  ([background workers](runtime.md#background-workers)).
- Deleted sessions go to trash for `SESSION_TRASH_RETENTION_DAYS`
  (`SESSION_TRASH_RETENTION_ENABLED`). The delete kills the session sandbox
  ([sandbox](sandbox.md#e2b-sandbox)). Purge removes messages, storage objects
  and the checkpoint thread, and kills a sandbox that the row still names (a row
  that an earlier version moved to trash).
- `PROJECT_FILE_RETENTION_ENABLED` (scheduler,
  `ProjectFileStore.cleanupExpired`) deletes promoted files and files in the
  trash for more than 30 days, with their versions. It does not prune the
  versions of a live file.
- When the job deletes the target of an update draft, it deletes the draft
  only if the draft is promoted or was in the trash for more than 30 days. It
  keeps every other draft, also a draft in the trash for less than 30 days,
  with its versions and objects. The kept draft loses its target and base
  version and becomes a new-file draft. A draft in the trash keeps its trash
  date, so its own 30 days do not restart. The `project_file_retention_deleted`
  audit event lists these drafts in `detachedFileIds`.
- Skill revision cleanup runs only when an admin calls it
  ([skills](skills.md#import-and-lifecycle)).
- Spending records stay when sessions or messages are deleted.
- Tenant deletion is an operator command. See
  [operations](../operations.md#delete-a-tenant).

## Persistence

- The migrations are the schema. To find the store that owns a table, run `git
  grep -lE "(FROM|INTO|UPDATE) <table>\b" apps/backend/src/services`.
- Tables without `tenant_id` are listed in `GLOBAL_TABLES` in
  `apps/backend/src/integration/rls-catalog.integration.test.ts`; every other
  table is tenant-owned and must have RLS.
- `deep_agents.*` holds checkpoints ([runtime](runtime.md#checkpointer)).
- `platform_events` is global, without RLS (`services/platform-event-store.ts`).
  It holds tenant-agnostic events, such as PII breaker transitions; write no
  tenant data to it.
- `001_init.sql` is the consolidated baseline; `002_seed_system_data.sql` seeds
  the `system` tenant. Migration rules:
  [development](../development.md#conventions).

## Audit and observability

- `audit_events` (`services/audit-event-store.ts`, event names in
  `services/audit-event-types.ts`) records auth, admin, approval, tool, skill
  and integration actions with `ip_address` and `user_agent`. Payloads pass
  through `redactSecrets()` before insert.
- `tool_events` is the redacted tool-call log. `resource_activations` records
  skill, MCP and integration use per turn (`services/activation-tracker.ts`).
- Admin > History (`GET /admin/history`, `routes/admin/admin-history-routes.ts`)
  shows only the audit event types and fields that `HISTORY_EVENTS`
  (`services/admin-history-projection.ts`) allows, never raw payloads.
- Add an audit event: add its name to `AUDIT_EVENT_TYPES`
  (`services/audit-event-types.ts`; an overlay augments `OverlayAuditEventTypes`
  instead) and call `auditEvents.create` where the change happens. To show it in
  Admin > History, add an entry with its displayable fields to `HISTORY_EVENTS`;
  put no secret or free text there.
- Per-turn token usage and `cost_usd` are on `messages`.
- Usage: `GET /admin/token-usage` (`routes/admin/admin-token-usage-routes.ts`)
  groups by day, user or model over a rolling window of 1 to 365 days, or the
  current UTC month (`period=current_month`), optionally for one `userId`.
- Feedback: `PATCH /messages/:messageId/feedback` (`thumbs_up` or `thumbs_down`,
  optional notes) works only on an assistant message of the caller's own turn
  (`MessageStore.updateFeedback`). `GET /admin/message-feedback` returns totals,
  daily counts and counts per model (`routes/message-feedback-routes.ts`).
- Logs and monitoring: [operations](../operations.md#monitor).

## Redis

With `REDIS_URL`, replicas share this short-lived state; without it, each
process keeps it in memory. Redis holds no durable business data: losing or
flushing it costs only the effects below. Give each environment its own Redis
database ([tenant deletion flushes it](../operations.md#delete-a-tenant)).

| State | Code | Loss or flush |
|---|---|---|
| Refresh token families and rotation | `lib/refresh-token-store.ts` | Every user signs in again |
| Sign-in flows, step-up tokens, passkey challenges, login throttle | `services/auth/` (`login-flow-store.ts`, `step-up-store.ts`, `passkey-challenge-store.ts`, `login-throttle.ts`) | Started flows and step-ups must restart; throttle counts reset |
| Integration OAuth states | `services/integrations/integration-oauth-state-store.ts` | A connect in progress fails; the member retries |
| Rate limit and quota counters | `services/redis-request-limits.ts` | Counters reset |
| PII provider circuit breaker | `services/pii/pii-circuit-breaker.ts` | The breaker closes |
| Turn event streams and stop signals | `services/turn-coordination-bus.ts` | Another replica cannot replay a running turn. A stop still takes effect: the database fences the turn at once, and the owner replica aborts it at its next heartbeat ([reconnect and stop](runtime.md#reconnect-and-stop)) |
| Policy rule cache invalidation (pub/sub) | `services/policy/policy-cache-invalidation.ts` | Other replicas keep cached rules until `ruleCacheTtlMs` |

Running-turn caps ([sessions and turns](runtime.md#sessions-and-turns)) do not
use Redis: they count in process and through the `session_executions` lease.

## Rate limits and quotas

- `services/request-limits.ts` (in-memory) and `redis-request-limits.ts`
  (shared, when `REDIS_URL` is set) apply per-user and per-tenant windows
  (`RATE_LIMIT_WINDOW_MS`, `*_LIMIT_PER_USER_PER_WINDOW`,
  `*_LIMIT_PER_TENANT_PER_WINDOW`) and daily turn quotas
  (`TURN_QUOTA_PER_*_PER_DAY`, UTC days). Meaning of `0`: [startup
  rules](../configuration.md#startup-rules).
- A refusal returns `LimitExceededErrorPayload` with `retryAfterMs` and
  `resetAt`. Auth routes also send `Retry-After` in seconds
  (`services/rate-limit-reply.ts`).
- Auth limits. The sign-in and refresh limits count one subject per request
  and have no tenant scope: sign-in has no verified tenant, and a tenant-wide
  refresh count would let one tenant's traffic refuse all of its members.
  - Sign-in, per client IP (`AUTH_SIGN_IN_LIMIT_PER_IP_PER_WINDOW`): WorkOS
    login and callback, the public local steps, and local step-up and password
    change. The local routes answer 503 when the limiter fails; the WorkOS
    routes continue. The per-email throttle of local accounts is separate
    ([local accounts](local-accounts.md)).
  - Refresh and sign-out (`AUTH_REFRESH_LIMIT_PER_FAMILY_PER_WINDOW`): per
    refresh family, read from the token after its signature check. A request
    without a valid refresh token counts per client IP. Thus sign-in traffic,
    other people behind the same IP, and a revoked family cannot refuse a valid
    session. A limiter failure lets the request through.
  - Integration OAuth callbacks, per client IP (`OAUTH_CALLBACK_LIMIT_*`).
- Upgrade: `OAUTH_CALLBACK_LIMIT_*` no longer controls sign-in, refresh or
  sign-out. If you changed those settings for authentication traffic, set
  `AUTH_SIGN_IN_LIMIT_PER_IP_PER_WINDOW` and
  `AUTH_REFRESH_LIMIT_PER_FAMILY_PER_WINDOW` too. Otherwise their defaults
  apply, including when you previously disabled the shared limit with `0`.
- The client IP is `request.ip`, which follows `TRUST_PROXY`. Behind a proxy
  with `TRUST_PROXY=false`, all clients have the proxy address and share one
  sign-in limit. In jwt mode, each start logs a warning while `TRUST_PROXY` is
  `false` or `true` (`registerTrustProxyWarnings` in `app.ts`).
- `resource_read` is one budget for three member reads that do heavy work on
  each call. The artifact and project file version PDF previews
  (`GET .../preview-text`) run `pdftotext`. The MCP App resource route
  (`GET /sessions/:sessionId/mcp-apps/:toolCallId`) compiles the runtime
  config, checks policy and can send a signed `resources/read` upstream. The
  three routes share one counter per user and one per tenant
  (`RESOURCE_READ_LIMIT_PER_*_PER_WINDOW`), so a client gets no more calls by
  alternating routes. The check (`lib/resource-read-limit.ts`) runs after
  input validation and before any lookup, so a 404 or 422 also counts.
- Each saved widget in a chat loads its resource when it renders. In a chat
  with more widgets than the user limit, each widget after the limit shows an
  error and a reload button; a reload works when the next window starts. For
  chats like this, increase `RESOURCE_READ_LIMIT_PER_USER_PER_WINDOW`.
