# Email

Scope: SMTP transport, account emails (links, security notices, forgot
password), and the email outbox worker. Owner notices are in [sensitive
changes](sensitive-changes.md#owner-notices).

`services/mail/`, `lib/smtp-settings.ts`, migrations `074`, `075`, `082`. When
email is on: [startup rules](../configuration.md#startup-rules).

## Transport

- Transport: `smtps://`, or `smtp://` with STARTTLS required; TLS 1.2 or later;
  certificate checks on. `SMTP_ALLOW_PLAINTEXT` is for a local test server and
  is refused in production.
- Recipient: one plain address (`lib/email-address.ts` refuses list syntax).
  Database names are cleaned of control and Unicode format characters and
  escaped in HTML.

## Account emails

- Security notices to local accounts: password changed, factor added or removed,
  manager password reset, manager MFA reset. Notices have no link.
- With email on, setup and reset links go only to the person; the manager's
  answer never holds the link. With email off, the manager gets the link.
  Operator commands always print the link.
- Forgot password (`POST /auth/local/password/forgot`, local login and email
  only): always `202` before any lookup. The work runs after the answer; when
  too many requests wait or the process stops, the request is dropped and
  logged, so a `202` does not promise an email. Each account has a cooldown
  (`SELF_RESET_COOLDOWN_MS` in `services/auth/local-account-service.ts`). The
  link sets the password only.

## Outbox

- Outbox: `email_outbox` rows are written in the change's transaction, encrypted
  with `DATA_ENCRYPTION_SECRET`, under RLS.
- `MailOutboxWorker` (`mail-outbox-worker.ts`) claims rows on `privilegedDb`
  with `SKIP LOCKED`. It sends link emails first and rotates between tenants.
- It retries with backoff, expires old notices (`NOTICE_TTL_MS` in
  `mail-outbox.ts`) and purges finished rows. Delivery is at least once.
- A link email is sent only while its link still works.

