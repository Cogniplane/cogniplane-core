import type { FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { closeRedis } from "./lib/redis.js";
import { buildAdminRouteStores, registerAdminRoutes } from "./routes/admin.js";
import { buildApprovalRouteStores, registerApprovalRoutes } from "./routes/approvals.js";
import { buildArtifactRouteStores, registerArtifactRoutes } from "./routes/artifacts.js";
import { buildHealthRouteStores, registerHealthRoutes } from "./routes/health.js";
import { buildModelRouteStores, registerModelRoutes } from "./routes/models.js";
import { buildMessageRouteStores, registerMessageRoutes } from "./routes/messages.js";
import {
  buildMessageFeedbackRouteStores,
  registerMessageFeedbackRoutes
} from "./routes/message-feedback-routes.js";
import { buildMcpRouteStores, registerMcpRoutes } from "./routes/mcp.js";
import { buildSessionRouteStores, registerSessionRoutes } from "./routes/sessions.js";
import { buildSettingsRouteStores, registerSettingsRoutes } from "./routes/settings.js";
import type { RuntimeAdapter } from "./runtime-contracts.js";
import type { AppDependencies } from "./app-dependencies.js";
import { buildApiKeyPresenceCheckers } from "./services/runtime/api-key-presence.js";
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
  const { hasProviderKey, configuredProviders } = buildApiKeyPresenceCheckers({
    credentials: deps.providerCredentials
  });
  await registerModelRoutes(
    app,
    buildModelRouteStores(deps, {
      configuredProviders
    })
  );
  await registerAdminRoutes(app, buildAdminRouteStores(deps, { config: app.config }));
  await registerSessionRoutes(app, buildSessionRouteStores(deps));
  await registerSettingsRoutes(app, buildSettingsRouteStores(deps, { config: app.config }));
  await registerArtifactRoutes(app, buildArtifactRouteStores(deps));
  await registerMessageRoutes(
    app,
    buildMessageRouteStores(deps, { hasProviderKey })
  );
  await registerMessageFeedbackRoutes(app, buildMessageFeedbackRouteStores(deps));
  await registerApprovalRoutes(app, buildApprovalRouteStores(deps));
  await registerMcpRoutes(
    app,
    buildMcpRouteStores(deps, {
      runtimeTokenSecret: app.config.DATA_ENCRYPTION_SECRET,
      egressCidrs: app.config.E2B_EGRESS_CIDRS,
      readRuntimeFile: async (sessionId, runtimeId, filePath) => {
        const runtime = resolveOwningFileAdapter(deps.runtimeAdapter, sessionId, runtimeId);
        if (!runtime?.readRuntimeFile) {
          throw new Error(`No active runtime for session ${sessionId}.`);
        }
        return runtime.readRuntimeFile(sessionId, filePath);
      },
      statRuntimeFile: async (sessionId, runtimeId, filePath) => {
        const runtime = resolveOwningFileAdapter(deps.runtimeAdapter, sessionId, runtimeId);
        if (!runtime?.statRuntimeFile) {
          throw new Error(`No active runtime for session ${sessionId}.`);
        }
        return runtime.statRuntimeFile(sessionId, filePath);
      },
      writeRuntimeFile: async (sessionId, runtimeId, filePath, data) => {
        const runtime = resolveOwningFileAdapter(deps.runtimeAdapter, sessionId, runtimeId);
        if (!runtime?.writeRuntimeFile) {
          throw new Error(`No active runtime for session ${sessionId}.`);
        }
        return runtime.writeRuntimeFile(sessionId, filePath, data);
      },
      // Policy Center require_approval routing. The gateway holds its HTTP
      // response open while this awaits the human decision; the owning adapter
      // emits the SSE prompt and the /approvals decision route settles it. When
      // no adapter owns the session (no active turn), an enforce-mode
      // require_approval degrades to a deny (see PolicyService.routeApproval).
      requestPolicyApproval: async (input) => {
        const runtime = resolveOwningFileAdapter(
          deps.runtimeAdapter,
          input.sessionId,
          input.runtimeId ?? undefined
        );
        if (!runtime?.requestPolicyApproval) return null;
        // input is a PolicyApprovalRouteInput — the adapter method takes the
        // same shape, so forward it as-is rather than re-listing every field.
        return runtime.requestPolicyApproval(input);
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
  policyService: AppDependencies["policyService"];
  runtimeAdapter: AppDependencies["runtimeAdapter"];
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
    policyService,
    runtimeAdapter,
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
    await runtimeAdapter.close();
    await policyService.close();
    await closeRedis();
    await app.db.end();
    if (privilegedDb && privilegedDb !== app.db) {
      await privilegedDb.end();
    }
  });
}

// Route managed tool file ops (write_artifact, read_text_artifact, …) only to
// a runtime that actually holds live in-memory state for this session, so a
// managed tool can't silently succeed against a stale workspace invisible to
// the active turn.
function resolveOwningFileAdapter(
  runtimeAdapter: RuntimeAdapter,
  sessionId: string,
  runtimeId?: string
): RuntimeAdapter | null {
  if (runtimeId && runtimeAdapter.hasRuntime(sessionId, runtimeId)) {
    return runtimeAdapter;
  }
  return runtimeAdapter.hasSession(sessionId) ? runtimeAdapter : null;
}
