import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";

import { registerAppLifecycle, registerAppRoutes } from "./app-bootstrap.js";
import {
  buildAppDependencies,
  buildSchedulerWorker,
  buildSessionJudgeWorker
} from "./app-dependencies.js";
import { loadConfig } from "./config.js";
import { localDevAuth } from "./lib/auth.js";
import { workosAuth } from "./lib/auth-workos.js";
import { isCorsOriginAllowed } from "./lib/cors.js";
import { createDatabase } from "./lib/db.js";
import { getRedis } from "./lib/redis.js";
import { sanitizeUrl } from "./lib/sanitize-url.js";
import { registerSecurityHeaders } from "./lib/security-headers.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTenantRoutes } from "./routes/tenant.js";
import { TenantMemberStore } from "./services/tenant-member-store.js";
import { TenantOrgSettingsStore } from "./services/tenant-org-settings-store.js";
import { Pool } from "pg";

export async function buildApp() {
  const config = loadConfig();
  const app = Fastify({
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

  await registerSecurityHeaders(app);

  await app.register(cors, {
    origin: (requestOrigin, cb) => cb(null, isCorsOriginAllowed(requestOrigin, config.API_ORIGIN)),
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
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

  const sessionJudgeWorker = buildSessionJudgeWorker(config, {
    sessionJudgments: deps.sessionJudgments,
    messages: deps.messages,
    dynamicConfig: deps.dynamicConfig,
    activations: deps.activationTracker,
    logger: app.log,
    getTenantAnthropicApiKey: deps.getTenantAnthropicApiKey,
    getTenantOpenaiApiKey: deps.getTenantOpenaiApiKey
  });

  await registerAppRoutes(app, deps, { sessionJudgeWorker: sessionJudgeWorker ?? undefined });

  const schedulerWorker = buildSchedulerWorker(config, {
    userSettings: deps.userSettings,
    sessions: deps.sessions,
    messages: deps.messages,
    toolContexts: deps.toolContexts,
    runtimeManager: deps.runtimeManager,
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
    sessionJudgeWorker
  });

  return app;
}
