# Local accounts

Scope: password accounts, revocation, serialization of account changes, second
factors, passkeys and operator commands. Modes, tokens and roles are in
[auth](auth.md).

`routes/auth-local.ts`, `services/auth/local-account-service.ts`, migration
`071`. `auth:bootstrap` creates a local tenant and its first owner; managers add
other people in Admin > People (`routes/tenant-local-members.ts`).

- Passwords: Argon2id with `crypto.argon2` (Node version: [startup
  rules](../configuration.md#startup-rules); parameters in
  `lib/password-hash.ts`). Rules in `lib/password-policy.ts`: length limits
  after NFKC, a block list, no email address, no composition rules. Unknown
  emails run the same hash work.
- Hash concurrency: `LOCAL_AUTH_HASH_CONCURRENCY` caps parallel hashes per
  process, default 2. A request past it gets a retryable `503 busy`; it does not
  wait in a queue. Each hash holds 19 MiB and one thread of the libuv thread
  pool. That pool also runs `fs`, `dns.lookup`, `zlib` and other asynchronous
  crypto, and it has 4 threads unless `UV_THREADPOOL_SIZE` sets another size
  ([Node.js CLI](https://nodejs.org/api/cli.html#uv_threadpool_sizesize)). With
  the default, a sign-in burst leaves 2 threads for that work. To allow more
  parallel hashes, set `UV_THREADPOOL_SIZE` in the environment that starts the
  backend, and keep the concurrency below it. Node creates the pool before
  application code runs, so the backend does not set the size itself. A lower
  value gives more `503 busy` answers in a burst. A value at or above the pool
  size makes file and DNS work of all tenants wait behind hashes.
- A wrong password and an unknown, disabled, removed or not-set-up account all
  return `401 invalid_credentials`. A throttled request returns `429
  too_many_attempts`; no hashing capacity or a throttle store failure returns
  `503 busy`.
- Throttle: per email (HMAC key in Redis; `services/auth/login-throttle.ts`) and
  per IP. Both fail closed.
- One home tenant: composite foreign keys tie a local user to one identity and
  one tenant.
- Links (setup, reset; TTLs in `local-account-service.ts`): 32 random bytes;
  only the SHA-256 and the security version are stored; single use. A reset link
  changes the password only and starts no sign-in session.
- Lookups before the tenant is known (account by email, link by hash, passkey by
  credential id) use `privilegedDb` with SELECT only. All other reads and writes
  run as `app_user` in the tenant scope.

## Security version and revocation

- `local_identities.security_version` increments on: password change or reset,
  manager reset, disable, enable, sign out everywhere, removal, the first second
  factor (or an enrolment after a recovery code), and a stricter MFA policy for
  an account without a factor. A further passkey and new recovery codes do not
  change it. The change sites call `bumpSecurityVersion`
  (`services/auth/security-change-sites.test.ts` lists them).
- The middleware and refresh refuse a token whose `sv` differs. After the
  commit, the replica that made the change stops the account's runtimes. Tool
  contexts keep the version that admitted the turn
  (`tool_execution_contexts.owner_security_version`), so the gateway refuses
  older calls on every replica.
- Scheduled jobs and personal connections keep the version of the sign-in
  session that saved them; a change pauses or suspends them (see
  [tools](tools.md#personal-connections-after-a-security-change)).
- WorkOS accounts have no security version in this database, so objects that a
  revoked WorkOS session created stay active.

## Serialization of account changes

- A new change of a local account takes the locks in one order: the tenant's
  membership advisory lock (manager actions only), the identity row, the
  membership row, then scheduled jobs (`routes/tenant.ts`,
  `lockLocalIdentityForMembershipChange`). Recheck status, version and both
  roles under the identity lock. For one of the events above, increment the
  version with a conditional update.
- A manager action reads the caller's role in the transaction, after the
  advisory lock (`services/member-authority.ts`). For a local caller it also
  compares the caller's own `security_version` with the session's.
- In manager actions, nobody acts on their own account or on an owner, and only
  an owner acts on an admin.
- Only an existing, active local account can be promoted to owner
  (`account_not_active`). A new account cannot get the owner role when it is
  created.
- A role change cancels the target's open links.

## Second factors and passkeys

- TOTP (`local-mfa-service.ts`, `lib/totp.ts`, migration `072`): RFC 6238,
  SHA-1, `TOTP_DIGITS`, `TOTP_PERIOD_SECONDS`, one step of drift. The secret is
  encrypted with `DATA_ENCRYPTION_SECRET`. `last_used_step` makes each code
  single use.
- Recovery codes (`lib/recovery-codes.ts`): `RECOVERY_CODE_COUNT` codes, shown
  once, stored as HMAC-SHA256 under an HKDF key. A recovery code starts no
  sign-in session; the person must enrol a new factor, and that enrolment spends
  the code.
- Sign-in flow (`login-flow-store.ts`): after a correct password, the flow lives
  in Redis (`LOGIN_FLOW_TTL_SECONDS`, `LOGIN_FLOW_MAX_FAILURES`), bound to an
  httpOnly cookie on `/auth/local`. A step that spends a secret takes the flow
  with `GETDEL` first and restores it only on failure. An enrolment prepares its
  sign-in session before commit, so a Redis failure rolls it back.
- Passkeys (`local-passkey-service.ts`, `passkey-challenge-store.ts`, migration
  `073`): on only when `WEBAUTHN_RP_ID` is set. `@simplewebauthn/server` checks
  the exact frontend origin (`API_ORIGIN`), RP id, challenge and user
  verification. Challenges are single use (`PASSKEY_CHALLENGE_TTL_SECONDS`), one
  purpose, and bound to the browser, the sign-in flow, or the sign-in session.
  The signature counter must increase (0 is accepted for synced passkeys).
  Changing `WEBAUTHN_RP_ID` invalidates every registered passkey.
  `WEBAUTHN_RP_NAME` is the site name that authenticators show.
- A passkey counts as a second factor everywhere an authenticator does.
- Tenant policy `tenants.mfa_policy`: `optional`, `required_for_admins`,
  `required_for_all`. Only an owner, with step-up, can make it weaker.
- Adding a factor in signed-in settings needs step-up and an active sign-in
  session; enrolment during sign-in or after a recovery code uses the sign-in
  flow instead. Removing a factor needs strong step-up and ends every sign-in
  session. Under a required policy, the last factor cannot be removed. Step-up
  rules: [sensitive changes](sensitive-changes.md#step-up).
- Manager reset (`POST /tenant/members/:userId/mfa-reset`) deletes the member's
  factors, requires a new enrolment and ends the member's sign-in sessions.

## Operator commands

- `pnpm --filter @cogniplane/backend auth:bootstrap --tenant-name <name>
  --owner-email <email>` creates a local tenant and its owner and prints a setup
  link.
- `pnpm --filter @cogniplane/backend auth:recover-owner --tenant-id <id> --email
  <email>` ends the owner's sign-in sessions, removes the password and factors, writes
  an audit event and prints a new setup link.
- Both read `MIGRATION_DATABASE_URL` from the shell environment (set it on the
  command line; `.env` does not supply it). In the backend image (work directory
  `/app`), run `node apps/backend/dist/scripts/auth-bootstrap.js` and `node
  apps/backend/dist/scripts/auth-recover-owner.js`.
