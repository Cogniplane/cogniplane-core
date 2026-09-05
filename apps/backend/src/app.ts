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
import { createDatabase, createPrivilegedDatabase } from "./lib/db.js";
import { getRedis } from "./lib/redis.js";
import { sanitizeUrl } from "./lib/sanitize-url.js";
import { registerSecurityHeaders } from "./lib/security-headers.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTenantRoutes } from "./routes/tenant.js";
import { TenantMemberStore } from "./services/tenant-member-store.js";
import { ApprovalStore } from "./services/auth/approval-store.js";
import { MessageStore } from "./services/message-store.js";
import { resolveStaleMessageDeadline } from "./services/runtime/stale-message-sweeper.js";

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
 * option expects. This governs `request.ip` resolution for general request
 * handling and logging ONLY. It does not participate in `/mcp` admission: the
 * gateway reads the raw socket peer (`request.raw.socket.remoteAddress`) and
 * deliberately ignores every forwarded header. See the TRUST_PROXY docs in
 * config.ts for the value semantics.
 */
export function parseTrustProxy(raw: string): boolean | string {
  const value = raw.trim();
  if (value === "" || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  if (/^\d+$/.test(value)) {
    // Hop-count trust is GONE, deliberately. Fastify 5.12.1 removed it for
    // GHSA-3m5p-2c4r-xxw2 and now fails closed on a numeric value at runtime
    // ("Hop-count-only trust cannot validate the immediate peer"): counting
    // hops never checks WHO the immediate peer is, so a direct client can
    // spoof X-Forwarded-For by supplying enough hops itself.
    //
    // Reproducing it as a hop-comparing TrustProxyFunction would reintroduce
    // exactly the vulnerability, so this refuses instead. Operators set an
    // IP/CIDR allowlist of their actual proxies (e.g. the ALB subnets), which
    // validates the peer rather than trusting a count.
    throw new Error(
      `TRUST_PROXY="${value}": numeric hop counts are no longer supported. ` +
        "Fastify removed them as spoofable (GHSA-3m5p-2c4r-xxw2). Set TRUST_PROXY to a " +
        "comma-separated IP/CIDR list of your trusted proxies (e.g. the load balancer's " +
        "subnets), or \"true\" only if every path to this server is already trusted."
    );
  }
  // Otherwise treat as a comma-separated IP/CIDR allowlist of trusted proxies.
  return value;
}

export async function buildApp() {
  const config = loadConfig();
  const app = Fastify({
    // Resolve `request.ip` from X-Forwarded-For per the deployment's proxy
    // topology, so logs and rate limits see the real client rather than the
    // load balancer. This does NOT affect /mcp admission, which checks the raw
    // socket peer for loopback and ignores forwarded headers entirely.
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    // Defense-in-depth HTTP-layer cap on JSON/raw request bodies. Field-level
    // schemas (e.g. MessagePostRequestSchema.text) enforce tighter per-field
    // limits, but those only run *after* the whole body is buffered, so a global
    // cap is what actually bounds memory for an oversized POST. File uploads use
    // the multipart plugin's own `fileSize` limit and are unaffected by this.
    bodyLimit: config.MAX_REQUEST_BODY_BYTES,
    logger: {
      // Operators can raise/lower verbosity per environment without a code
      // change (e.g. `debug` to diagnose a prod incident).
      level: config.LOG_LEVEL,
      // Logging-layer safety net. The `req` serializer below already omits the
      // headers object, but redact common secret-bearing paths so any future
      // ad-hoc `request.log.*({ ... })` call that includes one of these can't
      // print a token/password verbatim.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "*.authorization",
          "*.password",
          "*.secret",
          "*.token"
        ],
        censor: "[REDACTED]"
      },
      // Redact secrets that callers may embed as query parameters. Fastify's
      // automatic request-completion log serializes `req.url`, so without
      // this a caller-supplied `?token=`/`?apiKey=` would end up in
      // long-term log retention.
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
  // Unmatched routes return the app's standard `{ error }` envelope rather than
  // Fastify's default `{ statusCode, error, message }` body, so clients parse a
  // single 404 contract whether the route is missing or the request was rejected.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "not_found" });
  });

  app.decorate("config", config);
  app.decorate("db", createDatabase(config));
  app.decorate("redis", getRedis(config, app.log));

  const privilegedConnectionString = config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL;
  const privilegedDb =
    privilegedConnectionString === config.DATABASE_URL
      ? app.db
      : createPrivilegedDatabase(privilegedConnectionString);

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

  // The mirror of the assertion above, and the more security-relevant of the
  // two: the app pool must NOT bypass RLS. Row-Level Security is the tenant
  // isolation boundary for every request path, and a superuser or BYPASSRLS
  // role silently ignores every policy — `withTenantScope` would still set the
  // GUC, every query would still look correct, and each tenant would quietly
  // see all the others' rows. Nothing else in the system would report a fault.
  // Checked in workos mode only: local dev routinely points DATABASE_URL at a
  // superuser, and there is no tenant isolation to protect there.
  if (config.AUTH_MODE === "workos") {
    const { rows } = await app.db.query<{ bypassrls: boolean; superuser: boolean }>(
      "SELECT rolbypassrls AS bypassrls, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user"
    );
    if (rows[0]?.bypassrls || rows[0]?.superuser) {
      throw new Error(
        "The application database pool must NOT bypass Row-Level Security. " +
          "DATABASE_URL is connecting as a superuser or a BYPASSRLS role, which disables every tenant " +
          "isolation policy. Point DATABASE_URL at the unprivileged application role (app_user)."
      );
    }
  }

  await registerSecurityHeaders(app);

  await app.register(cors, {
    origin: (requestOrigin, cb) => cb(null, isCorsOriginAllowed(requestOrigin, config.API_ORIGIN)),
    credentials: true,
    methods: CORS_ALLOWED_METHODS,
    allowedHeaders: ["Content-Type", "Authorization", "X-User-Id", "X-Tenant-Id", "X-Dev-Auth-Key"]
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

  // Subscribe to cross-replica policy cache invalidations before serving
  // traffic. Failure is logged inside start(); the rule-cache TTL is the
  // fallback, so boot proceeds either way.
  await deps.policyService.start();

  if (config.AUTH_MODE === "workos") {
    // Auth callback and membership lookups must bypass RLS because they run before
    // the tenant context is established. Use a separate privileged connection pool.
    const authTenantMembers = new TenantMemberStore(privilegedDb);
    // onRequest, not preHandler: authentication only reads headers/url, so
    // gating here rejects unauthenticated callers before body parsing/validation.
    app.addHook("onRequest", workosAuth(config, authTenantMembers, deps.integrationDescriptors.oauthCallbackPaths()));
    await registerTenantRoutes(app, {
      db: app.db,
      tenantOrgSettings: deps.tenantOrgSettings,
      githubConnections: deps.githubConnectionService,
      integrationDescriptors: deps.integrationDescriptors,
      getMicrosoftConfigured: deps.overlays.getMicrosoftConfigured
    });
  } else {
    app.addHook("onRequest", localDevAuth(config, deps.integrationDescriptors.oauthCallbackPaths()));
    await registerTenantRoutes(app, {
      db: app.db,
      tenantOrgSettings: deps.tenantOrgSettings,
      githubConnections: deps.githubConnectionService,
      integrationDescriptors: deps.integrationDescriptors,
      getMicrosoftConfigured: deps.overlays.getMicrosoftConfigured
    });
  }

  // Admin routes run the heaviest aggregate queries in the app and are spread
  // across a dozen registration functions, so throttle them in one place rather
  // than per route. Added after the auth hook, so request.auth is populated.
  if (deps.limits) {
    const limits = deps.limits;
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/admin/") || !request.auth) return;
      const limitError = await limits.consumeRateLimit({
        resource: "admin_query",
        userId: request.auth.userId,
        tenantId: request.auth.tenantId
      });
      if (!limitError) return;
      reply.code(429);
      reply.header("retry-after", Math.max(1, Math.ceil(limitError.retryAfterMs / 1000)));
      return reply.send(limitError);
    });
  }

  await registerAuthRoutes(app, {
    db: config.AUTH_MODE === "workos" ? privilegedDb : app.db,
    config,
    auditEvents: deps.auditEvents,
    limits: deps.limits,
    integrationDescriptors: deps.integrationDescriptors
  });

  await registerAppRoutes(app, deps);

  const schedulerWorker = buildSchedulerWorker(config, {
    userSettings: deps.userSettings,
    sessions: deps.sessions,
    messages: deps.messages,
    toolContexts: deps.toolContexts,
    runtimeAdapter: deps.runtimeAdapter,
    dynamicConfig: deps.dynamicConfig,
    customModels: deps.customModels,
    providerCredentials: deps.providerCredentials,
    auditEvents: deps.auditEvents,
    piiScanJobs: deps.piiScanJobs,
    piiScanJobHandler: deps.piiScanJobHandler,
    logger: app.log
  });

  const staleMessageDeadlineMs = resolveStaleMessageDeadline(config);

  registerAppLifecycle({
    app,
    config,
    limits: deps.limits,
    policyService: deps.policyService,
    runtimeAdapter: deps.runtimeAdapter,
    privilegedDb,
    schedulerWorker,
    // Cross-tenant stale-approval recovery needs a BYPASSRLS pool; reuse the
    // privileged pool (asserted to bypass RLS above) so the sweep can see every
    // tenant's rows in one statement.
    staleApprovalSweeper: {
      approvals: new ApprovalStore(privilegedDb),
      auditEvents: deps.auditEvents,
      logger: app.log
    },
    // Same pool, same reason: assistant rows a killed process left `pending`/
    // `streaming` span every tenant. Disabled when the turn watchdog is off —
    // RUNTIME_TURN_TIMEOUT_MS=0 means a turn has no ceiling, so no staleness
    // deadline can distinguish an abandoned row from a live one.
    //
    // The deadline is the turn's wall-clock ceiling: the watchdog caps WORKING
    // time at RUNTIME_TURN_TIMEOUT_MS but pauses while a human decides an
    // approval, so real elapsed time is working time plus approval time. The
    // approval loop is unbounded (bead l2pq), so no finite deadline covers every
    // turn. The x3 factor budgets for a few approval rounds, and the AG-UI writer
    // refreshes `updated_at` on a timer so an approval wait keeps its row alive.
    //
    // That false positive is self-healing and not worth a heavier mechanism: the
    // live writer's terminal updateContent overwrites the row with the true
    // status at turn end. Leaving abandoned rows `pending` forever is the worse
    // failure, and it is the one that actually happens.
    staleMessageSweeper: staleMessageDeadlineMs
      ? {
          messages: new MessageStore(privilegedDb),
          logger: app.log,
          staleAfterMs: staleMessageDeadlineMs
        }
      : null
  });

  return app;
}
