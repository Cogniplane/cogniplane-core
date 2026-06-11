import Fastify from "fastify";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";

import { registerAppLifecycle, registerAppRoutes } from "./app-bootstrap.js";
import { buildAppDependencies, buildSchedulerWorker } from "./app-dependencies.js";
import { loadConfig } from "./config.js";
import { localDevAuth } from "./lib/auth.js";
import { workosAuth } from "./lib/auth-workos.js";
import { CORS_ALLOWED_METHODS, isCorsOriginAllowed } from "./lib/cors.js";
import { createDatabase } from "./lib/db.js";
import { getRedis } from "./lib/redis.js";
import { sanitizeUrl } from "./lib/sanitize-url.js";
import { registerSecurityHeaders } from "./lib/security-headers.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTenantRoutes } from "./routes/tenant.js";
import { TenantMemberStore } from "./services/tenant-member-store.js";
import { TenantOrgSettingsStore } from "./services/tenant-org-settings-store.js";
import { ApprovalStore } from "./services/auth/approval-store.js";
import { Pool } from "pg";

/**
 * Map unhandled errors to a safe envelope so internal Error messages and stack
 * traces never reach clients. Validation errors (Fastify schema, status 400)
 * and any error a route deliberately set a 4xx status on are passed through
 * verbatim — those are part of the API contract. Everything else (status >= 500
 * or unset) is logged in full server-side and returned as an opaque 500.
 */
export function handleAppError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 400 && statusCode < 500) {
    // Client errors (validation, bad input, explicit 4xx) are safe to surface.
    reply.code(statusCode).send({
      error: error.code ?? "bad_request",
      message: error.message
    });
    return;
  }
  // Server errors: log the real cause, return an opaque body.
  request.log.error({ err: error }, "unhandled request error");
  reply.code(statusCode >= 500 ? statusCode : 500).send({
    error: "internal_error",
    message: "An unexpected error occurred."
  });
}

/**
 * Parse the TRUST_PROXY config string into the shape Fastify's `trustProxy`
 * option expects. `request.ip` resolution (and therefore the /mcp and /llm
 * egress IP controls) depend on this matching the deployment's real proxy
 * topology. See the TRUST_PROXY docs in config.ts for the value semantics.
 */
export function parseTrustProxy(raw: string): boolean | number | string {
  const value = raw.trim();
  if (value === "" || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  // Otherwise treat as a comma-separated IP/CIDR allowlist of trusted proxies.
  return value;
}

export async function buildApp() {
  const config = loadConfig();
  const app = Fastify({
    // Resolve `request.ip` from X-Forwarded-For per the deployment's proxy
    // topology. Without this, behind the ECS ALB `request.ip` is the ALB node
    // and the per-runtime egress IP pin (/mcp + /llm) would pin a shared LB
    // address — useless at best, intermittently rejecting cross-AZ traffic at
    // worst. Default "1" trusts exactly the ALB hop.
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    // Defense-in-depth HTTP-layer cap on JSON/raw request bodies. Field-level
    // schemas (e.g. MessagePostRequestSchema.text) enforce tighter per-field
    // limits, but those only run *after* the whole body is buffered, so a global
    // cap is what actually bounds memory for an oversized POST. File uploads use
    // the multipart plugin's own `fileSize` limit and are unaffected by this.
    bodyLimit: config.MAX_REQUEST_BODY_BYTES,
    logger: {
      // Redact runtime tokens (and similar) that callers embed as query
      // parameters on MCP URLs. Fastify's automatic request-completion log
      // serializes `req.url`, so without this strings like `?token=rt_...`
      // would end up in long-term log retention.
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: sanitizeUrl(req.url ?? ""),
            hostname: req.hostname,
            remoteAddress: req.ip,
            remotePort: req.socket?.remotePort
          };
        }
      }
    }
  });

  app.setErrorHandler(handleAppError);

  app.decorate("config", config);
  app.decorate("db", createDatabase(config));
  app.decorate("redis", getRedis(config, app.log));

  const privilegedConnectionString = config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL;
  const privilegedDb =
    privilegedConnectionString === config.DATABASE_URL
      ? app.db
      : new Pool({ connectionString: privilegedConnectionString });

  // Fail fast if Postgres is unavailable so the app does not boot into a half-working state.
  await app.db.query("SELECT 1");

  // The privileged pool is, by definition, the RLS-bypassing superuser pool:
  // background work that must read across tenants (scheduler claiming due jobs,
  // PII scan jobs) and getDownloadToken depend on it. If
  // MIGRATION_DATABASE_URL is unset, privilegedDb silently falls back to the
  // RLS-bound app_user pool, and those cross-tenant queries return zero rows
  // with no error — a near-invisible failure. Verify the pool's contract at boot
  // so the misconfiguration surfaces immediately rather than as mysteriously
  // empty job queues in production. Fail-closed on two axes:
  //   1. If a distinct privileged pool exists, it MUST actually bypass RLS —
  //      asserted unconditionally, never gated on feature flags, so a flag
  //      flipping on later can't be the first thing to reveal a broken pool.
  //   2. If no distinct pool exists (fell back to app.db) but a feature needs
  //      cross-tenant reads, that's fatal — boot would silently return no rows.
  const privilegedNeedsBypassRls =
    config.SCHEDULER_ENABLED || config.PII_PROVIDER_ENABLED || config.AUTH_MODE === "workos";
  if (privilegedDb !== app.db) {
    const { rows } = await privilegedDb.query<{ bypassrls: boolean }>(
      "SELECT rolbypassrls AS bypassrls FROM pg_roles WHERE rolname = current_user"
    );
    if (!rows[0]?.bypassrls) {
      throw new Error(
        "Privileged database pool must use a role with BYPASSRLS (e.g. a superuser). " +
          "Set MIGRATION_DATABASE_URL to a privileged connection distinct from DATABASE_URL. " +
          "Without it, scheduler/PII cross-tenant queries silently return zero rows under RLS."
      );
    }
  } else if (privilegedNeedsBypassRls) {
    throw new Error(
      "Scheduler/PII/workos are enabled but no distinct privileged (BYPASSRLS) database pool is configured. " +
        "Set MIGRATION_DATABASE_URL to a privileged connection distinct from DATABASE_URL. " +
        "Without it, cross-tenant background queries silently return zero rows under RLS."
    );
  }

  await registerSecurityHeaders(app);

  await app.register(cors, {
    origin: (requestOrigin, cb) => cb(null, isCorsOriginAllowed(requestOrigin, config.API_ORIGIN)),
    credentials: true,
    methods: CORS_ALLOWED_METHODS,
    allowedHeaders: ["Content-Type", "Authorization", "X-User-Id", "X-Tenant-Id"]
  });
  await app.register(cookie);
  // Plugin-level defaults so any route that calls `request.file()` without
  // its own limits still has a bound. Per-route `request.file({ limits })`
  // calls override these.
  await app.register(multipart, {
    limits: {
      fileSize: config.ARTIFACT_MAX_UPLOAD_BYTES,
      files: 1
    }
  });

  const deps = buildAppDependencies({
    db: app.db,
    schedulerDb: privilegedDb,
    privilegedDb,
    config,
    logger: app.log
  });

  if (config.AUTH_MODE === "workos") {
    // Auth callback and membership lookups must bypass RLS because they run before
    // the tenant context is established. Use a separate privileged connection pool.
    const authTenantMembers = new TenantMemberStore(privilegedDb);
    app.addHook("preHandler", workosAuth(config, authTenantMembers));
    await registerTenantRoutes(app, {
      db: privilegedDb,
      tenantOrgSettings: new TenantOrgSettingsStore(privilegedDb, config.DATA_ENCRYPTION_SECRET),
      githubConnections: deps.githubConnectionService,
      getMicrosoftConfigured: deps.overlays.getMicrosoftConfigured
    });
  } else {
    app.addHook("preHandler", localDevAuth(config));
    await registerTenantRoutes(app, {
      db: app.db,
      tenantOrgSettings: deps.tenantOrgSettings,
      githubConnections: deps.githubConnectionService,
      getMicrosoftConfigured: deps.overlays.getMicrosoftConfigured
    });
  }

  await registerAuthRoutes(app, {
    db: config.AUTH_MODE === "workos" ? privilegedDb : app.db,
    config,
    auditEvents: deps.auditEvents
  });

  await registerAppRoutes(app, deps);

  const schedulerWorker = buildSchedulerWorker(config, {
    userSettings: deps.userSettings,
    sessions: deps.sessions,
    messages: deps.messages,
    toolContexts: deps.toolContexts,
    runtimeManager: deps.runtimeManager,
    runtimeAdapters: deps.runtimeAdapters,
    dynamicConfig: deps.dynamicConfig,
    getTenantAnthropicApiKey: deps.getTenantAnthropicApiKey,
    getTenantOpenaiApiKey: deps.getTenantOpenaiApiKey,
    auditEvents: deps.auditEvents,
    piiScanJobs: deps.piiScanJobs,
    piiScanJobHandler: deps.piiScanJobHandler,
    logger: app.log
  });

  registerAppLifecycle({
    app,
    config,
    limits: deps.limits,
    runtimeManager: deps.runtimeManager,
    runtimeAdapters: deps.runtimeAdapters,
    privilegedDb,
    schedulerWorker,
    // Cross-tenant stale-approval recovery needs a BYPASSRLS pool; reuse the
    // privileged pool (asserted to bypass RLS above) so the sweep can see every
    // tenant's rows in one statement.
    staleApprovalSweeper: {
      approvals: new ApprovalStore(privilegedDb),
      auditEvents: deps.auditEvents,
      logger: app.log
    }
  });

  return app;
}
