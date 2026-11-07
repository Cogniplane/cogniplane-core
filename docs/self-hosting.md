# Self-hosting

Scope: production deployment. Every variable and default is in
[configuration](configuration.md); this guide names the variables to set and the
decisions to make.

## Components

| Component | Requirement |
|---|---|
| Backend | The [Node.js version](getting-started.md#prerequisites) and Poppler `pdftotext`; the backend image includes both. Keeps only caches and running turns in memory |
| Frontend | Next.js; any Next.js host. This repository builds for Cloudflare Workers (`pnpm --filter @cogniplane/frontend cf:build`) |
| PostgreSQL | 17 (the version CI and Compose use), with RLS. All durable state except stored files |
| Redis | Required with `AUTH_MODE=jwt` ([startup rules](configuration.md#startup-rules)). One dedicated database per environment ([contents](architecture/data.md#redis)) |
| File storage | Artifacts and skill bundles: an S3-compatible bucket, or local disk on a persistent volume ([storage](#other-backend-settings)) |
| E2B | Account and template for code execution |
| WorkOS | Only for SSO tenants |
| SMTP relay | Optional; email for local accounts and owner notices |
| Model provider | At least one platform key, or tenant keys |

The backend makes outbound calls to model providers, E2B, WorkOS, SMTP and proxy
MCP servers. Proxy MCP URLs must be reachable from the backend; put upstream
credentials in the server's authentication fields, never in the URL.

## E2B template

Build the template once per E2B account as in [getting
started](getting-started.md#steps), and set `E2B_TEMPLATE_ID` to the template's
id. The backend cannot detect a wrong real id: check it by running a shell
command in a new chat. Template details:
[sandbox](architecture/sandbox.md#e2b-sandbox).

## Database

The roles and their grants are in [database roles](database-roles.md).

1. Run `pnpm db:migrate` (backend image: `node
   apps/backend/dist/scripts/migrate.js`) with all three URLs before each
   backend release. It creates and updates both runtime roles and their
   passwords.
2. Start the backend with `DATABASE_URL` and `MAINTENANCE_DATABASE_URL` only.
   `MIGRATION_DATABASE_URL` is for the migration job and operator commands. The
   backend image entry point (`docker/backend-entrypoint.sh`) also unsets it;
   `node apps/backend/dist/server.js` started directly does not.
3. Check RLS on a database that has at least one session (sign in once and start
   a chat). As `app_user`:
   ```sql
   BEGIN;
   SELECT count(*) FROM sessions;                                   -- 0
   SELECT set_config('app.current_tenant_id', '<tenant id>', true);
   SELECT count(*) FROM sessions;                                   -- > 0
   SELECT set_config('app.current_tenant_id', 'no-such-tenant', true);
   SELECT count(*) FROM sessions;                                   -- 0
   ROLLBACK;
   ```

## Authentication

```bash
NODE_ENV=production                  # turns on the production startup checks
AUTH_MODE=jwt
AUTH_LOGIN_TYPES=workos,local        # one or both
JWT_SECRET=<32+ random bytes>
JWT_KEY_ID=v1
DATA_ENCRYPTION_SECRET=<32+ random bytes>
REDIS_URL=rediss://...
API_ORIGIN=https://app.example.com   # the frontend origin; exactly one origin
```

- Create `local` tenants with `auth:bootstrap`; WorkOS creates `workos` tenants
  at first sign-in ([modes](architecture/auth.md#modes-and-sign-in-types)).
- WorkOS: set `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, and `WORKOS_REDIRECT_URI` to
  the frontend page `https://<frontend>/auth/callback`, not the backend; that
  page sends the code to `POST /auth/callback`.
- Passkeys: set `WEBAUTHN_RP_ID` to the frontend host name or a parent domain.
  Choose it once ([local
  accounts](architecture/local-accounts.md#second-factors-and-passkeys)).
- Email: set `SMTP_URL` (`smtps://` port 465, or `smtp://` port 587 with
  STARTTLS) and `MAIL_FROM` together. Configure SPF, DKIM and DMARC for the
  sender domain. Effects of email on and off: [email](architecture/email.md).
- Connectors (GitHub, Notion, Jira, Microsoft 365): [connectors](connectors.md).
- Behind a proxy, set `TRUST_PROXY` to the proxy addresses.

## Other backend settings

- Storage: local disk (the default; mount a persistent volume) or an
  S3-compatible bucket. Skill bundles use the artifact bucket connection
  (`services/artifacts/artifact-storage.ts`):
  ```bash
  ARTIFACT_STORAGE_BACKEND=bucket
  ARTIFACT_BUCKET_NAME=cogniplane-files
  ARTIFACT_BUCKET_REGION=us-east-1
  # Only for a non-AWS service: its URL, and path-style addressing if it needs it.
  ARTIFACT_BUCKET_ENDPOINT=https://s3.example.com
  ARTIFACT_BUCKET_FORCE_PATH_STYLE=true
  # Static keys. Unset: the AWS SDK default credential chain (for example a task role).
  ARTIFACT_BUCKET_ACCESS_KEY_ID=...
  ARTIFACT_BUCKET_SECRET_ACCESS_KEY=...
  # Optional: temporary credentials, and a key prefix inside the bucket.
  ARTIFACT_BUCKET_SESSION_TOKEN=...
  ARTIFACT_BUCKET_PREFIX=cogniplane/
  SKILL_BUNDLE_STORAGE_BACKEND=bucket
  SKILL_BUNDLE_BUCKET_NAME=cogniplane-files
  ```
  The backend needs `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on the
  bucket. Skill bundles upload with `@aws-sdk/lib-storage`, which can use
  multipart uploads, so on AWS also allow `s3:AbortMultipartUpload`. Keep it
  private: downloads stream through the backend. Check: upload a file in a chat,
  download it, and import a skill in Admin > Skills.
- Runtime: `E2B_API_KEY`, `E2B_TEMPLATE_ID`.
- Model providers: set at least one platform key, or let tenants add keys
  ([model providers](architecture/models.md#model-providers)). Provider terms
  apply to each key owner.
- PII: `PII_PROVIDER_ENABLED`, `PII_LLM_*`; `PII_RETENTION_KEK` when a tenant
  keeps reversible findings. See [PII](architecture/pii.md).
- Workers: `SCHEDULER_*`. Many replicas can run them.
- Spending defaults: `MODEL_SPENDING_*` ([model
  spending](architecture/model-spending.md)).

## Frontend

- Build with `NEXT_PUBLIC_API_URL` set to the backend URL ([frontend
  builds](architecture/frontend.md#builds-and-variables)). Leave
  `NEXT_PUBLIC_DEV_USER_ID` and the other dev-auth values unset.
- Serve the frontend and the backend over HTTPS; the refresh cookie needs it
  ([auth](architecture/auth.md#tokens-and-cookies)).
- For MCP Apps, serve the sandbox page on a separate origin ([MCP
  Apps](architecture/mcp-apps.md#enable-render_interactive_ui)).

## Deploy with the images

One supported path, with the Dockerfiles in `docker/`. Set the backend variables
from the sections above in a `backend.env` file (see Database, step 2).

```bash
docker build -f docker/backend.Dockerfile -t cogniplane-backend .
docker build -f docker/frontend.Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t cogniplane-frontend .

# 1. Migrations: all three database URLs, once per release.
docker run --rm -e DATABASE_URL=... -e MAINTENANCE_DATABASE_URL=... \
  -e MIGRATION_DATABASE_URL=... cogniplane-backend node apps/backend/dist/scripts/migrate.js

# 2. Backend (port 3001). --stop-timeout: see the shutdown note in operations.md.
#    Local storage: keep the volume and the two roots; with a bucket, drop them.
docker run -d --env-file backend.env -p 3001:3001 --stop-timeout 40 \
  -v cogniplane-data:/var/lib/cogniplane \
  -e ARTIFACT_STORAGE_ROOT=/var/lib/cogniplane/artifacts \
  -e SKILL_BUNDLE_STORAGE_ROOT=/var/lib/cogniplane/skills \
  cogniplane-backend
curl -fsS https://api.example.com/ready     # {"status":"ok"}

# 3. Frontend (port 3000).
docker run -d -p 3000:3000 cogniplane-frontend
```

For MCP Apps, see the image note in [MCP
Apps](architecture/mcp-apps.md#enable-render_interactive_ui). Put TLS in front
of both. Chat turns stream as SSE (`text/event-stream`): configure the proxy not
to buffer them (for nginx, `proxy_buffering off`) and to allow long-lived
connections. Check: send a chat message; the answer must appear progressively,
not all at once at the end. For Cloudflare Workers, build the frontend with
`cf:build` instead ([frontend](architecture/frontend.md#builds-and-variables)).

## Production checklist

- [ ] `AUTH_MODE=jwt`, never `dev-headers`.
- [ ] Unique `JWT_SECRET` and `DATA_ENCRYPTION_SECRET` (startup refuses the
  built-in defaults).
- [ ] `REDIS_URL` set, on a dedicated Redis database.
- [ ] RLS check (step 3) returns 0, then more than 0, then 0.
- [ ] Backend has no `MIGRATION_DATABASE_URL`.
- [ ] TLS in front of the backend and the frontend.
- [ ] Private bucket.
- [ ] `E2B_TEMPLATE_ID` matches the current build.
- [ ] Backups cover PostgreSQL and object storage ([Backups and
  restore](operations.md#backups-and-restore)).
- [ ] A scheduled delete for old `audit_events` and `tool_events` ([Audit
  retention](operations.md#audit-retention)).
- [ ] Each tenant has an owner.

Operations (upgrade, scaling, secret rotation, backups, audit retention, tenant
deletion, monitoring): [operations](operations.md).
