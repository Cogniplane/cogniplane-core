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
a second, longer wait lets them write their outcome. After
`SHUTDOWN_DEADLINE_MS` (35 seconds) the process exits. Give each backend a
termination grace of at least 40 seconds; Docker's default is 10 seconds, and
the Compose stack sets `stop_grace_period: 40s`. Check a rolling restart: start
a long chat turn, restart its backend, and see the turn end as interrupted, not
stuck.

Migrations are forward-only; there are no down migrations, and older backends
are not tested against a newer schema. If the new backends fail `/ready`, fix
forward, or stop the backends, restore the backup from step 1 and redeploy the
previous images.

### Upgrade to removal records

Migration `091` adds `tenant_member_removals` ([roles](architecture/auth.md#roles)).
It also records the removals from before the upgrade. Each user with a
`tenant.member.removed` audit event and no membership in that tenant gets a
record, at the time of the latest event. WorkOS sign-in then refuses the user.
A user with a membership gets no record: the data does not show whether the
tenant wanted the user back. Limits:

- A removal with no audit event gets no record, so the next WorkOS sign-in adds
  the user again. Older builds wrote no event, and
  [audit retention](#audit-retention) can have deleted it. Remove such a user
  again after the upgrade.
- During the rollout, a backend of the earlier release removes a member
  without a record, and its WorkOS sign-in adds a removed user back.

After every backend runs the new release, run
`apps/backend/db/deferred/record-member-removals.sql` once with `psql` and the
migration credential. It records the removals again, and lists each member
whose membership started after their latest removal. For each listed member, an
owner or admin of that tenant decides; when the return was not wanted, they
remove the member again in Admin > People.

The file takes the membership lock of every tenant before it reads, in
`tenant_id` order, and keeps the locks until it commits. A WorkOS sign-in that
holds a lock when the file starts finishes first: its membership stays, and the
file lists it. A sign-in or member change that starts later waits for the
commit, so the sign-in of a removed user is then refused. While the file runs,
sign-ins and member changes of every tenant wait; a wait longer than the
30-second statement timeout of the backends fails that request. Run the file
when traffic is low. A lock wait of more than 5 seconds (`lock_timeout`), or a
deadlock with a tenant deletion that runs at the same time, rolls the file back
with no change; run it again. Do not run it while a backend of the earlier
release still runs: those backends take no lock and do not check the records.

### Migration limits

The migration job runs the migrations, the role setup and the grants on one
connection, with `application_name` `cogniplane-migrate`. `applyMigrations`
(`apps/backend/src/scripts/migrate-lib.ts`) sets two limits on that connection:

- No statement timeout. A constraint validation or a backfill on a large table
  can run for many minutes. The 30-second statement timeout of the backend
  pools (`lib/db.ts`) does not apply. The runner also clears a
  `statement_timeout` that the server, the database or the role sets. A
  migration file can set its own limit with `SET LOCAL statement_timeout`.
- A lock wait stops after 10 seconds (`lock_timeout`). This applies to the
  migration lock (another migration job) and to each table lock that a
  migration waits for. The migration then rolls back and the job fails.
  Migrations that committed before it stay applied, and the next run starts
  at the failed file. Run the job again when the sessions that held the lock
  have ended.

A long migration keeps its table locks until it commits. Backend queries that
conflict with those locks wait, and fail after their 30-second statement
timeout. Run a long migration when traffic is low.

To stop a running migration, cancel it on the server. The migration rolls back:

```sql
SELECT pg_cancel_backend(pid) FROM pg_stat_activity
WHERE application_name = 'cogniplane-migrate';
```

If you stop only the job process, PostgreSQL can continue the statement until
it ends. The Deep Agents checkpoint setup (`setupDeepAgentsCheckpointer`) uses
a second, short-lived connection with the server's default limits.

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
  `max_connections` for their sum per replica plus the migration job (two
  connections) and operator tools.

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

No worker deletes `audit_events`. `tool_events` rows go only when trash or
scheduled session retention deletes their session (foreign-key cascade, [data
retention](architecture/data.md#retention-and-deletion)), or when the tenant is
deleted. A
restrictive RLS policy forbids deletes of `audit_events` for `app_user`, and
`maintenance_user` has only INSERT on it (`MAINTENANCE_GRANTS`). `app_user`
also cannot delete the tenant row, whose cascade would delete them ([tenant
deletion boundary](database-roles.md#tenant-deletion-boundary)). Run retention
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
queued in `tenant_deletion_cleanup`. It does not change Redis unless you add
`--flush-redis` ([Redis](#redis-and-tenant-deletion)). It kills no E2B
sandbox: a sandbox of the tenant runs until E2B expires it
(`E2B_SANDBOX_TIMEOUT_MS` after its last turn start).

User rows: the transaction finds each user that a row of the tenant names,
also a former member with no membership left, and locks these `users` rows.
After the tenant's rows are deleted, it deletes each of these users that no
other row names (`row_counts.orphaned_users`). A user that a row of another
tenant still names keeps the `users` row, for example a member removed from
that tenant whose sessions or audit events stay there. User ids in JSON
payloads (for example `audit_events.payload`) are not checked.

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
id fails after the rows are gone, because the tenant no longer exists. A run
for a completed request does nothing and prints the same receipt.

### Redis and tenant deletion

Without `--flush-redis`, the command does not connect to Redis. The command
cannot remove only the deleted tenant's Redis keys: most keys do not name a
tenant (for example `refresh_family:<id>`). The tenant's keys (refresh-token
families, sign-in flows, rate-limit and quota counters) stay until they
expire. They give no access: token refresh and each request check the
membership in PostgreSQL (`checkAuthAdmission`, `lib/auth-admission.ts`), and
the membership is deleted. The receipt's `redisDisposition` starts with
`Redis not flushed`.

`--flush-redis` adds `FLUSHDB` on the database number that `REDIS_URL` selects
(`/2` in `redis://host:6379/2`; no number means `0`). It removes every key in
that database, for all tenants:

- Every user of every tenant is signed out.
- All rate-limit and daily turn quota counters start again from zero.
- Sign-in flows, step-up tokens and token-reuse detections that are not yet in
  the audit log are lost ([what Redis holds](architecture/data.md#redis)).
- Another service that uses the same database number loses its data.

Other database numbers on the same server do not change. Use the flag only
when the environment has its own Redis database and you accept these effects.
Without `REDIS_URL`, the command refuses `--flush-redis` before it deletes
anything.

Only the run that deletes the rows can request a flush. The receipt tells what
happened:

| `redisDisposition` starts with | Meaning |
|---|---|
| `REDIS_URL was not configured` | No Redis; nothing to flush. |
| `Redis not flushed: --flush-redis was not given` | Redis did not change. |
| `Redis flush requested` | The flush is queued and did not run yet. |
| `Redis database flushed` | The flush ran. |
| `Redis flush failed` | The flush is still queued. |
| `Redis not flushed: a flush is queued` | A run without `--flush-redis` found a queued flush and did not run it. |

To finish a queued flush, run the command again with the same `--request-id`
and `--flush-redis`. A run without the flag never flushes: it keeps the flush
queued and exits 1. This is also true for a request from a version before
`--flush-redis`. Such a version queued a flush whenever `REDIS_URL` was set,
and wrote `Dedicated environment Redis database flushed` before the flush ran.
A replay with `--flush-redis` for a request that has no queued flush does not
flush; it prints a note to stderr.

## Monitor

- `GET /health`: liveness; does not check dependencies.
- `GET /ready`: readiness; 503 when PostgreSQL does not answer in time
  (`routes/health.ts`). It does not check Redis: check it on its own (for
  example `redis-cli -u "$REDIS_URL" ping` answers `PONG`).
- `GET /admin/diagnostics` (admins; Admin > Runtime diagnostics): build
  metadata, uptime and runtime activity.
- Logs are structured (pino, level `LOG_LEVEL`) and drop credential URL
  parameters (`lib/sanitize-url.ts`); there is no metrics endpoint. The backend
  listens on `API_HOST`:`API_PORT`.

Alert on:

- Backend 5xx rate and startup failures.
- Redis unavailable: with `jwt`, sign-in and token refresh fail.
- Log lines `idle database connection failed`: PostgreSQL or the network
  closed an idle connection of the pool in field `pool`. The pool opens a new
  connection on the next query. Many lines in a short time mean a database
  restart, a failover or a network fault.
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
