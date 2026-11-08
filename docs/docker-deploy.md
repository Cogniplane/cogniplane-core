# Docker deploy

Scope: run the full stack on one machine with `docker compose` (`compose.yaml`).
This stack uses `dev-headers` authentication and listens on `127.0.0.1` only. It
is not a production deployment; for that, see [self-hosting](self-hosting.md).

## Services

| Service | Purpose |
|---|---|
| `exposure-guard` | Refuses to start when PostgreSQL binds beyond loopback with default credentials |
| `postgres` | PostgreSQL 18, volume `postgres-data`, port `${POSTGRES_BIND_ADDR:-127.0.0.1}:5432` |
| `redis` | Redis, volume `redis-data`, `127.0.0.1:6379` |
| `migrate` | One-shot migration job; the backend waits for it to succeed |
| `backend` | Fastify and the agent loop, `127.0.0.1:3001`; files in volume `backend-data` (`/var/lib/cogniplane`) |
| `frontend` | Next.js, `127.0.0.1:3000` |
| `mailpit` | Mail catcher for `make dev` email tests (profile `mail`); the Compose backend does not send email |

The `backend` and `frontend` containers run with read-only root filesystems, no
Linux capabilities, and CPU and memory limits. Code execution runs in E2B, not
on the host.

## Run

Prerequisites: Docker with Compose, an E2B account and a key for at least one
[model provider](architecture/models.md#model-providers). Clone, install and
build the E2B template as in [getting started](getting-started.md#steps) (the
build runs on the host).

Create `.env` in the repository root (Compose reads it):

```
E2B_API_KEY=e2b_...
E2B_TEMPLATE_ID=<id from the build>
ANTHROPIC_API_KEY=...            # or another provider key (see model providers)
POSTGRES_PASSWORD=<openssl rand -hex 32>
APP_USER_PASSWORD=<another value>
MAINTENANCE_USER_PASSWORD=<another value>
DEV_HEADERS_AUTH_KEY=<another value, 16 characters or more>
```

The three passwords and `DEV_HEADERS_AUTH_KEY` are optional on loopback; the
defaults are public. Then:

```bash
docker compose up --build      # first build takes several minutes
```

Open `http://localhost:3000`. You are the development user, an owner ([getting
started](getting-started.md#check-that-it-works)).

Optional variables: `MODEL_SPENDING_MONTHLY_LIMIT_USD`,
`MODEL_SPENDING_TURN_RESERVATION_USD`.

Stop with `docker compose down`; add `--volumes` to delete all data.

## Upgrade from PostgreSQL 17

The stack used PostgreSQL 17 before. PostgreSQL 18 cannot open PostgreSQL 17
data. If `postgres-data` has PostgreSQL 17 data, the `postgres` container stops
with `Error: in 18+, these Docker images are configured to store database data
in a format...` and leaves the old data unchanged. `make dev` then waits for
PostgreSQL without end.

If you do not need the data, delete the volume:

```bash
docker compose down
docker volume rm "$(docker compose config --format json | jq -r '.volumes["postgres-data"].name')"
```

To keep the data, dump it with PostgreSQL 17 and restore it into PostgreSQL 18:

```bash
docker compose down
volume="$(docker compose config --format json | jq -r '.volumes["postgres-data"].name')"

# 1. Dump with PostgreSQL 17. The container publishes no port.
docker run -d --name cogniplane-pg17 -v "$volume:/var/lib/postgresql/data" postgres:17.11
until docker exec cogniplane-pg17 pg_isready -U postgres -d cogniplane; do sleep 1; done
docker exec cogniplane-pg17 pg_dumpall -U postgres --globals-only > pg17-globals.sql
docker exec cogniplane-pg17 pg_dump -U postgres -Fc cogniplane > pg17-cogniplane.dump
docker rm -f cogniplane-pg17

# 2. Archive the old volume, then delete it.
docker run --rm -v "$volume:/data:ro" -v "$PWD:/backup" postgres:17.11 \
  tar -C /data -czf /backup/pg17-volume.tar.gz .
docker volume rm "$volume"

# 3. Restore into PostgreSQL 18. psql shows one error, because the role
#    "postgres" already exists. The other statements must succeed.
docker compose up -d postgres
until docker exec cogniplane-postgres pg_isready -U postgres -d cogniplane; do sleep 1; done
docker exec -i cogniplane-postgres psql -U postgres -d postgres < pg17-globals.sql
docker exec -i cogniplane-postgres pg_restore -U postgres -d cogniplane --exit-on-error < pg17-cogniplane.dump
docker exec cogniplane-postgres vacuumdb -U postgres --all --analyze-in-stages
```

Then start the stack as usual. Keep the three `pg17-*` files until the
upgraded stack works. They contain password hashes and all workspace data;
store them as you store the database.

## Limits

- `API_ORIGIN`, the frontend build arguments and the app ports are fixed in
  `compose.yaml` for `localhost`. To serve other machines, do not edit this
  stack to expose `dev-headers`: anyone who reaches the backend can act as any
  user. Deploy with `AUTH_MODE=jwt`, TLS and the steps in
  [self-hosting](self-hosting.md).
- Artifacts and skill bundles use local storage in `backend-data`.
- The backend has `stop_grace_period: 40s`, longer than its shutdown deadline
  ([shutdown](operations.md#upgrade)).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `postgres` restarts with `Error: in 18+, these Docker images...` | The volume has PostgreSQL 17 data. See [upgrade from PostgreSQL 17](#upgrade-from-postgresql-17). |
| "Could not load the model list" | The backend is not up: `docker compose logs backend`. |
| Empty model list | See [getting started](getting-started.md#troubleshooting). |
| Shell or file tools fail | The template id must exist in the E2B account of the key, and outbound access to E2B must work. |
| `EBADENGINE` during build | The Dockerfiles pin a Node 24 image. Update it together with `engines.node`. |
