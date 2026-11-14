import Fastify from "fastify";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";

import { registerAppLifecycle, registerAppRoutes } from "./app-bootstrap.js";
import { buildAppDependencies, buildSchedulerWorker } from "./app-dependencies.js";
import { SessionExecutionStore } from "./services/session-execution-store.js";
import { RuntimeSessionStore } from "./services/runtime/runtime-session-store.js";
import { type AppConfig, isLoginTypeEnabled, isMailEnabled, loadConfig } from "./config.js";
import { localDevAuth } from "./lib/auth.js";
import { jwtAuth } from "./lib/auth-jwt.js";
import { buildLocalAuth } from "./services/auth/local-auth.js";
import { stopActiveWork } from "./services/auth/security-change.js";
import { buildMailWorker } from "./services/mail/build-mail.js";
import { MailOutbox } from "./services/mail/mail-outbox.js";
import { DataRouteControl } from "./services/data-route-control.js";
import { createRefreshTokenRotationService } from "./routes/auth-session.js";
import { CORS_ALLOWED_METHODS, isCorsOriginAllowed } from "./lib/cors.js";
import { createDatabase, createMaintenanceDatabase } from "./lib/db.js";
import { assertApplicationRole, assertMaintenanceRole } from "./lib/maintenance-db.js";
import { getRedis } from "./lib/redis.js";
import { sanitizeUrl } from "./lib/sanitize-url.js";
import { registerSecurityHeaders } from "./lib/security-headers.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTenantRoutes } from "./routes/tenant.js";
import { PrivilegedAuthStateLookup } from "./services/tenant-member-store.js";
import { ApprovalStore } from "./services/auth/approval-store.js";
import { MessageStore } from "./services/message-store.js";
import { RequestLimitsUnavailableError } from "./services/redis-request-limits.js";
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
  if (error instanceof RequestLimitsUnavailableError) {
    reply.header("Retry-After", "5").code(503).send({
      error: "request_limits_unavailable",
      message: error.message
    });
    return;
  }
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 400 && statusCode < 500) {
    // This branch passes through 4xx messages. Review their source and
    // classification; status alone does not prove that the text is safe.
    reply.code(statusCode).send({
      error: error.code ?? "bad_request",
      message: error.message
    });
    return;
  }
  request.log.error({ err: error }, "unhandled request error");
  reply.code(statusCode >= 500 ? statusCode : 500).send({
    error: "internal_error",
    message: "An unexpected error occurred."
  });
}

/**
 * Returns the value for Fastify's `trustProxy` option. Fastify uses it to set
 * `request.ip` for general request handling and logging only. It does not
 * affect `/mcp` admission. The gateway reads the raw socket peer
 * (`request.raw.socket.remoteAddress`) and ignores every forwarded header. See
 * the TRUST_PROXY docs in config.ts for the value semantics.
 */
export function parseTrustProxy(raw: string): boolean | string {
  const value = raw.trim();
  if (value === "" || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  if (/^\d+$/.test(value)) {
    // This function refuses numeric hop counts on purpose. Fastify 5.12.1 removed
    // hop-count trust (GHSA-3m5p-2c4r-xxw2) and fails closed on it at runtime. A
    // hop count never checks who the immediate peer is, so a direct client can
    // spoof X-Forwarded-For by sending enough hops. A hop-comparing
    // TrustProxyFunction would bring back the same flaw. An IP/CIDR allowlist of
    // the real proxies (for example, the ALB subnets) validates the peer instead.
    throw new Error(
      `TRUST_PROXY="${value}": numeric hop counts are no longer supported. ` +
        "Fastify removed them as spoofable (GHSA-3m5p-2c4r-xxw2). Set TRUST_PROXY to a " +
        "comma-separated IP/CIDR list of your trusted proxies (e.g. the load balancer's " +
        "subnets), or \"true\" only if every path to this server is already trusted."
    );
  }
  return value;
}

/**
 * Logs warnings about TRUST_PROXY values that can make the per-IP sign-in
 * limits count the wrong address. It never changes what is trusted.
 *
 * - At boot in jwt mode, `false` and `true` log a warning. The server cannot
 *   tell at boot whether a proxy is in front of it, so it warns at each boot.
 *   With `false` behind a proxy, every client has the proxy's address and
 *   shares its sign-in limit. With `true`, a client that connects directly
 *   sets its own address in X-Forwarded-For.
 * - With `false`, in every mode, the first request that has X-Forwarded-For
 *   logs a warning once per process.
 */
export function registerTrustProxyWarnings(
  app: FastifyInstance,
  config: Pick<AppConfig, "AUTH_MODE" | "TRUST_PROXY">
): void {
  const trust = parseTrustProxy(config.TRUST_PROXY);
  if (config.AUTH_MODE === "jwt" && trust === false) {
    app.log.warn(
      "TRUST_PROXY is false, so request.ip is the TCP peer address. Behind a proxy or load balancer, all clients " +
        "share the per-IP sign-in limits of the proxy address. Set TRUST_PROXY to the IP/CIDR list of the proxies."
    );
  }
  if (config.AUTH_MODE === "jwt" && trust === true) {
    app.log.warn(
      "TRUST_PROXY is true, so X-Forwarded-For is trusted from every peer. A client that connects directly can set " +
        "the address of its per-IP sign-in limits. Set TRUST_PROXY to the IP/CIDR list of the proxies."
    );
  }
  if (trust === false) {
    let warned = false;
    app.addHook("onRequest", async (request) => {
      if (!warned && request.headers["x-forwarded-for"]) {
        warned = true;
        request.log.warn("Forwarded client IP ignored. Configure TRUST_PROXY with the proxy IP/CIDR so auth rate limits use client IPs.");
      }
    });
  }
}

function requireRedis(app: FastifyInstance) {
  if (!app.redis) throw new Error("Redis is required for local login.");
  return app.redis;
}

export async function buildApp() {
  const config = loadConfig();
  // All instances run cross-tenant recovery and token lookup, even when the
  // scheduler and retention flags are off. Never fall back to the app pool.
  if (!config.MAINTENANCE_DATABASE_URL) {
    throw new Error("MAINTENANCE_DATABASE_URL is required for runtime maintenance.");
  }
  const app = Fastify({
    // Sets `request.ip` from X-Forwarded-For, per the proxy topology, so logs and
    // rate limits see the client and not the load balancer. This does not affect
    // /mcp admission, which checks the raw socket peer for loopback.
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    // Defense-in-depth HTTP-layer cap on JSON/raw request bodies. Field-level
    // schemas (e.g. MessagePostRequestSchema.text) enforce tighter per-field
    // limits, but those only run *after* the whole body is buffered, so a global
    // cap is what actually bounds memory for an oversized POST. File uploads use
    // the multipart plugin's own `fileSize` limit and are unaffected by this.
    bodyLimit: config.MAX_REQUEST_BODY_BYTES,
    logger: {
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
  registerTrustProxyWarnings(app, config);
  // Unmatched routes return the app's standard `{ error }` envelope rather than
  // Fastify's default `{ statusCode, error, message }` body, so clients parse a
  // single 404 contract whether the route is missing or the request was rejected.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "not_found" });
  });

  app.decorate("config", config);
  app.decorate("db", createDatabase(config, app.log));

  const privilegedDb = createMaintenanceDatabase(config.MAINTENANCE_DATABASE_URL, app.log);
  try {
    await assertApplicationRole(app.db);
    await assertMaintenanceRole(privilegedDb);
  } catch (error) {
    await Promise.all([privilegedDb.end(), app.db.end()]);
    throw error;
  }

  app.decorate("redis", getRedis(config, app.log));

  await registerSecurityHeaders(app);

  await app.register(cors, {
    origin: (requestOrigin, cb) => cb(null, isCorsOriginAllowed(requestOrigin, config.API_ORIGIN)),
    credentials: true,
    methods: CORS_ALLOWED_METHODS,
    allowedHeaders: ["Content-Type", "Authorization", "X-User-Id", "X-Tenant-Id", "X-Dev-Auth-Key", "X-Step-Up"]
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

  // With PDF OCR on, a missing tool or language stops the boot: PDF scans
  // would otherwise all fail, and block mode would reject every PDF.
  await deps.pdfOcr?.verify();

  // Subscribe to cross-replica policy cache invalidations before serving
  // traffic. Failure is logged inside start(); the rule-cache TTL is the
  // fallback, so boot proceeds either way.
  await deps.policyService.start();

  // After the commit of a security change (a new security version of a local
  // account, or a member removal): stop the account's runtimes in this
  // process, and kill the sandboxes that the change took from the account's
  // chats. The tool-context check refuses their tool calls on every replica.
  const afterSecurityChange = stopActiveWork({ runtimes: deps.runtimeAdapter, logger: app.log });

  // Local login: password sign-in, one-time links, step-up, manager actions.
  // Lookups before the tenant is known use the privileged pool; everything
  // else uses the app_user pool under RLS.
  const localAuth =
    config.AUTH_MODE === "jwt" && isLoginTypeEnabled(config, "local")
      ? buildLocalAuth({
          config,
          db: app.db,
          lookupDb: privilegedDb,
          redis: requireRedis(app),
          refreshTokens: createRefreshTokenRotationService(app),
          afterSecurityChange
        })
      : undefined;

  // Data routes (tenant settings that change where data goes): step-up for
  // local sessions, a notice to every owner when email is on, and the admin
  // rate limit. Startup warns when WorkOS login is on and email is off.
  const dataRoutes = new DataRouteControl({
    authMode: config.AUTH_MODE,
    loginTypes: config.AUTH_LOGIN_TYPES,
    localAuth,
    ownerNotices: isMailEnabled(config) ? new MailOutbox({ secret: config.DATA_ENCRYPTION_SECRET }) : null,
    limits: deps.limits,
    logger: app.log
  });

  // Exhaustive on purpose: only dev-headers may trust identity headers, so a
  // new mode must not fall into that branch by default.
  // onRequest, not preHandler: authentication only reads headers/url, so
  // gating here rejects unauthenticated callers before body parsing/validation.
  switch (config.AUTH_MODE) {
    case "jwt": {
      // The membership lookup runs before the tenant context exists, so it
      // reads through `privilegedDb` (BYPASSRLS, checked at startup above).
      // Its SQL keeps the tenant and user predicates. One statement per
      // request, outside a transaction: see PrivilegedAuthStateLookup.
      const authStates = new PrivilegedAuthStateLookup(privilegedDb);
      app.addHook("onRequest", jwtAuth(config, authStates, deps.integrationDescriptors.oauthCallbackPaths()));
      break;
    }
    case "dev-headers":
      app.addHook("onRequest", localDevAuth(config, deps.integrationDescriptors.oauthCallbackPaths()));
      break;
    default: {
      const unknownMode: never = config.AUTH_MODE;
      throw new Error(`Unknown AUTH_MODE: ${String(unknownMode)}`);
    }
  }
  await registerTenantRoutes(app, {
    db: app.db,
    tenantOrgSettings: deps.tenantOrgSettings,
    githubConnections: deps.githubConnectionService,
    afterSecurityChange,
    integrationDescriptors: deps.integrationDescriptors,
    piiImportScopes: deps.piiImportScopes,
    localAuth,
    dataRoutes
  });

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
    db: config.AUTH_MODE === "jwt" ? privilegedDb : app.db,
    appDb: app.db,
    localAuth,
    config,
    auditEvents: deps.auditEvents,
    limits: deps.limits,
    integrationDescriptors: deps.integrationDescriptors
  });

  await registerAppRoutes(app, deps, { dataRoutes });

  const schedulerWorker = buildSchedulerWorker(config, {
    userSettings: deps.userSettings,
    sessions: deps.sessions,
    messages: deps.messages,
    toolContexts: deps.toolContexts,
    executions: deps.executions,
    limits: deps.limits,
    runtimeAdapter: deps.runtimeAdapter,
    dynamicConfig: deps.dynamicConfig,
    customModels: deps.customModels,
    providerCredentials: deps.providerCredentials,
    auditEvents: deps.auditEvents,
    piiProtection: deps.piiProtection,
    piiScanRuns: deps.piiScanRuns,
    piiScanJobs: deps.piiScanJobs,
    piiScanJobHandler: deps.piiScanJobHandler,
    projectFiles: deps.projectFiles,
    projectFileStorage: deps.artifactStorage,
    sessionTrash: deps.sessions,
    scheduledSessions: deps.sessions,
    sessionStorage: deps.artifactStorage,
    logger: app.log
  });

  const staleMessageDeadlineMs = resolveStaleMessageDeadline(config);

  registerAppLifecycle({
    app,
    config,
    limits: deps.limits,
    policyService: deps.policyService,
    runtimeAdapter: deps.runtimeAdapter,
    activeTurns: deps.activeTurns,
    expiredExecutions: new SessionExecutionStore(privilegedDb),
    runtimeOwners: new RuntimeSessionStore(privilegedDb, deps.runtimeSessions.ownerId),
    messages: deps.messages,
    privilegedDb,
    schedulerWorker,
    // Cross-tenant mail queue: the maintenance pool sees every tenant's
    // outbox. Runs in jwt mode even when email is off, to clean up.
    mailWorker: buildMailWorker(config, privilegedDb, app.log),
    // Cross-tenant stale-approval recovery needs a BYPASSRLS pool; reuse the
    // privileged pool (asserted to bypass RLS above) so the sweep can see every
    // tenant's rows in one statement.
    staleApprovalSweeper: {
      approvals: new ApprovalStore(privilegedDb),
      auditEvents: deps.auditEvents,
      logger: app.log
    },
    // Assistant rows that a killed process left `pending` or `streaming` can
    // belong to any tenant, so the sweep uses the privileged pool. The sweep is
    // off when the turn watchdog is off (RUNTIME_TURN_TIMEOUT_MS=0). With no
    // ceiling, no deadline can tell an abandoned row from a live one.
    //
    // The deadline is a wall-clock ceiling. The watchdog pauses during approvals,
    // so the deadline budgets for a few approval rounds (APPROVAL_ROUND_BUDGET).
    // The approval loop has no fixed bound, so no finite deadline covers every
    // turn. The AG-UI writer refreshes `updated_at` on a timer, so a live approval
    // wait keeps its row fresh.
    //
    // A false positive heals itself, so a heavier mechanism is not worth it. The
    // live writer's terminal update overwrites the row with the true status at
    // turn end. A row left `pending` forever is the worse failure, and it happens
    // in practice.
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
