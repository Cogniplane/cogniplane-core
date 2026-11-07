# Operations

Scope: upgrades, scaling, secret rotation, backups, audit retention, tenant
deletion and monitoring of a production install. Deployment is in
[self-hosting](self-hosting.md).

## Upgrade

1. Back up ([Backups and restore](#backups-and-restore)).
2. Run the migration job of the new release.
3. Roll out the new backends, then the new frontend.
4. Run a new file in `apps/backend/db/deferred/` only when its own header
   condition holds, usually after every backend runs the new release
   ([development](development.md#conventions)).

Shutdown (`server.ts`, `app-bootstrap.ts`): on `SIGTERM` the backend refuses new
turns (503 `server_draining`), stops the scheduler and mail workers, lets
running turns finish for a few seconds, then interrupts the rest (saved as
`interrupted`). Scheduled jobs get the same wait, then their runtimes close and
a second, longer wait lets them write their outcome. After 35 seconds the
process exits. Give each backend a termination grace of at least 40 seconds;
Docker's default is 10 seconds (Compose `stop_grace_period`). Check a rolling
restart: start a long chat turn, restart its backend, and see the turn end as
interrupted, not stuck.

Migrations are forward-only; there are no down migrations, and older backends
are not tested against a newer schema. If the new backends fail `/ready`, fix
forward, or stop the backends, restore the backup from step 1 and redeploy the
previous images.

## Scale out

Run several backends behind a load balancer, with Redis and shared file storage
(a bucket; local storage roots are per replica). Then any replica can serve any
request:

- The session execution lease in PostgreSQL allows one running turn per session
  across replicas.
- A reconnecting browser replays a running turn from Redis
  ([runtime](architecture/runtime.md#reconnect-and-stop)).
- The replica that runs the next turn rebuilds the agent and reconnects to the
  sandbox as described in [session
  types](architecture/runtime.md#session-types). Files that existed only in an
  expired or replaced sandbox are lost.
- Sticky sessions are not required.
- Database connections: each replica opens up to three pools (`db` and
  `privilegedDb`: `POOL_MAX` each in `lib/db.ts`; checkpointer:
  `CHECKPOINTER_POOL_MAX` in
  `services/deep-agents/deep-agents-checkpointer.ts`). Size PostgreSQL
  `max_connections` for their sum per replica plus the migration job and
  operator tools.

## Rotate secrets

- `MCP_UPSTREAM_SIGNING_ROOT_SECRET` (or `DATA_ENCRYPTION_SECRET` when it is
  unset): a change gives every proxy MCP server a new key ([get a
  key](mcp-proxy-signature.md#get-an-upstream-key)). Compute the new key of each
  upstream, give it to the upstream, then deploy; requests fail verification
  until both sides use the new key.
- `JWT_SECRET`, in three deployments, each finished on every replica before the
  next (`lib/jwt.ts` refuses an unknown `kid`):
  1. Add the new key for verification only: `JWT_VERIFICATION_KEYS={"<new
     kid>":"<new secret>"}`. Signing is unchanged.
  2. Sign with it: `JWT_SECRET=<new secret>`, `JWT_KEY_ID=<new kid>`,
     `JWT_VERIFICATION_KEYS={"<old kid>":"<old secret>"}`.
  3. After `REFRESH_TOKEN_TTL` (`apps/backend/src/lib/jwt.ts`), remove the old
     key from `JWT_VERIFICATION_KEYS`.

  Skipping step 1 rejects tokens that new replicas sign on old replicas;
  skipping the old key in step 2 signs every user out.
- `DATA_ENCRYPTION_SECRET`: cannot be rotated
  ([security](security.md#secrets-and-encryption)).
- `WORKOS_API_KEY`, provider keys, SMTP credentials: replace and redeploy.

## Backups and restore

Back up together, at the same point in time. A simple method: stop the backends
(or run during a maintenance window), take `pg_dump` of the whole database and a
copy or snapshot of the bucket, check that both completed, then start the
backends. With continuous PostgreSQL backups, take the bucket copy at the same
recovery point and keep bucket versioning on. A versioned bucket keeps the old
versions of deleted objects: add a lifecycle rule that expires noncurrent
versions, or they stay.

What to back up:

- PostgreSQL, all schemas (`public` and `deep_agents`).
- The artifact and skill bundle bucket, or the local storage roots.
- The environment, at least `DATA_ENCRYPTION_SECRET`, `JWT_SECRET`, and
  `PII_RETENTION_KEK` when a tenant keeps encrypted PII findings. Without the
  same keys, encrypted values cannot be read.

Redis is not a backup target ([what it holds](architecture/data.md#redis)).

Example with the PostgreSQL client tools of the server's major version. The dump
has no owners or grants; the migration job recreates the runtime roles, their
passwords and grants:

```bash
pg_dump --format=custom --no-owner --no-acl "$MIGRATION_DATABASE_URL" > cogniplane.dump
# Restore into an empty database, then run the migration job (step 3 below).
pg_restore --no-owner --no-acl --dbname "$MIGRATION_DATABASE_URL" cogniplane.dump
```

Restore into a stopped environment:

1. Restore PostgreSQL and storage from the same point in time.
2. Set the same `DATA_ENCRYPTION_SECRET` and `PII_RETENTION_KEK`, and the same
   image version that took the backup. With local storage, restore files to the
   same `ARTIFACT_STORAGE_ROOT` and `SKILL_BUNDLE_STORAGE_ROOT`: skill revisions
   store absolute `file://` paths.
3. Run the migration job, then start the backends; `GET /ready` must return 200.
4. Check: sign in; open an old normal chat and send a turn (checkpoint); open a
   project file and download an artifact (storage); open a skill revision's
   files in Admin > Skills (bundles); run a turn with a tenant provider key
   (encrypted columns). No route decrypts retained PII findings, so this check
   cannot prove `PII_RETENTION_KEK`.

## Audit retention

No worker deletes `audit_events`. `tool_events` rows go only when their session
is purged from trash (foreign-key cascade) or the tenant is deleted. A
restrictive RLS policy forbids deletes of `audit_events` for `app_user`, and
`maintenance_user` has only INSERT on it (`MAINTENANCE_GRANTS`). Run retention
as the migration role, in batches, on a schedule:

```sql
DELETE FROM audit_events WHERE id IN (
  SELECT id FROM audit_events WHERE created_at < now() - interval '365 days' LIMIT 10000);
DELETE FROM tool_events WHERE id IN (
  SELECT id FROM tool_events WHERE created_at < now() - interval '365 days' LIMIT 10000);
```

Repeat each statement until it deletes no row. Choose the interval from your
retention policy.

## Delete a tenant

`tenant:delete` (`services/tenant-deletion-service.ts`) first deletes the
tenant's rows and writes a receipt (`tenant_deletion_receipts`) in one
transaction, then removes storage objects and checkpoint threads, which are
queued in `tenant_deletion_cleanup`. It flushes the whole Redis database of
`REDIS_URL`, so it signs out every user of the environment.

```bash
MIGRATION_DATABASE_URL=... pnpm --filter @cogniplane/backend tenant:delete \
  --tenant-id <id> --confirm <same id> --request-id <ticket> \
  --third-party-disposition "<text>" --backup-disposition "<text>" \
  --maintenance-confirmed
```

In the backend image, run `node apps/backend/dist/scripts/delete-tenant.js` with
the same flags. Stop the backends first; `--maintenance-confirmed` states that
writes stopped.

The command prints the receipt. Status `completed` means the command's cleanup
queue is empty: the tenant's rows, storage objects and checkpoint threads are
deleted. Older versions in a versioned bucket stay until its lifecycle rule
removes them. Any other status exits 1 and means some objects or threads are
still queued: run the command again with the same `--request-id`. A new request
id fails after the rows are gone, because the tenant no longer exists.

## Monitor

- `GET /health`: liveness; does not check dependencies.
- `GET /ready`: readiness; 503 when PostgreSQL does not answer in time
  (`routes/health.ts`). It does not check Redis: check it on its own (for
  example `redis-cli -u "$REDIS_URL" ping` answers `PONG`).
- `GET /admin/diagnostics` (admins; Admin > Runtime diagnostics): build
  metadata, uptime and runtime activity.
- Logs are structured (pino, level `LOG_LEVEL`) and drop credential URL
  parameters (`lib/sanitize-url.ts`); there is no metrics endpoint. The backend
  listens on `API_HOST`:`API_PORT` (default port 3001).

Alert on:

- Backend 5xx rate and startup failures.
- Redis unavailable: with `jwt`, sign-in and token refresh fail.
- `audit_events` auth failures (`event_type LIKE 'auth.%'`).
- `approvals` still `pending` after their TTL.
- `scheduled_job_runs` failures.
- Model cost: `messages.cost_usd` and the [spending
  ledger](architecture/model-spending.md).

Read-only checks (run as the migration role):

```sql
SELECT count(*) FROM approvals WHERE status = 'pending' AND expires_at < now();
SELECT count(*) FROM scheduled_job_runs WHERE status = 'failed' AND started_at > now() - interval '1 day';
SELECT status, count(*) FROM email_outbox WHERE status IN ('queued', 'failed') GROUP BY status;
SELECT count(*) FROM email_outbox WHERE status = 'queued' AND next_attempt_at < now() - interval '15 minutes';
SELECT count(*) FROM tenant_deletion_receipts WHERE status <> 'completed';
SELECT tenant_id, count(*) FROM model_spending_reservations WHERE status = 'unknown' GROUP BY tenant_id;
```
