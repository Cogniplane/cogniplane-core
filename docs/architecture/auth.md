# Authentication and authorization

Scope: auth modes, tokens and cookies, request authentication, roles and WorkOS
sign-in. Local accounts, second factors, passkeys and operator commands are in
[local accounts](local-accounts.md). Email is in [email](email.md). Operator
setup is in [self-hosting](../self-hosting.md#authentication).

## Modes and sign-in types

| `AUTH_MODE` | Behavior |
|---|---|
| `dev-headers` | Development only; see the notes below. |
| `jwt` | Verifies backend-issued JWTs. On every request, reads role, tenant login type and the user's login path from `tenant_memberships`, `tenants`, `users`. Needs Redis ([startup rules](../configuration.md#startup-rules)). |
| `workos` | Earlier name for `jwt` with `AUTH_LOGIN_TYPES=workos`. |

`dev-headers`:

- It trusts `X-User-Id` and `X-Tenant-Id`. It has no sign-in sessions and no
  step-up.
- `X-Dev-Auth-Key` is checked only with
  `COGNIPLANE_ALLOW_DEV_HEADERS_ON_NON_LOOPBACK=1`.
- Startup rules: [configuration](../configuration.md#startup-rules).

Sign-in types:

- `AUTH_LOGIN_TYPES` enables `workos`, `local`, or both.
- Each tenant has one login type, `tenants.login_type`, set at creation and
  fixed by a trigger. A sign-in session's login path always equals its tenant's
  login type.
- `routes/auth-session.ts` is the shared session layer; WorkOS sign-in is in
  `routes/auth.ts`; local sign-in is in `routes/auth-local.ts`.

## Tokens and cookies

- Access token: HS256 JWT (`ACCESS_TOKEN_TTL` in `lib/jwt.ts`), `Authorization:
  Bearer`. Claims include `sub`, `tid`, `role`, `amr` (sign-in methods),
  `auth_time`, and for local accounts `sv` (security version); the header
  carries `kid`. Refresh copies `amr` and `auth_time`. `lib/jwt.ts`.
- Signing: `JWT_SECRET` under `JWT_KEY_ID`. Verification also accepts the
  secrets in `JWT_VERIFICATION_KEYS` (JSON of key id to secret), which allows
  rotation. See [operations](../operations.md#rotate-secrets).
- Refresh token: HS256 JWT (`REFRESH_TOKEN_TTL`), with `jti` and family id
  `fid`, in the httpOnly cookie `cogniplane_refresh` (`Secure`, `SameSite=None`,
  backend domain). Redis stores `jti` and family state; a Lua script consumes
  `jti` atomically. Reuse of a consumed `jti` after
  `REFRESH_ROTATION_GRACE_SECONDS` (code constant) revokes the family. A family
  also ends after `REFRESH_FAMILY_ABSOLUTE_LIFETIME_SECONDS`, however often it
  rotates. `lib/refresh-token-store.ts`.
- Only explicit sign-out deletes the refresh cookie. If `/auth/logout` cannot
  revoke the family, it returns 503 `logout_unavailable` and keeps the cookie.
- The frontend keeps the access token in memory only (`lib/api-client.ts`),
  never in `localStorage` or `sessionStorage`. A reload uses the refresh cookie.
  A session-change gate keeps a refresh from sending a cookie that a sign-in or
  sign-out replaces.
- `cogniplane_session_hint` (`SameSite=Lax`) is a UI hint for redirects, not a
  credential.

## Request authentication

- `lib/auth-jwt.ts` checks every request except the exact public paths that it
  lists (query string removed before the match; helpers in
  `lib/auth-public-paths.ts`). Public paths depend on the enabled login types,
  passkeys and email. Integration OAuth callbacks come from the integration
  registry. `/auth/me` is not public.
- `GET /downloads/:token` is public: the single-use token is the credential.
- A valid JWT is not enough: the user must be a member of the tenant (403
  `not_a_member`).
- Request admission and `/auth/refresh` use `PrivilegedAuthStateLookup`
  (`services/tenant-member-store.ts`). Each membership read sends one SELECT
  on the maintenance pool, with tenant and user predicates and no cache. The
  normal app-pool store keeps its `withTenantScope` transaction and RLS scope.
- A database or pool error in the membership lookup gets 503
  `auth_unavailable` with `Retry-After`. It is not a 401, so the client keeps
  the session. `/auth/refresh` answers 503 `refresh_unavailable` in the same
  case.
- CSRF: state-changing routes take JSON (artifact upload takes multipart); none
  accepts a form body from another site. Auth mutations (`/auth/callback`,
  `/auth/refresh`, `/auth/logout`, local sign-in, link, step-up and password
  routes) require `Origin` equal to `API_ORIGIN` (403 `csrf_origin_mismatch`)
  and refuse form bodies (415). `lib/browser-auth-origin.ts`.

## Roles

| Role | Rights |
|---|---|
| `owner` | All admin rights; owner-only settings ([tenant settings](data.md#tenant-settings)); member management |
| `admin` | Admin configuration, audit log, member management (not of owners) |
| `member` | Use sessions, projects, personal settings |

- Route guards: [development](../development.md#conventions) (`withAdmin` for
  `/admin/*`, `requireRole` elsewhere).
- Role change and removal, for local and WorkOS members (`PUT
  /tenant/members/:userId/role`, `DELETE /tenant/members/:userId`,
  `routes/tenant.ts`):
  - Only an owner assigns `owner` or `admin` or removes an admin. Nobody changes
    or removes their own membership, and an owner cannot be demoted or removed
    here.
  - A local target needs the manager's step-up.
  - Both run in `withSecurityChange`. After the commit, the member's interactive
    and scheduled turns stop, for local and WorkOS members.
  - Removal pauses the member's scheduled jobs; an owner reviews them before
    they run again. Then it deletes the membership.
  - A removed local account ends for good; its identity row stays for audit.
- Owners and admins can read the sessions of every member of the tenant: `GET
  /admin/sessions` and `GET /admin/sessions/:sessionId` return message text,
  reasoning and plan (`routes/admin/admin-session-detail.ts`), and `POST
  /admin/artifacts/:artifactId/download-token` downloads a member's file (with
  an audit event). The session list shows alert badges
  (`services/admin-session-alerts.ts`: PII blocks and findings, rejected or
  pending approvals, errors). `GET /admin/users/:userId/skills-connections`
  shows a member's skills and connections.
- WorkOS role at first sign-in: [WorkOS sign-in](#workos-sign-in).

## WorkOS sign-in

`POST /auth/callback` (`routes/auth.ts`) with provisioning in
`services/auth/workos-tenant-provisioning.ts`. Setup:
[self-hosting](../self-hosting.md#authentication).

- Input: `code` and `state` must be strings, and `code` can have at most
  `OAUTH_CODE_MAX_LENGTH` characters. Other bodies return 400
  `invalid_request`. A missing code returns 400 `missing_code`. A state that
  does not match the state cookie returns 400 `invalid_state`. A missing PKCE
  verifier cookie returns 400 `invalid_pkce_verifier`. The route sends the
  code to WorkOS only after these checks.
- The state and PKCE cookies are single use. Every answer after the rate limit
  deletes them.
- Refused code: if the WorkOS code exchange answers 400 with the OAuth error
  `invalid_grant`, the route returns 401 `invalid_code`. The user must start
  a new sign-in. The log line names no code, state, verifier or WorkOS answer.
- Other WorkOS failures of the code exchange return 500: network errors,
  WorkOS 5xx and 429 answers, and a refused client or API key.
- Organization: a hint counts only when it matches a membership. One membership
  selects that organization. Several return 409
  `organization_selection_required`, and the user signs in again with one. None
  returns 403 `no_organization`.
- One transaction writes the tenant, the user and the membership. The tenant
  name is set once; a rename in WorkOS does not sync.
- A tenant whose login type is not `workos` returns 403 `wrong_login_type`, and
  nothing is written.
- An email that belongs to another identity (another WorkOS user, or a local
  account) returns 409 `email_in_use`. Sign-in never binds an existing user row
  by email alone.
- Role at first membership: `owner` for the first member of a new tenant;
  otherwise `admin` when the WorkOS role slug is `admin`, else `member`. After
  that the stored role is authoritative ([roles](#roles)).
