# Backend configuration

Scope: every backend environment variable in the `apps/backend/src/config.ts`
schema, its accepted values and default, and the startup rules between
variables. [config.ts](../apps/backend/src/config.ts) is the source.
`scripts/generate-config-reference.ts` generates the table from it; edit only
the prose above the table. After a schema change, run `pnpm exec tsx
scripts/generate-config-reference.ts`; a test fails when the table is stale.
"Mentioned in" links up to two documents that name a variable. Read one row with
``grep '^| `NAME`' docs/configuration.md``. Some declarations in
`apps/backend/src/config.ts` have a comment above them (or above their group)
that gives the purpose. Local values start from [the backend
example](../apps/backend/.env.example). Overlay variables
(`MICROSOFT_OAUTH_REDIRECT_URI`) are in
[connectors](connectors.md#microsoft-365-sharepoint-overlay).

Values are environment strings. Boolean values `1`, `true`, `yes` and `on` are
true, ignoring case and surrounding whitespace. Other strings are false. Numeric
bounds apply to values; string bounds apply to character counts. `_MS` values
are milliseconds, `_BYTES` values are bytes, and `_DAYS` values are days.
`unset` means the schema has no default, though startup or a consumer may derive
a value as described below. `<system-temp>` is Node's operating-system temporary
directory.

## Startup rules

Startup refuses to continue when a rule below fails: `loadConfig` in
`apps/backend/src/config.ts` checks them, except `TRUST_PROXY`
(`parseTrustProxy` in `app.ts`) and the database roles (`assertApplicationRole`
and `assertMaintenanceRole`, called by `buildApp` in `app.ts`). Other documents
link here instead of repeating these rules.

- Auth: `AUTH_MODE=jwt` requires `REDIS_URL`, distinct application and
  maintenance database URLs, an application role under RLS, and non-default
  `JWT_SECRET` and `DATA_ENCRYPTION_SECRET`. `AUTH_LOGIN_TYPES` defaults to
  `workos`; WorkOS login requires `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` and
  `WORKOS_REDIRECT_URI`. `AUTH_MODE=workos` means `jwt` with WorkOS login.
  `JWT_VERIFICATION_KEYS` must not redefine `JWT_KEY_ID` with another secret.
- `local` login requires Node 24.7 or later (`crypto.argon2`).
- `WEBAUTHN_RP_ID` requires `local` login and must be the host name of
  `API_ORIGIN` or a parent domain of it.
- `SMTP_URL` and `MAIL_FROM` are set together, only with `AUTH_MODE=jwt`.
  `SMTP_ALLOW_PLAINTEXT` is refused unless `NODE_ENV` is unset, `development`,
  `dev` or `test`.
- Any other `NODE_ENV` value counts as production and requires `AUTH_MODE=jwt`.
- `dev-headers` requires a loopback `API_HOST` (`127.0.0.1`, `::1`,
  `localhost`), unless `COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK=1`, which
  then requires `DEV_HEADERS_AUTH_KEY` (16 characters or more). `API_HOST`
  defaults to `127.0.0.1` for `dev-headers` and `::` for `jwt`. `ADMIN_USER_IDS`
  (dev-headers only) defaults to `LOCAL_DEV_USER_ID`.
- `MAINTENANCE_DATABASE_URL` is required in every mode: `loadConfig` checks it
  for `jwt`, and `buildApp` (`app.ts`) for every mode. Startup refuses a runtime
  role with administrative rights ([database roles](database-roles.md)).
- `E2B_API_KEY` and a real `E2B_TEMPLATE_ID` are required, except for migration
  commands. `RUNTIME_GATEWAY_BASE_URL` must name a loopback host.
- GitHub and Notion OAuth each need all three of their variables;
  `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET` and `PIPEDREAM_PROJECT_ID` go
  together.
- `MCP_UPSTREAM_SIGNING_SECRET` is refused (removed v1 key);
  `MCP_UPSTREAM_SIGNING_ROOT_SECRET` is optional.
- Bucket storage requires the matching bucket name; explicit access and secret
  keys go together. Unless `NODE_ENV` is exactly `production`,
  `ARTIFACT_STORAGE_ROOT` and `SKILL_BUNDLE_STORAGE_ROOT` inside the repository
  are replaced with the system-temp defaults (this check differs from the auth
  rule above: `staging` counts as production for auth but not here); relative
  paths resolve against the repository root.
- With a positive `RUNTIME_TURN_TIMEOUT_MS`: it must exceed
  `APPROVAL_REQUEST_TTL_MS` and stay below `E2B_SANDBOX_TIMEOUT_MS`, and
  `TOOL_CONTEXT_TTL_MS` must exceed it plus `APPROVAL_REQUEST_TTL_MS`. `0` turns
  the watchdog off.
- `SESSION_EXECUTION_LEASE_MS` must exceed twice
  `SESSION_EXECUTION_HEARTBEAT_MS`.
- `UTILITY_LLM_ENABLED` requires its base URL and model. `PII_PROVIDER_ENABLED`
  requires `PII_LLM_API_KEY`. `PII_RETENTION_KEK` is 64 hex characters.
- `PDFTOTEXT_BINARY_PATH` must name `pdftotext`, `pdftotext.*` or `pdftotext-*`.
  `PDFINFO_BINARY_PATH`, `PDFTOPPM_BINARY_PATH` and `TESSERACT_BINARY_PATH`
  follow the same rule with their own tool names.
- With `PII_PDF_OCR_ENABLED`, `PII_PROVIDER_TIMEOUT_MS + PII_PDF_OCR_TIMEOUT_MS`
  must be less than `SCHEDULER_JOB_TIMEOUT_MS`, and the boot stops when the OCR
  tools do not run or tesseract does not have each language in
  `PII_PDF_OCR_LANGUAGES` ([PDF OCR](architecture/pii.md#pdf-ocr)).
- `TRUST_PROXY` is `false`, `true`, or a list of IPs and CIDRs; hop counts are
  refused.

Meaning of zero: a rate limit, daily quota or
`SCHEDULED_JOB_MAX_ACTIVE_PER_USER` of `0` is off;
`SESSION_TRASH_RETENTION_DAYS=0` purges deleted sessions at the next cleanup.
Read outside the schema: `NODE_ENV`, and `BUILD_SHA` and `BUILD_DATE` (build
metadata for Admin > Runtime diagnostics; `docker/backend.Dockerfile` sets them
from build arguments). Frontend variables are in `apps/frontend/.env.example`
([frontend](architecture/frontend.md#builds-and-variables)).

## Environment reference

<!-- generated configuration table -->

| Variable | Accepted value | Default when unset | Mentioned in |
| --- | --- | --- | --- |
| `API_HOST` | string | `unset` | [startup rules](#startup-rules), [operations](operations.md) |
| `API_PORT` | number, integer, > 0 | `3001` | [operations](operations.md) |
| `API_ORIGIN` | string, URL | `"http://localhost:3000"` | [startup rules](#startup-rules), [auth](architecture/auth.md) |
| `DATABASE_URL` | string, minimum 1 | `"postgres://app_user:app_user_password@localhost:5432/cogniplane"` | [database-roles](database-roles.md), [self-hosting](self-hosting.md) |
| `MODEL_SPENDING_MONTHLY_LIMIT_USD` | number, minimum 0, maximum 1_000_000 | `unset` | [model-spending](architecture/model-spending.md), [self-hosting](self-hosting.md) |
| `MODEL_SPENDING_TURN_RESERVATION_USD` | number, minimum 0.000001, maximum 1_000_000 | `1` | [model-spending](architecture/model-spending.md), [self-hosting](self-hosting.md) |
| `LOCAL_DEV_USER_ID` | string, minimum 1 | `"local-dev-user"` | [startup rules](#startup-rules) |
| `ADMIN_USER_IDS` | string | `unset` | [startup rules](#startup-rules), [getting-started](getting-started.md) |
| `ANTHROPIC_API_KEY` | string, minimum 1 | `unset` | [models](architecture/models.md), [docker-deploy](docker-deploy.md) |
| `OPENAI_API_KEY` | string, minimum 1 | `unset` | [models](architecture/models.md), [getting-started](getting-started.md) |
| `GOOGLE_API_KEY` | string, minimum 1 | `unset` | [models](architecture/models.md) |
| `OPENROUTER_API_KEY` | string, minimum 1 | `unset` | [models](architecture/models.md) |
| `ZAI_API_KEY` | string, minimum 1 | `unset` | [models](architecture/models.md) |
| `TRUST_PROXY` | string | `"false"` | [startup rules](#startup-rules), [self-hosting](self-hosting.md) |
| `SESSION_TITLER_CLAUDE_MODEL` | string, minimum 1 | `"claude-haiku-5-5"` | [models](architecture/models.md) |
| `SESSION_TITLER_TIMEOUT_MS` | number, integer, > 0 | `5000` | [models](architecture/models.md) |
| `UTILITY_LLM_ENABLED` | boolean | `false` | [startup rules](#startup-rules), [models](architecture/models.md) |
| `UTILITY_LLM_BASE_URL` | string, URL | `unset` | [models](architecture/models.md) |
| `UTILITY_LLM_API_KEY` | string, minimum 1 | `unset` | [models](architecture/models.md) |
| `UTILITY_LLM_MODEL` | string, minimum 1 | `unset` | [models](architecture/models.md) |
| `UTILITY_LLM_WIRE_FORMAT` | one of ["openai", "ollama"] | `"ollama"` | [models](architecture/models.md) |
| `UTILITY_LLM_DISABLE_THINKING` | boolean | `false` | [models](architecture/models.md) |
| `UTILITY_LLM_TIMEOUT_MS` | number, integer, > 0 | `10000` | [models](architecture/models.md) |
| `RUNTIME_GATEWAY_BASE_URL` | string, URL | `"http://localhost:3001"` | [startup rules](#startup-rules), [tools](architecture/tools.md) |
| `RUNTIME_IDLE_TIMEOUT_MS` | number, integer, > 0 | `300000` | [runtime](architecture/runtime.md) |
| `RUNTIME_TURN_TIMEOUT_MS` | number, integer, >= 0 | `1200000` | [startup rules](#startup-rules), [runtime](architecture/runtime.md) |
| `RUNTIME_TOKEN_TTL_MS` | number, integer, > 0 | `86400000` | [tools](architecture/tools.md) |
| `TOOL_CONTEXT_TTL_MS` | number, integer, > 0 | `2100000` | [startup rules](#startup-rules), [tools](architecture/tools.md) |
| `SESSION_EXECUTION_LEASE_MS` | number, integer, minimum 10_000 | `30000` | [startup rules](#startup-rules), [runtime](architecture/runtime.md) |
| `SESSION_EXECUTION_HEARTBEAT_MS` | number, integer, > 0 | `5000` | [startup rules](#startup-rules), [runtime](architecture/runtime.md) |
| `APPROVAL_REQUEST_TTL_MS` | number, integer, > 0 | `600000` | [startup rules](#startup-rules), [approvals](architecture/approvals.md) |
| `ARTIFACT_STORAGE_BACKEND` | one of ["local", "bucket"] | `"local"` | [projects-and-files](architecture/projects-and-files.md), [self-hosting](self-hosting.md) |
| `ARTIFACT_STORAGE_ROOT` | string, minimum 1 | `"<system-temp>/cogniplane-core-artifacts"` | [startup rules](#startup-rules), [operations](operations.md) |
| `SKILL_BUNDLE_STORAGE_ROOT` | string, minimum 1 | `"<system-temp>/cogniplane-core-skills"` | [startup rules](#startup-rules), [operations](operations.md) |
| `SKILL_BUNDLE_STORAGE_BACKEND` | one of ["local", "bucket"] | `"local"` | [skills](architecture/skills.md), [self-hosting](self-hosting.md) |
| `SKILL_BUNDLE_BUCKET_NAME` | string, minimum 1 | `unset` | [skills](architecture/skills.md), [self-hosting](self-hosting.md) |
| `SKILL_BUNDLE_BUCKET_PREFIX` | string | `""` | [skills](architecture/skills.md) |
| `SKILL_BUNDLE_CACHE_ROOT` | string, minimum 1 | `"<system-temp>/cogniplane-skill-cache"` | [skills](architecture/skills.md) |
| `ARTIFACT_BUCKET_NAME` | string, minimum 1 | `unset` | [self-hosting](self-hosting.md) |
| `ARTIFACT_BUCKET_REGION` | string, minimum 1 | `"us-east-1"` | [self-hosting](self-hosting.md) |
| `ARTIFACT_BUCKET_ENDPOINT` | string, URL | `unset` | [self-hosting](self-hosting.md) |
| `ARTIFACT_BUCKET_PREFIX` | string | `""` | [self-hosting](self-hosting.md) |
| `ARTIFACT_BUCKET_FORCE_PATH_STYLE` | boolean | `false` | [self-hosting](self-hosting.md) |
| `ARTIFACT_BUCKET_ACCESS_KEY_ID` | string, minimum 1 | `unset` | [self-hosting](self-hosting.md) |
| `ARTIFACT_BUCKET_SECRET_ACCESS_KEY` | string, minimum 1 | `unset` | [self-hosting](self-hosting.md) |
| `ARTIFACT_BUCKET_SESSION_TOKEN` | string, minimum 1 | `unset` | [self-hosting](self-hosting.md) |
| `ARTIFACT_MAX_UPLOAD_BYTES` | number, integer, > 0 | `26214400` | [projects-and-files](architecture/projects-and-files.md), [sandbox](architecture/sandbox.md) |
| `MAX_REQUEST_BODY_BYTES` | number, integer, > 0 | `2097152` | [security](security.md) |
| `LOG_LEVEL` | one of ["fatal", "error", "warn", "info", "debug", "trace", "silent"] | `"info"` | [operations](operations.md) |
| `ARTIFACT_DOWNLOAD_TTL_MS` | number, integer, > 0 | `900000` | [projects-and-files](architecture/projects-and-files.md) |
| `SKILL_BUNDLE_RETENTION_DAYS` | number, integer, minimum 0 | `30` | [skills](architecture/skills.md) |
| `SESSION_TRASH_RETENTION_ENABLED` | boolean | `true` | [data](architecture/data.md) |
| `SESSION_TRASH_RETENTION_DAYS` | number, integer, minimum 0 | `30` | [startup rules](#startup-rules), [data](architecture/data.md) |
| `SKILL_MARKETPLACE_MANIFEST_URL` | string, URL | `unset` | [skills](architecture/skills.md) |
| `SKILL_MARKETPLACE_CACHE_TTL_MS` | number, integer, > 0 | `300000` | [skills](architecture/skills.md) |
| `PDFTOTEXT_BINARY_PATH` | string, minimum 1, additional validation in source | `"pdftotext"` | [startup rules](#startup-rules), [getting-started](getting-started.md) |
| `PDFINFO_BINARY_PATH` | string, minimum 1, additional validation in source | `"pdfinfo"` | [startup rules](#startup-rules) |
| `PDFTOPPM_BINARY_PATH` | string, minimum 1, additional validation in source | `"pdftoppm"` | [startup rules](#startup-rules) |
| `TESSERACT_BINARY_PATH` | string, minimum 1, additional validation in source | `"tesseract"` | [startup rules](#startup-rules) |
| `RATE_LIMIT_WINDOW_MS` | number, integer, > 0 | `60000` | [data](architecture/data.md) |
| `SESSION_CREATE_LIMIT_PER_USER_PER_WINDOW` | number, integer, minimum 0 | `10` | [data](architecture/data.md) |
| `SESSION_CREATE_LIMIT_PER_TENANT_PER_WINDOW` | number, integer, minimum 0 | `50` | [data](architecture/data.md) |
| `MESSAGE_LIMIT_PER_USER_PER_WINDOW` | number, integer, minimum 0 | `20` | [data](architecture/data.md) |
| `MESSAGE_LIMIT_PER_TENANT_PER_WINDOW` | number, integer, minimum 0 | `100` | [data](architecture/data.md) |
| `MAX_RUNNING_TURNS_PER_USER` | number, integer, > 0 | `5` | [runtime](architecture/runtime.md) |
| `MAX_RUNNING_TURNS_PER_TENANT` | number, integer, > 0 | `50` | [runtime](architecture/runtime.md) |
| `ARTIFACT_UPLOAD_LIMIT_PER_USER_PER_WINDOW` | number, integer, minimum 0 | `20` | [data](architecture/data.md) |
| `ARTIFACT_UPLOAD_LIMIT_PER_TENANT_PER_WINDOW` | number, integer, minimum 0 | `100` | [data](architecture/data.md) |
| `PROJECT_FILE_WRITE_LIMIT_PER_USER_PER_WINDOW` | number, integer, minimum 0 | `20` | [data](architecture/data.md) |
| `PROJECT_FILE_WRITE_LIMIT_PER_TENANT_PER_WINDOW` | number, integer, minimum 0 | `100` | [data](architecture/data.md) |
| `SCHEDULED_JOB_CREATE_LIMIT_PER_USER_PER_WINDOW` | number, integer, minimum 0 | `10` | [data](architecture/data.md), [runtime](architecture/runtime.md) |
| `SCHEDULED_JOB_CREATE_LIMIT_PER_TENANT_PER_WINDOW` | number, integer, minimum 0 | `50` | [data](architecture/data.md), [runtime](architecture/runtime.md) |
| `SCHEDULED_JOB_MAX_ACTIVE_PER_USER` | number, integer, minimum 0 | `50` | [startup rules](#startup-rules), [runtime](architecture/runtime.md) |
| `OAUTH_CALLBACK_LIMIT_PER_USER_PER_WINDOW` | number, integer, minimum 0 | `20` | [data](architecture/data.md) |
| `OAUTH_CALLBACK_LIMIT_PER_TENANT_PER_WINDOW` | number, integer, minimum 0 | `100` | [data](architecture/data.md) |
| `ADMIN_QUERY_LIMIT_PER_USER_PER_WINDOW` | number, integer, minimum 0 | `300` | [data](architecture/data.md) |
| `ADMIN_QUERY_LIMIT_PER_TENANT_PER_WINDOW` | number, integer, minimum 0 | `1000` | [data](architecture/data.md) |
| `AUTH_ORGANIZATIONS_LIMIT_PER_USER_PER_WINDOW` | number, integer, minimum 0 | `20` | [data](architecture/data.md) |
| `AUTH_ORGANIZATIONS_LIMIT_PER_TENANT_PER_WINDOW` | number, integer, minimum 0 | `100` | [data](architecture/data.md) |
| `TURN_QUOTA_PER_USER_PER_DAY` | number, integer, minimum 0 | `200` | [data](architecture/data.md) |
| `TURN_QUOTA_PER_TENANT_PER_DAY` | number, integer, minimum 0 | `1000` | [data](architecture/data.md) |
| `PROJECT_FILE_RETENTION_ENABLED` | boolean | `true` | [data](architecture/data.md) |
| `SCHEDULER_ENABLED` | boolean | `true` | [runtime](architecture/runtime.md), [self-hosting](self-hosting.md) |
| `SCHEDULER_POLL_INTERVAL_MS` | number, integer, > 0 | `30000` | [runtime](architecture/runtime.md), [self-hosting](self-hosting.md) |
| `SCHEDULER_MAX_CONCURRENT_JOBS` | number, integer, > 0 | `2` | [runtime](architecture/runtime.md), [self-hosting](self-hosting.md) |
| `SCHEDULER_JOB_TIMEOUT_MS` | number, integer, > 0 | `300000` | [startup rules](#startup-rules), [pii](architecture/pii.md) |
| `SCHEDULER_MAX_CONSECUTIVE_FAILURES` | number, integer, > 0 | `5` | [runtime](architecture/runtime.md), [self-hosting](self-hosting.md) |
| `PII_SCAN_MAX_CONCURRENT_JOBS` | number, integer, > 0 | `2` | [pii](architecture/pii.md) |
| `AUTH_MODE` | one of ["jwt", "workos", "dev-headers"] | `"dev-headers"` | [startup rules](#startup-rules), [auth](architecture/auth.md) |
| `AUTH_LOGIN_TYPES` | string | `unset` | [startup rules](#startup-rules), [auth](architecture/auth.md) |
| `LOCAL_AUTH_HASH_CONCURRENCY` | number, integer, minimum 1, maximum 64 | `4` | [local-accounts](architecture/local-accounts.md) |
| `WEBAUTHN_RP_ID` | string, minimum 1 | `unset` | [startup rules](#startup-rules), [local-accounts](architecture/local-accounts.md) |
| `WEBAUTHN_RP_NAME` | string, minimum 1, maximum 64 | `"Cogniplane"` | [local-accounts](architecture/local-accounts.md) |
| `SMTP_URL` | string, minimum 1 | `unset` | [startup rules](#startup-rules), [self-hosting](self-hosting.md) |
| `MAIL_FROM` | string, minimum 1, maximum 320 | `unset` | [startup rules](#startup-rules), [self-hosting](self-hosting.md) |
| `SMTP_ALLOW_PLAINTEXT` | boolean | `false` | [startup rules](#startup-rules), [email](architecture/email.md) |
| `COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK` | boolean | `false` | [startup rules](#startup-rules), [auth](architecture/auth.md) |
| `DEV_HEADERS_AUTH_KEY` | string, minimum 16 | `unset` | [startup rules](#startup-rules), [docker-deploy](docker-deploy.md) |
| `DATA_ENCRYPTION_SECRET` | string, minimum 32 | `"local-dev-data-encryption-secret-change-in-production!!"` | [startup rules](#startup-rules), [email](architecture/email.md) |
| `MCP_UPSTREAM_SIGNING_ROOT_SECRET` | string, minimum 32 | `unset` | [startup rules](#startup-rules), [mcp-proxy-signature](mcp-proxy-signature.md) |
| `MCP_UPSTREAM_SIGNING_SECRET` | string | `unset` | [startup rules](#startup-rules), [mcp-proxy-signature](mcp-proxy-signature.md) |
| `MCP_UPSTREAM_TIMEOUT_MS` | number, integer, > 0 | `30000` | [tools](architecture/tools.md) |
| `MCP_UPSTREAM_MAX_RESPONSE_BYTES` | number, integer, > 0 | `4194304` | [tools](architecture/tools.md) |
| `MCP_CONNECTION_TEST_TIMEOUT_MS` | number, integer, > 0, maximum 30_000 | `8000` | [tools](architecture/tools.md) |
| `WORKOS_API_KEY` | string, minimum 1 | `unset` | [startup rules](#startup-rules), [operations](operations.md) |
| `WORKOS_CLIENT_ID` | string, minimum 1 | `unset` | [startup rules](#startup-rules), [self-hosting](self-hosting.md) |
| `WORKOS_REDIRECT_URI` | string, URL | `unset` | [startup rules](#startup-rules), [self-hosting](self-hosting.md) |
| `GITHUB_OAUTH_CLIENT_ID` | string, minimum 1 | `unset` | [connectors](connectors.md) |
| `GITHUB_OAUTH_CLIENT_SECRET` | string, minimum 1 | `unset` | [connectors](connectors.md) |
| `GITHUB_OAUTH_REDIRECT_URI` | string, URL | `unset` | [connectors](connectors.md) |
| `NOTION_OAUTH_CLIENT_ID` | string, minimum 1 | `unset` | [connectors](connectors.md) |
| `NOTION_OAUTH_CLIENT_SECRET` | string, minimum 1 | `unset` | [connectors](connectors.md) |
| `NOTION_OAUTH_REDIRECT_URI` | string, URL | `unset` | [connectors](connectors.md) |
| `PIPEDREAM_CLIENT_ID` | string, minimum 1 | `unset` | [startup rules](#startup-rules), [connectors](connectors.md) |
| `PIPEDREAM_CLIENT_SECRET` | string, minimum 1 | `unset` | [startup rules](#startup-rules), [connectors](connectors.md) |
| `PIPEDREAM_PROJECT_ID` | string, matches /^proj_[A-Za-z0-9]+$/ | `unset` | [startup rules](#startup-rules), [connectors](connectors.md) |
| `PIPEDREAM_PROJECT_ENVIRONMENT` | one of ["development", "production"] | `"development"` | [connectors](connectors.md) |
| `MIGRATION_DATABASE_URL` | string, URL | `unset` | [local-accounts](architecture/local-accounts.md), [database-roles](database-roles.md) |
| `MAINTENANCE_DATABASE_URL` | string, URL | `unset` | [startup rules](#startup-rules), [database-roles](database-roles.md) |
| `JWT_SECRET` | string, minimum 32 | `"local-dev-jwt-secret-change-in-production!!"` | [startup rules](#startup-rules), [auth](architecture/auth.md) |
| `JWT_KEY_ID` | string, minimum 1, maximum 128, matches /^[A-Za-z0-9._-]+$/ | `"default"` | [startup rules](#startup-rules), [auth](architecture/auth.md) |
| `JWT_VERIFICATION_KEYS` | JSON object of key IDs to secrets of at least 32 characters | `{}` | [startup rules](#startup-rules), [auth](architecture/auth.md) |
| `REDIS_URL` | string, URL | `unset` | [startup rules](#startup-rules), [data](architecture/data.md) |
| `E2B_API_KEY` | string, minimum 1 | `unset` | [startup rules](#startup-rules), [sandbox](architecture/sandbox.md) |
| `E2B_TEMPLATE_ID` | string, minimum 1 | `"replace-with-your-template-id"` | [startup rules](#startup-rules), [sandbox](architecture/sandbox.md) |
| `E2B_SANDBOX_TIMEOUT_MS` | number, integer, > 0 | `1800000` | [startup rules](#startup-rules), [sandbox](architecture/sandbox.md) |
| `DEEP_AGENTS_EXECUTE_TIMEOUT_MS` | number, integer, > 0 | `120000` | [sandbox](architecture/sandbox.md) |
| `E2B_NETWORK_CONFIRM_TIMEOUT_MS` | number, integer, > 0 | `20000` | [sandbox](architecture/sandbox.md) |
| `E2B_NETWORK_REQUEST_TIMEOUT_MS` | number, integer, > 0 | `5000` | [sandbox](architecture/sandbox.md) |
| `PII_PROVIDER_ENABLED` | boolean | `false` | [startup rules](#startup-rules), [pii](architecture/pii.md) |
| `PII_LLM_BASE_URL` | string, URL | `"https://openrouter.ai/api/v1"` | [pii](architecture/pii.md), [self-hosting](self-hosting.md) |
| `PII_LLM_API_KEY` | string, minimum 1 | `unset` | [startup rules](#startup-rules), [pii](architecture/pii.md) |
| `PII_LLM_MODEL` | string, minimum 1 | `"google/gemini-2.5-flash"` | [pii](architecture/pii.md), [self-hosting](self-hosting.md) |
| `PII_LLM_WIRE_FORMAT` | one of ["openai", "ollama"] | `"openai"` | [pii](architecture/pii.md), [self-hosting](self-hosting.md) |
| `PII_LLM_DISABLE_THINKING` | boolean | `false` | [pii](architecture/pii.md), [self-hosting](self-hosting.md) |
| `PII_PROVIDER_TIMEOUT_MS` | number, integer, > 0 | `5000` | [pii](architecture/pii.md) |
| `PII_PDF_OCR_ENABLED` | boolean | `false` | [startup rules](#startup-rules), [pii](architecture/pii.md) |
| `PII_PDF_OCR_MAX_PAGES` | number, integer, > 0, maximum 1000 | `20` | [pii](architecture/pii.md), [self-hosting](self-hosting.md) |
| `PII_PDF_OCR_TIMEOUT_MS` | number, integer, > 0 | `30000` | [pii](architecture/pii.md), [self-hosting](self-hosting.md) |
| `PII_PDF_OCR_MAX_CONCURRENT` | number, integer, > 0, maximum 64 | `2` | [pii](architecture/pii.md), [self-hosting](self-hosting.md) |
| `PII_PDF_OCR_LANGUAGES` | string, matches /^[a-z][a-z0-9_]*(\+[a-z][a-z0-9_]*)*$/ | `"eng"` | [startup rules](#startup-rules), [pii](architecture/pii.md) |
| `PII_ARTIFACT_MAX_BYTES` | number, integer, > 0 | `5242880` | [pii](architecture/pii.md) |
| `PII_CSV_PREVIEW_ROWS` | number, integer, > 0 | `10` | [pii](architecture/pii.md) |
| `PII_CSV_PREVIEW_MAX_BYTES` | number, integer, > 0 | `4096` | [pii](architecture/pii.md) |
| `PII_BREAKER_ENABLED` | boolean | `true` | [pii](architecture/pii.md) |
| `PII_BREAKER_FAILURE_THRESHOLD` | number, integer, > 0 | `5` | [pii](architecture/pii.md) |
| `PII_BREAKER_WINDOW_MS` | number, integer, > 0 | `60000` | [pii](architecture/pii.md) |
| `PII_BREAKER_COOLDOWN_MS` | number, integer, > 0 | `30000` | [pii](architecture/pii.md) |
| `PII_RETENTION_KEK` | string, matches /^[0-9a-fA-F]{64}$/ | `unset` | [startup rules](#startup-rules), [pii](architecture/pii.md) |
