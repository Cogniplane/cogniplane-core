# Security model

Scope: invariants that every change must keep, and cross-cutting controls
(secrets, HTTP headers, CORS, frontend). Reviewers: [threat
index](threat-index.md). Each subsystem document owns the details of its
controls. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Invariants

Each invariant has its own heading; link to it by name, not by number.

### Tenant data

Use `withTenantScope` and `app_user` for every tenant query. Use `privilegedDb`
only with a reason in a comment at the call site, and keep tenant predicates in
the query. Validate session access before any checkpoint access.
[data](architecture/data.md#tenant-isolation)

### Credentials

Never give user tokens, provider keys or upstream secrets to the model, the
sandbox, logs or tool events. The agent gets only a `toolContextId`; the gateway
injects credentials. [tools](architecture/tools.md#mcp-gateway)

### Identity

Take tenant and user only from authentication, the runtime token or the trusted
`_meta` entry, never from tool arguments or request bodies. A session or other
resource id from a request is a selection: load it with the authenticated tenant
and user and return 404 when they cannot read it (example: `POST /messages`,
`getReadable` in `services/session-store.ts`; the SQL access rules are in
`services/session-access.ts`).

### Approvals

Key resume values by interrupt id. Keep the Policy Center proof bound to
session, user, tool, server, tool context and argument hash, and single use.
[approvals](architecture/approvals.md)

### Sensitive changes

Data routes, weaker controls and skill releases need step-up (`requireStepUp`,
`DataRouteControl.writeWithStepUpIfWeaker`, or `requireStepUpForOverlay` in an
overlay) and queue an owner notice. [sensitive
changes](architecture/sensitive-changes.md)

### Revocation

A security change of a local account must stop its tokens, running turns, tool
contexts, scheduled jobs and personal connections. [local
accounts](architecture/local-accounts.md#security-version-and-revocation)

### Sandbox

No command runs in a sandbox whose network the current turn did not confirm.
File tools check paths against the session workspace (lexically); shell commands
can read the whole sandbox, so the E2B VM is the boundary.
[sandbox](architecture/sandbox.md#e2b-sandbox)

### Public errors

Send the client only an error you classified as public, with an error code and
fixed text (`apiError`, `lib/http-errors.ts`). Neither `apiError` nor
`getErrorMessage` cleans text; never pass them the message of an unexpected SDK
or database error. Turn errors:
[runtime](architecture/runtime.md#sessions-and-turns)
(`clientSafeTurnFailureMessage`).

### Persistence

Pass tool events, audit payloads, saved widget data and Redis turn-replay events
through `redactSecrets()` (replay: `services/turn-event-log.ts`).

### Frontend boundary

The frontend is not a security boundary. `middleware.ts` and `AuthGuard` only
redirect and hide. Every rule is enforced in the backend.

## Secrets and encryption

- `lib/crypto-utils.ts`: AES-256-GCM with a scrypt-derived key; format
  base64(iv, ciphertext, tag).
- `DATA_ENCRYPTION_SECRET`:
  - Encrypts: tenant provider keys, connection tokens, MCP and member
    credentials, integration secret fields, TOTP secrets, the email outbox.
  - Derives: the runtime token, recovery-code, login-throttle and default
    proxy-signing keys.
  - The full list is the users of the variable (`git grep DATA_ENCRYPTION_SECRET
    apps private`). Changing it makes all of them unreadable; there is no
    rotation tool.
- `PII_RETENTION_KEK`, not `DATA_ENCRYPTION_SECRET`, encrypts kept PII findings
  (reversible retention).
- `JWT_SECRET` signs tokens: [tokens](architecture/auth.md#tokens-and-cookies),
  [rotation](operations.md#rotate-secrets).
- Startup rules for secrets: [configuration](configuration.md#startup-rules).
- `redactSecrets()` (`services/redact-secrets.ts`) removes bearer headers, known
  token formats (the patterns in that file, for example `sk-ant-` keys and JWTs)
  and credential query parameters in any string. It blanks string and array
  values of fields whose name matches its `SECRET_KEY_PATTERN`. Exceptions:
  numbers and booleans under those names stay; a nested object is walked, not
  blanked; paging fields (`pageToken`, `nextPageToken`, ...) stay.
  `lib/sanitize-url.ts` uses the same parameter list for logged URLs.

## HTTP controls

- Every response, SSE included, gets `STATIC_SECURITY_HEADERS` (the list is in
  `lib/security-headers.ts`) and `X-Request-Id`.
- CORS (`lib/cors.ts`, `app.ts`): one exact origin, `API_ORIGIN` (the frontend
  origin), with credentials. Methods are the `CORS_ALLOWED_METHODS` constant in
  `lib/cors.ts`.
- CSRF: see [auth](architecture/auth.md#request-authentication).
- Input: route bodies are parsed with Zod (`lib/route-validation.ts`,
  `parseRequestInput`); invalid input returns a structured 400. Non-multipart
  bodies are capped at `MAX_REQUEST_BODY_BYTES`; uploads at
  `ARTIFACT_MAX_UPLOAD_BYTES`.

## Outbound requests

- URLs that must reach only public hosts (GitHub skill imports, marketplace
  manifests) use `lib/url-validation.ts`. Use the same for any new server-side
  fetch of a user-supplied URL:
  - At input: `httpsUrlSchema` and `isPrivateOrReservedHost`.
  - At fetch: `fetch` from `undici` with `dispatcher: ssrfSafeAgent`. The agent
    refuses a DNS answer with a private or reserved address and pins the
    connection.
  - `ssrfSafeAgent` is an `Agent` of the `undici` package. Node's global `fetch`
    bundles another undici version and may reject the agent or not apply it.
    Call `assertDispatcherAwareFetch` on an injected fetch, so the global one
    throws.
- Proxy MCP upstreams are the exception: `mcpUpstreamUrlSchema` allows local and
  private addresses, because admins connect servers on their own network.

## Frontend

- Token storage: [auth](architecture/auth.md#tokens-and-cookies).
- Markdown from the model renders through a sanitizing renderer. Do not add
  `dangerouslySetInnerHTML`; `components/ui/chart.tsx` uses it to write a
  `<style>` element from chart configuration.
- `app/auth/callback/page.tsx` is `force-dynamic`, so no host serves a static
  render that skips the token exchange.
- Generated UI and MCP App widgets are isolated: see [chat
  UI](architecture/chat-ui.md) and [MCP
  Apps](architecture/mcp-apps.md#isolation).

## Supply chain

- `pnpm-lock.yaml` locks all dependencies; `deepagents` has an exact version.
- License gate: [contributing](../CONTRIBUTING.md#dependency-licenses).
  Dependency audit and secret scan: the `dependency-audit` and `gitleaks` CI
  jobs ([development](development.md#ci-gates)).
- Sandbox template packages: [sandbox](architecture/sandbox.md#e2b-sandbox).

## Known limits

- WorkOS sessions get no step-up and no security version: [sensitive
  changes](architecture/sensitive-changes.md#step-up),
  [revocation](architecture/local-accounts.md#security-version-and-revocation).
- Sandbox network limits are listed in
  [sandbox](architecture/sandbox.md#sandbox-network).
- A manager who holds a reset link can set a member's password without the
  member's second factor. Send links only to the person they are for
  ([email](architecture/email.md)).
- Mail already handed to the SMTP server cannot be recalled.
- A turn error with a 4xx status passes its message to the client, also from a
  provider SDK; see `clientSafeTurnFailureMessage` in
  [runtime](architecture/runtime.md#sessions-and-turns). It is an exception to
  [public errors invariant](#public-errors).
