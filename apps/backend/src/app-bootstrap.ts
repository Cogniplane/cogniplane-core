import type { FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { closeRedis } from "./lib/redis.js";
import { buildAdminRouteStores, registerAdminRoutes } from "./routes/admin.js";
import { buildApprovalRouteStores, registerApprovalRoutes } from "./routes/approvals.js";
import { buildArtifactRouteStores, registerArtifactRoutes } from "./routes/artifacts.js";
import { buildHealthRouteStores, registerHealthRoutes } from "./routes/health.js";
import { createAnthropicCapabilitiesCache } from "./routes/models-anthropic-cache.js";
import { buildModelRouteStores, registerModelRoutes } from "./routes/models.js";
import { buildMessageRouteStores, registerMessageRoutes } from "./routes/messages.js";
import {
  buildMessageFeedbackRouteStores,
  registerMessageFeedbackRoutes
} from "./routes/message-feedback-routes.js";
import {
  buildLlmAnthropicRouteStores,
  registerLlmAnthropicRoutes
} from "./routes/llm-anthropic.js";
import {
  buildLlmOpenaiRouteStores,
  registerLlmOpenaiRoutes
} from "./routes/llm-openai.js";
import { buildMcpRouteStores, registerMcpRoutes } from "./routes/mcp.js";
import { buildSessionRouteStores, registerSessionRoutes } from "./routes/sessions.js";
import { buildSettingsRouteStores, registerSettingsRoutes } from "./routes/settings.js";
import type { RuntimeAdapter } from "./runtime-contracts.js";
import type { AppDependencies } from "./app-dependencies.js";
import type { SchedulerWorker } from "./services/scheduler-worker.js";
import {
  sweepStaleApprovals,
  type StaleApprovalSweeperDeps
} from "./services/runtime/stale-approval-sweeper.js";

export async function registerAppRoutes(
  app: FastifyInstance,
  deps: AppDependencies
): Promise<void> {
  await registerHealthRoutes(app, buildHealthRouteStores(deps));
  const hasAnthropicApiKey = async (tenantId: string): Promise<boolean> => {
    if (app.config.ANTHROPIC_API_KEY) return true;
    const tenantKey = await deps.getTenantAnthropicApiKey(tenantId);
    return Boolean(tenantKey?.trim());
  };
  const hasOpenaiApiKey = async (tenantId: string): Promise<boolean> => {
    if (app.config.OPENAI_API_KEY) return true;
    const tenantKey = await deps.getTenantOpenaiApiKey(tenantId);
    return Boolean(tenantKey?.trim());
  };
  const anthropicCapabilitiesCache = createAnthropicCapabilitiesCache({
    successTtlMs: app.config.MODEL_LIST_CACHE_TTL_MS,
    negativeTtlMs: app.config.MODEL_LIST_CACHE_NEGATIVE_TTL_MS
  });
  await registerModelRoutes(
    app,
    buildModelRouteStores(deps, {
      hasAnthropicApiKey,
      hasOpenaiApiKey,
      getAnthropicApiKey: async (tenantId: string) =>
        app.config.ANTHROPIC_API_KEY ?? (await deps.getTenantAnthropicApiKey(tenantId)),
      anthropicCapabilitiesCache
    })
  );
  await registerAdminRoutes(app, buildAdminRouteStores(deps, { config: app.config }));
  await registerSessionRoutes(app, buildSessionRouteStores(deps));
  await registerSettingsRoutes(app, buildSettingsRouteStores(deps, { config: app.config }));
  await registerArtifactRoutes(app, buildArtifactRouteStores(deps));
  await registerMessageRoutes(
    app,
    buildMessageRouteStores(deps, { hasAnthropicApiKey, hasOpenaiApiKey })
  );
  await registerMessageFeedbackRoutes(app, buildMessageFeedbackRouteStores(deps));
  await registerApprovalRoutes(app, buildApprovalRouteStores(deps));
  await registerLlmAnthropicRoutes(
    app,
    buildLlmAnthropicRouteStores({
      upstreamBaseUrl: app.config.ANTHROPIC_UPSTREAM_BASE_URL,
      runtimeTokenSecret: app.config.DATA_ENCRYPTION_SECRET,
      platformAnthropicApiKey: app.config.ANTHROPIC_API_KEY ?? null,
      egressCidrs: app.config.E2B_EGRESS_CIDRS,
      egressIpPins: deps.egressIpPins,
      getTenantAnthropicApiKey: deps.getTenantAnthropicApiKey,
      auditEvents: deps.auditEvents,
      messages: deps.messages,
      activeTurnMessageMap: deps.activeTurnMessageMap
    })
  );
  await registerLlmOpenaiRoutes(
    app,
    buildLlmOpenaiRouteStores({
      upstreamBaseUrl: app.config.OPENAI_UPSTREAM_BASE_URL,
      runtimeTokenSecret: app.config.DATA_ENCRYPTION_SECRET,
      platformOpenaiApiKey: app.config.OPENAI_API_KEY ?? null,
      egressCidrs: app.config.E2B_EGRESS_CIDRS,
      egressIpPins: deps.egressIpPins,
      getTenantOpenaiApiKey: deps.getTenantOpenaiApiKey,
      auditEvents: deps.auditEvents,
      messages: deps.messages,
      activeTurnMessageMap: deps.activeTurnMessageMap
    })
  );
  await registerMcpRoutes(
    app,
    buildMcpRouteStores(deps, {
      runtimeTokenSecret: app.config.DATA_ENCRYPTION_SECRET,
      readRuntimeFile: async (sessionId, runtimeId, filePath) => {
        const runtime = resolveOwningFileAdapter(deps.runtimeManager, deps.runtimeAdapters, sessionId, runtimeId);
        if (!runtime?.readRuntimeFile) {
          throw new Error(`No active runtime for session ${sessionId}.`);
        }
        return runtime.readRuntimeFile(sessionId, filePath);
      },
      writeRuntimeFile: async (sessionId, runtimeId, filePath, data) => {
        const runtime = resolveOwningFileAdapter(deps.runtimeManager, deps.runtimeAdapters, sessionId, runtimeId);
        if (!runtime?.writeRuntimeFile) {
          throw new Error(`No active runtime for session ${sessionId}.`);
        }
        return runtime.writeRuntimeFile(sessionId, filePath, data);
      }
    })
  );

  // Optional overlays attach their routes last. The core OSS tree ships this
  // as a no-op so derived distributions can add routes without changing core.
  deps.overlays.attachRoutes(app);
}

export function registerAppLifecycle(input: {
  app: FastifyInstance;
  config: AppConfig;
  limits: AppDependencies["limits"];
  runtimeManager: AppDependencies["runtimeManager"];
  runtimeAdapters: AppDependencies["runtimeAdapters"];
  privilegedDb?: { end: () => Promise<void> } | null;
  schedulerWorker: SchedulerWorker | null;
  /**
   * Cross-tenant stale-approval recovery. Backed by the privileged store so the
   * sweep spans all tenants. Optional only so tests can omit it; production
   * always wires it.
   */
  staleApprovalSweeper?: StaleApprovalSweeperDeps | null;
}) {
  const {
    app,
    config,
    limits,
    runtimeManager,
    runtimeAdapters,
    privilegedDb,
    schedulerWorker,
    staleApprovalSweeper
  } = input;

  schedulerWorker?.start(config.SCHEDULER_POLL_INTERVAL_MS);

  const sweepInterval = setInterval(() => limits.sweepExpired(), 60_000);
  sweepInterval.unref();

  // Recover approvals orphaned by a prior crash/restart immediately at boot,
  // then keep sweeping for ones whose in-process TTL timer dies mid-run. The
  // startup sweep is fire-and-forget so a slow DB can't delay readiness.
  let approvalSweepInterval: ReturnType<typeof setInterval> | null = null;
  if (staleApprovalSweeper) {
    void sweepStaleApprovals(staleApprovalSweeper).catch((err) => {
      app.log.error({ err }, "Startup stale-approval sweep failed");
    });
    approvalSweepInterval = setInterval(() => {
      void sweepStaleApprovals(staleApprovalSweeper).catch((err) => {
        app.log.error({ err }, "Periodic stale-approval sweep failed");
      });
    }, config.APPROVAL_REQUEST_TTL_MS);
    approvalSweepInterval.unref();
  }

  app.addHook("onClose", async () => {
    schedulerWorker?.stop();
    clearInterval(sweepInterval);
    if (approvalSweepInterval) clearInterval(approvalSweepInterval);
    const closedRuntimes = new Set<RuntimeAdapter>();
    for (const adapter of Object.values(runtimeAdapters)) {
      if (adapter) closedRuntimes.add(adapter);
    }
    closedRuntimes.add(runtimeManager);
    for (const adapter of closedRuntimes) {
      await adapter.close?.();
    }
    await closeRedis();
    await app.db.end();
    if (privilegedDb && privilegedDb !== app.db) {
      await privilegedDb.end();
    }
  });
}

// Route managed tool file ops (write_artifact, read_text_artifact, …) to the
// adapter that actually holds live in-memory state for this session. A naive
// "try each adapter in order" loop can silently hit a stale workspace when a
// tenant's `runtimeProvider` has been switched mid-session and both adapters
// transiently hold a session under the same `sessionId` — the managed tool
// would succeed against the wrong workspace and the file would be invisible
// to the active turn.
function resolveOwningFileAdapter(
  runtimeManager: AppDependencies["runtimeManager"],
  runtimeAdapters: AppDependencies["runtimeAdapters"],
  sessionId: string,
  runtimeId?: string
): RuntimeAdapter | null {
  if (runtimeId) {
    for (const adapter of Object.values(runtimeAdapters)) {
      if (adapter?.hasRuntime?.(sessionId, runtimeId)) {
        return adapter;
      }
    }
    if (runtimeManager.hasRuntime?.(sessionId, runtimeId)) {
      return runtimeManager;
    }
  }

  for (const adapter of Object.values(runtimeAdapters)) {
    if (adapter?.hasSession?.(sessionId)) {
      return adapter;
    }
  }
  if (runtimeManager.hasSession?.(sessionId)) {
    return runtimeManager;
  }
  return null;
}
