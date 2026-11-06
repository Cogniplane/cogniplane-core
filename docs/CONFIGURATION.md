# Backend configuration

[config.ts](../apps/backend/src/config.ts) defines the backend environment variables,
validation and defaults. Start local development with
[the backend example](../apps/backend/.env.example). The table below includes every
schema key and is generated from the source without reading deployment secrets.
Run `pnpm exec tsx scripts/generate-config-reference.ts` after changing the schema.
The test suite checks that this reference stays current.

Values are environment strings. Boolean values `1`, `true`, `yes` and `on` are true,
ignoring case and surrounding whitespace. Other strings are false. Numeric bounds
apply to values; string bounds apply to character counts. `_MS` values are milliseconds,
`_BYTES` values are bytes, and `_DAYS` values are days. `unset` means the schema has
no default, though startup or a consumer may derive a value as described below.
`<system-temp>` is Node's operating-system temporary directory.

## Startup and related settings

- `AUTH_MODE=jwt` requires Redis, distinct application and maintenance database
  URLs, and non-default JWT and data-encryption secrets. The application role must be
  subject to RLS. `AUTH_LOGIN_TYPES` lists the login types it enables (default
  `workos`). WorkOS login also requires WorkOS credentials and a redirect URI.
  `AUTH_MODE=workos` is the earlier name for `jwt` with `AUTH_LOGIN_TYPES=workos`.
- Each tenant has one login type, set when the tenant is created. It cannot change
  later. `local` needs Node 24.7 or later (`crypto.argon2`); startup refuses it
  otherwise. `auth:bootstrap` creates a local tenant and its first owner.
- Passkeys for local accounts are on only when `WEBAUTHN_RP_ID` is set. It must
  be the hostname of `API_ORIGIN` (the frontend) or a parent domain of it, and
  `local` must be in `AUTH_LOGIN_TYPES`; startup refuses it otherwise. Passkeys
  are bound to this value: a later change makes every registered passkey stop
  working. `WEBAUTHN_RP_NAME` is the name that browsers show (default
  `Cogniplane`).
- Every backend instance requires `MAINTENANCE_DATABASE_URL`, including local dev.
  Migrations provision `maintenance_user` with BYPASSRLS and explicit table grants.
  Startup rejects administrative privileges, role memberships, object ownership,
  and schema creation rights. It never falls back to `MIGRATION_DATABASE_URL`.
- Supply `MIGRATION_DATABASE_URL` only to migration and explicit operator commands.
  The migration command also needs the application and maintenance passwords to
  provision their roles. Container stacks run migrations in a separate service.
  See [the database role runbook](DATABASE_ROLES.md) before upgrading.
- `API_HOST` defaults to IPv4 loopback for dev headers and `::` for `jwt`.
  Dev-header authentication is for development. Binding it beyond loopback requires
  the explicit opt-in and a `DEV_HEADERS_AUTH_KEY` of at least 16 characters.
  Production WorkOS deployments must replace the development secrets in the table.
  `ADMIN_USER_IDS` is a comma-separated list for dev-header authentication and
  defaults to `LOCAL_DEV_USER_ID` when unset. WorkOS roles come from memberships.
- `TRUST_PROXY` accepts `false`, `true`, or a comma-separated IP/CIDR list. Numeric
  hop counts are rejected. Behind a proxy, supply its actual addresses so clients
  do not share the proxy's authentication rate-limit bucket. `true` trusts every hop.
- Runtime startup requires an E2B API key and a real template ID. Build the template
  with `make e2b-build`. Migration commands skip runtime-only checks.
  `RUNTIME_GATEWAY_BASE_URL` must name a loopback host.
- GitHub and Notion OAuth each require all three provider variables together.
  Set the client ID and client secret from the provider's app registration. Set
  `GITHUB_OAUTH_REDIRECT_URI` to the backend's `/auth/github/user/callback`
  endpoint and `NOTION_OAUTH_REDIRECT_URI` to `/integrations/notion/callback`.
  Register the same HTTPS URL with the provider. WorkOS uses the frontend
  `/auth/callback` URL instead.
- Provider API keys are optional server-wide fallbacks. Prefer tenant keys in
  organization settings when tenants should supply their own credentials.
  `MCP_UPSTREAM_SIGNING_SECRET` overrides the proxy signing key; unset derives a
  separate key from `DATA_ENCRYPTION_SECRET`. It does not replace the root secret.
- Bucket storage requires the matching bucket name. Explicit artifact bucket
  access and secret keys must be supplied together. Skill bundles share the
  artifact bucket connection settings. Relative storage paths resolve against the
  repository root. Outside production, artifact and skill-bundle storage paths
  inside the repository are replaced with the system-temp defaults.
- A positive turn timeout must exceed the approval TTL and remain below the E2B
  sandbox timeout. The tool-context TTL must exceed the turn timeout plus one
  approval TTL. Setting the turn timeout to zero disables its watchdog. The
  execution lease must exceed twice its heartbeat interval.
- Enabling the utility LLM requires its base URL and model. `openai` wire format
  appends `/chat/completions`; `ollama` appends `/api/chat`. Disable-thinking flags
  apply only to Ollama. Enabling the PII provider requires its API key. Reversible
  PII retention requires a 32-byte key encoded as 64 hex characters.
- `PDFTOTEXT_BINARY_PATH` must name a pdftotext executable. Its basename must be
  `pdftotext` or start with `pdftotext.` or `pdftotext-`.
- Rate limits use the shared window duration. A zero rate limit or daily turn
  quota disables that limit. `SCHEDULED_JOB_MAX_ACTIVE_PER_USER=0` removes the job
  count cap. `SESSION_TRASH_RETENTION_DAYS=0` disables restoration and makes deleted
  sessions eligible for the next cleanup. Disabling the retention worker stops
  cleanup, not the configured retention policy.
  `PROJECT_FILE_RETENTION_ENABLED` controls old-version cleanup. PII scan jobs can
  still run when the scheduled-job worker is disabled.

`NODE_ENV` is read outside the schema to enforce development authentication and
storage behavior. Use `production` in production. Frontend variables belong to
[the frontend example](../apps/frontend/.env.example); `NEXT_PUBLIC_*` values are
embedded during the frontend build and are public to browser users.

## Environment reference

<!-- generated configuration table -->

| Variable | Accepted value | Default when unset |
| --- | --- | --- |
| [`API_HOST`](../apps/backend/src/config.ts#L43) | string | `unset` |
| [`API_PORT`](../apps/backend/src/config.ts#L44) | number, integer, > 0 | `3001` |
| [`API_ORIGIN`](../apps/backend/src/config.ts#L45) | string, URL | `"http://localhost:3000"` |
| [`DATABASE_URL`](../apps/backend/src/config.ts#L51) | string, minimum 1 | `"postgres://app_user:app_user_password@localhost:5432/cogniplane"` |
| [`MODEL_SPENDING_MONTHLY_LIMIT_USD`](../apps/backend/src/config.ts#L56) | number, minimum 0, maximum 1_000_000 | `unset` |
| [`MODEL_SPENDING_TURN_RESERVATION_USD`](../apps/backend/src/config.ts#L57) | number, minimum 0.000001, maximum 1_000_000 | `1` |
| [`LOCAL_DEV_USER_ID`](../apps/backend/src/config.ts#L58) | string, minimum 1 | `"local-dev-user"` |
| [`ADMIN_USER_IDS`](../apps/backend/src/config.ts#L59) | string | `unset` |
| [`ANTHROPIC_API_KEY`](../apps/backend/src/config.ts#L60) | string, minimum 1 | `unset` |
| [`OPENAI_API_KEY`](../apps/backend/src/config.ts#L65) | string, minimum 1 | `unset` |
| [`GOOGLE_API_KEY`](../apps/backend/src/config.ts#L66) | string, minimum 1 | `unset` |
| [`OPENROUTER_API_KEY`](../apps/backend/src/config.ts#L67) | string, minimum 1 | `unset` |
| [`ZAI_API_KEY`](../apps/backend/src/config.ts#L71) | string, minimum 1 | `unset` |
| [`TRUST_PROXY`](../apps/backend/src/config.ts#L83) | string | `"false"` |
| [`SESSION_TITLER_CLAUDE_MODEL`](../apps/backend/src/config.ts#L87) | string, minimum 1 | `"claude-haiku-5-5"` |
| [`SESSION_TITLER_TIMEOUT_MS`](../apps/backend/src/config.ts#L88) | number, integer, > 0 | `5000` |
| [`UTILITY_LLM_ENABLED`](../apps/backend/src/config.ts#L96) | boolean | `false` |
| [`UTILITY_LLM_BASE_URL`](../apps/backend/src/config.ts#L97) | string, URL | `unset` |
| [`UTILITY_LLM_API_KEY`](../apps/backend/src/config.ts#L98) | string, minimum 1 | `unset` |
| [`UTILITY_LLM_MODEL`](../apps/backend/src/config.ts#L99) | string, minimum 1 | `unset` |
| [`UTILITY_LLM_WIRE_FORMAT`](../apps/backend/src/config.ts#L100) | one of ["openai", "ollama"] | `"ollama"` |
| [`UTILITY_LLM_DISABLE_THINKING`](../apps/backend/src/config.ts#L101) | boolean | `false` |
| [`UTILITY_LLM_TIMEOUT_MS`](../apps/backend/src/config.ts#L102) | number, integer, > 0 | `10000` |
| [`RUNTIME_GATEWAY_BASE_URL`](../apps/backend/src/config.ts#L103) | string, URL | `"http://localhost:3001"` |
| [`RUNTIME_IDLE_TIMEOUT_MS`](../apps/backend/src/config.ts#L104) | number, integer, > 0 | `300000` |
| [`RUNTIME_TURN_TIMEOUT_MS`](../apps/backend/src/config.ts#L113) | number, integer, >= 0 | `1200000` |
| [`RUNTIME_TOKEN_TTL_MS`](../apps/backend/src/config.ts#L134) | number, integer, > 0 | `86400000` |
| [`TOOL_CONTEXT_TTL_MS`](../apps/backend/src/config.ts#L148) | number, integer, > 0 | `2100000` |
| [`SESSION_EXECUTION_LEASE_MS`](../apps/backend/src/config.ts#L149) | number, integer, minimum 10_000 | `30000` |
| [`SESSION_EXECUTION_HEARTBEAT_MS`](../apps/backend/src/config.ts#L150) | number, integer, > 0 | `5000` |
| [`APPROVAL_REQUEST_TTL_MS`](../apps/backend/src/config.ts#L151) | number, integer, > 0 | `600000` |
| [`ARTIFACT_STORAGE_BACKEND`](../apps/backend/src/config.ts#L152) | one of ["local", "bucket"] | `"local"` |
| [`ARTIFACT_STORAGE_ROOT`](../apps/backend/src/config.ts#L153) | string, minimum 1 | `"<system-temp>/cogniplane-core-artifacts"` |
| [`SKILL_BUNDLE_STORAGE_ROOT`](../apps/backend/src/config.ts#L154) | string, minimum 1 | `"<system-temp>/cogniplane-core-skills"` |
| [`SKILL_BUNDLE_STORAGE_BACKEND`](../apps/backend/src/config.ts#L155) | one of ["local", "bucket"] | `"local"` |
| [`SKILL_BUNDLE_BUCKET_NAME`](../apps/backend/src/config.ts#L156) | string, minimum 1 | `unset` |
| [`SKILL_BUNDLE_BUCKET_PREFIX`](../apps/backend/src/config.ts#L157) | string | `""` |
| [`SKILL_BUNDLE_CACHE_ROOT`](../apps/backend/src/config.ts#L158) | string, minimum 1 | `"<system-temp>/cogniplane-skill-cache"` |
| [`ARTIFACT_BUCKET_NAME`](../apps/backend/src/config.ts#L159) | string, minimum 1 | `unset` |
| [`ARTIFACT_BUCKET_REGION`](../apps/backend/src/config.ts#L160) | string, minimum 1 | `"us-east-1"` |
| [`ARTIFACT_BUCKET_ENDPOINT`](../apps/backend/src/config.ts#L161) | string, URL | `unset` |
| [`ARTIFACT_BUCKET_PREFIX`](../apps/backend/src/config.ts#L162) | string | `""` |
| [`ARTIFACT_BUCKET_FORCE_PATH_STYLE`](../apps/backend/src/config.ts#L163) | boolean | `false` |
| [`ARTIFACT_BUCKET_ACCESS_KEY_ID`](../apps/backend/src/config.ts#L164) | string, minimum 1 | `unset` |
| [`ARTIFACT_BUCKET_SECRET_ACCESS_KEY`](../apps/backend/src/config.ts#L165) | string, minimum 1 | `unset` |
| [`ARTIFACT_BUCKET_SESSION_TOKEN`](../apps/backend/src/config.ts#L166) | string, minimum 1 | `unset` |
| [`ARTIFACT_MAX_UPLOAD_BYTES`](../apps/backend/src/config.ts#L167) | number, integer, > 0 | `26214400` |
| [`MAX_REQUEST_BODY_BYTES`](../apps/backend/src/config.ts#L173) | number, integer, > 0 | `2097152` |
| [`LOG_LEVEL`](../apps/backend/src/config.ts#L176) | one of ["fatal", "error", "warn", "info", "debug", "trace", "silent"] | `"info"` |
| [`ARTIFACT_DOWNLOAD_TTL_MS`](../apps/backend/src/config.ts#L177) | number, integer, > 0 | `900000` |
| [`SKILL_BUNDLE_RETENTION_DAYS`](../apps/backend/src/config.ts#L178) | number, integer, minimum 0 | `30` |
| [`SESSION_TRASH_RETENTION_ENABLED`](../apps/backend/src/config.ts#L179) | boolean | `true` |
| [`SESSION_TRASH_RETENTION_DAYS`](../apps/backend/src/config.ts#L180) | number, integer, minimum 0 | `30` |
| [`SKILL_MARKETPLACE_MANIFEST_URL`](../apps/backend/src/config.ts#L181) | string, URL | `unset` |
| [`SKILL_MARKETPLACE_CACHE_TTL_MS`](../apps/backend/src/config.ts#L182) | number, integer, > 0 | `300000` |
| [`PDFTOTEXT_BINARY_PATH`](../apps/backend/src/config.ts#L186) | string, minimum 1, additional validation in source | `"pdftotext"` |
| [`RATE_LIMIT_WINDOW_MS`](../apps/backend/src/config.ts#L194) | number, integer, > 0 | `60000` |
| [`SESSION_CREATE_LIMIT_PER_USER_PER_WINDOW`](../apps/backend/src/config.ts#L195) | number, integer, minimum 0 | `10` |
| [`SESSION_CREATE_LIMIT_PER_TENANT_PER_WINDOW`](../apps/backend/src/config.ts#L196) | number, integer, minimum 0 | `50` |
| [`MESSAGE_LIMIT_PER_USER_PER_WINDOW`](../apps/backend/src/config.ts#L197) | number, integer, minimum 0 | `20` |
| [`MESSAGE_LIMIT_PER_TENANT_PER_WINDOW`](../apps/backend/src/config.ts#L198) | number, integer, minimum 0 | `100` |
| [`MAX_RUNNING_TURNS_PER_USER`](../apps/backend/src/config.ts#L199) | number, integer, > 0 | `5` |
| [`MAX_RUNNING_TURNS_PER_TENANT`](../apps/backend/src/config.ts#L200) | number, integer, > 0 | `50` |
| [`ARTIFACT_UPLOAD_LIMIT_PER_USER_PER_WINDOW`](../apps/backend/src/config.ts#L202) | number, integer, minimum 0 | `20` |
| [`ARTIFACT_UPLOAD_LIMIT_PER_TENANT_PER_WINDOW`](../apps/backend/src/config.ts#L203) | number, integer, minimum 0 | `100` |
| [`PROJECT_FILE_WRITE_LIMIT_PER_USER_PER_WINDOW`](../apps/backend/src/config.ts#L205) | number, integer, minimum 0 | `20` |
| [`PROJECT_FILE_WRITE_LIMIT_PER_TENANT_PER_WINDOW`](../apps/backend/src/config.ts#L206) | number, integer, minimum 0 | `100` |
| [`SCHEDULED_JOB_CREATE_LIMIT_PER_USER_PER_WINDOW`](../apps/backend/src/config.ts#L210) | number, integer, minimum 0 | `10` |
| [`SCHEDULED_JOB_CREATE_LIMIT_PER_TENANT_PER_WINDOW`](../apps/backend/src/config.ts#L211) | number, integer, minimum 0 | `50` |
| [`SCHEDULED_JOB_MAX_ACTIVE_PER_USER`](../apps/backend/src/config.ts#L215) | number, integer, minimum 0 | `50` |
| [`OAUTH_CALLBACK_LIMIT_PER_USER_PER_WINDOW`](../apps/backend/src/config.ts#L219) | number, integer, minimum 0 | `20` |
| [`OAUTH_CALLBACK_LIMIT_PER_TENANT_PER_WINDOW`](../apps/backend/src/config.ts#L220) | number, integer, minimum 0 | `100` |
| [`ADMIN_QUERY_LIMIT_PER_USER_PER_WINDOW`](../apps/backend/src/config.ts#L224) | number, integer, minimum 0 | `300` |
| [`ADMIN_QUERY_LIMIT_PER_TENANT_PER_WINDOW`](../apps/backend/src/config.ts#L225) | number, integer, minimum 0 | `1000` |
| [`AUTH_ORGANIZATIONS_LIMIT_PER_USER_PER_WINDOW`](../apps/backend/src/config.ts#L229) | number, integer, minimum 0 | `20` |
| [`AUTH_ORGANIZATIONS_LIMIT_PER_TENANT_PER_WINDOW`](../apps/backend/src/config.ts#L230) | number, integer, minimum 0 | `100` |
| [`TURN_QUOTA_PER_USER_PER_DAY`](../apps/backend/src/config.ts#L231) | number, integer, minimum 0 | `200` |
| [`TURN_QUOTA_PER_TENANT_PER_DAY`](../apps/backend/src/config.ts#L232) | number, integer, minimum 0 | `1000` |
| [`PROJECT_FILE_RETENTION_ENABLED`](../apps/backend/src/config.ts#L233) | boolean | `true` |
| [`SCHEDULER_ENABLED`](../apps/backend/src/config.ts#L234) | boolean | `true` |
| [`SCHEDULER_POLL_INTERVAL_MS`](../apps/backend/src/config.ts#L235) | number, integer, > 0 | `30000` |
| [`SCHEDULER_MAX_CONCURRENT_JOBS`](../apps/backend/src/config.ts#L236) | number, integer, > 0 | `2` |
| [`SCHEDULER_JOB_TIMEOUT_MS`](../apps/backend/src/config.ts#L237) | number, integer, > 0 | `300000` |
| [`SCHEDULER_MAX_CONSECUTIVE_FAILURES`](../apps/backend/src/config.ts#L244) | number, integer, > 0 | `5` |
| [`PII_SCAN_MAX_CONCURRENT_JOBS`](../apps/backend/src/config.ts#L249) | number, integer, > 0 | `2` |
| [`AUTH_MODE`](../apps/backend/src/config.ts#L254) | one of ["jwt", "workos", "dev-headers"] | `"dev-headers"` |
| [`AUTH_LOGIN_TYPES`](../apps/backend/src/config.ts#L257) | string | `unset` |
| [`LOCAL_AUTH_HASH_CONCURRENCY`](../apps/backend/src/config.ts#L261) | number, integer, minimum 1, maximum 64 | `4` |
| [`WEBAUTHN_RP_ID`](../apps/backend/src/config.ts#L266) | string, minimum 1 | `unset` |
| [`WEBAUTHN_RP_NAME`](../apps/backend/src/config.ts#L268) | string, minimum 1, maximum 64 | `"Cogniplane"` |
| [`SMTP_URL`](../apps/backend/src/config.ts#L274) | string, minimum 1 | `unset` |
| [`MAIL_FROM`](../apps/backend/src/config.ts#L276) | string, minimum 1, maximum 320 | `unset` |
| [`SMTP_ALLOW_PLAINTEXT`](../apps/backend/src/config.ts#L279) | boolean | `false` |
| [`COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK`](../apps/backend/src/config.ts#L282) | boolean | `false` |
| [`DEV_HEADERS_AUTH_KEY`](../apps/backend/src/config.ts#L286) | string, minimum 16 | `unset` |
| [`DATA_ENCRYPTION_SECRET`](../apps/backend/src/config.ts#L287) | string, minimum 32 | `"local-dev-data-encryption-secret-change-in-production!!"` |
| [`MCP_UPSTREAM_SIGNING_ROOT_SECRET`](../apps/backend/src/config.ts#L295) | string, minimum 32 | `unset` |
| [`MCP_UPSTREAM_SIGNING_SECRET`](../apps/backend/src/config.ts#L298) | string | `unset` |
| [`MCP_UPSTREAM_TIMEOUT_MS`](../apps/backend/src/config.ts#L302) | number, integer, > 0 | `30000` |
| [`MCP_UPSTREAM_MAX_RESPONSE_BYTES`](../apps/backend/src/config.ts#L306) | number, integer, > 0 | `4194304` |
| [`MCP_CONNECTION_TEST_TIMEOUT_MS`](../apps/backend/src/config.ts#L308) | number, integer, > 0, maximum 30_000 | `8000` |
| [`WORKOS_API_KEY`](../apps/backend/src/config.ts#L309) | string, minimum 1 | `unset` |
| [`WORKOS_CLIENT_ID`](../apps/backend/src/config.ts#L310) | string, minimum 1 | `unset` |
| [`WORKOS_REDIRECT_URI`](../apps/backend/src/config.ts#L311) | string, URL | `unset` |
| [`GITHUB_OAUTH_CLIENT_ID`](../apps/backend/src/config.ts#L312) | string, minimum 1 | `unset` |
| [`GITHUB_OAUTH_CLIENT_SECRET`](../apps/backend/src/config.ts#L313) | string, minimum 1 | `unset` |
| [`GITHUB_OAUTH_REDIRECT_URI`](../apps/backend/src/config.ts#L314) | string, URL | `unset` |
| [`NOTION_OAUTH_CLIENT_ID`](../apps/backend/src/config.ts#L315) | string, minimum 1 | `unset` |
| [`NOTION_OAUTH_CLIENT_SECRET`](../apps/backend/src/config.ts#L316) | string, minimum 1 | `unset` |
| [`NOTION_OAUTH_REDIRECT_URI`](../apps/backend/src/config.ts#L317) | string, URL | `unset` |
| [`PIPEDREAM_CLIENT_ID`](../apps/backend/src/config.ts#L321) | string, minimum 1 | `unset` |
| [`PIPEDREAM_CLIENT_SECRET`](../apps/backend/src/config.ts#L322) | string, minimum 1 | `unset` |
| [`PIPEDREAM_PROJECT_ID`](../apps/backend/src/config.ts#L323) | string, matches /^proj_[A-Za-z0-9]+$/ | `unset` |
| [`PIPEDREAM_PROJECT_ENVIRONMENT`](../apps/backend/src/config.ts#L324) | one of ["development", "production"] | `"development"` |
| [`MIGRATION_DATABASE_URL`](../apps/backend/src/config.ts#L326) | string, URL | `unset` |
| [`MAINTENANCE_DATABASE_URL`](../apps/backend/src/config.ts#L328) | string, URL | `unset` |
| [`JWT_SECRET`](../apps/backend/src/config.ts#L329) | string, minimum 32 | `"local-dev-jwt-secret-change-in-production!!"` |
| [`JWT_KEY_ID`](../apps/backend/src/config.ts#L332) | string, minimum 1, maximum 128, matches /^[A-Za-z0-9._-]+$/ | `"default"` |
| [`JWT_VERIFICATION_KEYS`](../apps/backend/src/config.ts#L333) | JSON object of key IDs to secrets of at least 32 characters | `{}` |
| [`REDIS_URL`](../apps/backend/src/config.ts#L334) | string, URL | `unset` |
| [`E2B_API_KEY`](../apps/backend/src/config.ts#L335) | string, minimum 1 | `unset` |
| [`E2B_TEMPLATE_ID`](../apps/backend/src/config.ts#L339) | string, minimum 1 | `"replace-with-your-template-id"` |
| [`E2B_SANDBOX_TIMEOUT_MS`](../apps/backend/src/config.ts#L340) | number, integer, > 0 | `1800000` |
| [`DEEP_AGENTS_EXECUTE_TIMEOUT_MS`](../apps/backend/src/config.ts#L345) | number, integer, > 0 | `120000` |
| [`E2B_NETWORK_CONFIRM_TIMEOUT_MS`](../apps/backend/src/config.ts#L357) | number, integer, > 0 | `20000` |
| [`E2B_NETWORK_REQUEST_TIMEOUT_MS`](../apps/backend/src/config.ts#L361) | number, integer, > 0 | `5000` |
| [`PII_PROVIDER_ENABLED`](../apps/backend/src/config.ts#L362) | boolean | `false` |
| [`PII_LLM_BASE_URL`](../apps/backend/src/config.ts#L374) | string, URL | `"https://openrouter.ai/api/v1"` |
| [`PII_LLM_API_KEY`](../apps/backend/src/config.ts#L375) | string, minimum 1 | `unset` |
| [`PII_LLM_MODEL`](../apps/backend/src/config.ts#L381) | string, minimum 1 | `"google/gemini-2.5-flash"` |
| [`PII_LLM_WIRE_FORMAT`](../apps/backend/src/config.ts#L389) | one of ["openai", "ollama"] | `"openai"` |
| [`PII_LLM_DISABLE_THINKING`](../apps/backend/src/config.ts#L394) | boolean | `false` |
| [`PII_PROVIDER_TIMEOUT_MS`](../apps/backend/src/config.ts#L395) | number, integer, > 0 | `5000` |
| [`PII_ARTIFACT_MAX_BYTES`](../apps/backend/src/config.ts#L399) | number, integer, > 0 | `5242880` |
| [`PII_CSV_PREVIEW_ROWS`](../apps/backend/src/config.ts#L404) | number, integer, > 0 | `10` |
| [`PII_CSV_PREVIEW_MAX_BYTES`](../apps/backend/src/config.ts#L405) | number, integer, > 0 | `4096` |
| [`PII_BREAKER_ENABLED`](../apps/backend/src/config.ts#L411) | boolean | `true` |
| [`PII_BREAKER_FAILURE_THRESHOLD`](../apps/backend/src/config.ts#L412) | number, integer, > 0 | `5` |
| [`PII_BREAKER_WINDOW_MS`](../apps/backend/src/config.ts#L413) | number, integer, > 0 | `60000` |
| [`PII_BREAKER_COOLDOWN_MS`](../apps/backend/src/config.ts#L414) | number, integer, > 0 | `30000` |
| [`PII_RETENTION_KEK`](../apps/backend/src/config.ts#L421) | string, matches /^[0-9a-fA-F]{64}$/ | `unset` |
