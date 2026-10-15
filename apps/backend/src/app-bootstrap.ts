import { registerProjectFileRoutes } from "./routes/project-files.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerProjectMemberRoutes } from "./routes/project-members.js";
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { runtimeTokenSecret } from "./lib/derived-secrets.js";
import { closeRedis } from "./lib/redis.js";
import { buildAdminRouteStores, registerAdminRoutes } from "./routes/admin.js";
import { buildApprovalRouteStores, registerApprovalRoutes } from "./routes/approvals.js";
import { buildArtifactRouteStores, registerArtifactRoutes } from "./routes/artifacts.js";
import { registerHealthRoutes } from "./routes/health.js";
import { buildModelRouteStores, registerModelRoutes } from "./routes/models.js";
import { buildMessageRouteStores, registerMessageRoutes } from "./routes/messages.js";
import {
  buildMessageFeedbackRouteStores,
  registerMessageFeedbackRoutes
} from "./routes/message-feedback-routes.js";
import { buildMcpRouteStores, registerMcpRoutes } from "./routes/mcp.js";
import { buildSessionRouteStores, registerSessionRoutes } from "./routes/sessions.js";
import { registerSessionCapabilityRoutes } from "./routes/session-capabilities.js";
import { registerProjectCapabilityRoutes } from "./routes/project-capabilities.js";
import { registerPersonalCapabilityRoutes } from "./routes/personal-capabilities.js";
import { registerMemberMcpRoutes } from "./routes/member-mcp.js";
import { registerMemoryRoutes } from "./routes/memories.js";
import { registerPersonalSkillRoutes } from "./routes/personal-skills.js";
import { registerOrganizationSkillSubmissionRoutes } from "./routes/organization-skill-submissions.js";
import { registerProjectSkillRoutes } from "./routes/project-skills.js";
import { buildSettingsRouteStores, registerSettingsRoutes } from "./routes/settings.js";
import { registerJiraConnectionRoutes } from "./services/integrations/pipedream/jira-connection-routes.js";
import type { RuntimeAdapter } from "./runtime-contracts.js";
import type { AppDependencies } from "./app-dependencies.js";
import type { SessionExecutionStore } from "./services/session-execution-store.js";
import { buildApiKeyPresenceCheckers } from "./services/runtime/api-key-presence.js";
import type { SchedulerWorker } from "./services/scheduler-worker.js";
import {
  sweepStaleApprovals,
  type StaleApprovalSweeperDeps
} from "./services/runtime/stale-approval-sweeper.js";
import {
  sweepStaleAssistantMessages,
  type StaleMessageSweeperDeps
} from "./services/runtime/stale-message-sweeper.js";

export async function registerAppRoutes(
  app: FastifyInstance,
  deps: AppDependencies
): Promise<void> {
  if (deps.turnBus) {
    await deps.turnBus.subscribeStop(signal => {
      if (signal.ownerId !== deps.executions.ownerId) return;
      void deps.executions.isStopped(signal).then(stopped => {
        if (!stopped || !deps.activeTurns.requestCancelExecution(signal.sessionId, signal.tenantId, signal.executionId)) return;
        return deps.runtimeAdapter.interruptTurn(signal);
      }).catch(err => {
        app.log.warn({ err, sessionId: signal.sessionId }, "Failed to process remote Stop");
      });
    });
    app.addHook("onClose", () => deps.turnBus!.close());
  }
  await registerHealthRoutes(app);
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
  await registerSessionCapabilityRoutes(app, deps);
  await registerProjectCapabilityRoutes(app, deps);
  await registerPersonalCapabilityRoutes(app, deps);
  await registerPersonalSkillRoutes(app, deps);
  await registerOrganizationSkillSubmissionRoutes(app, deps);
  await registerProjectSkillRoutes(app, deps);
  await registerMemberMcpRoutes(app, deps);
  await registerMemoryRoutes(app, deps);
  await registerProjectRoutes(app, deps);
  await registerProjectMemberRoutes(app, deps.projectMembers);
  await registerProjectFileRoutes(app, deps);
  await registerSettingsRoutes(app, buildSettingsRouteStores(deps, { config: app.config }));
  await registerJiraConnectionRoutes(app, {
    jiraConnections: deps.jiraConnectionService,
    integrationStates: deps.integrationStates,
    config: app.config
  });
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
      runtimeTokenSecret: runtimeTokenSecret(app.config.DATA_ENCRYPTION_SECRET),
      artifactMaxBytes: app.config.ARTIFACT_MAX_UPLOAD_BYTES,
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
  activeTurns?: AppDependencies["activeTurns"];
  messages?: Pick<AppDependencies["messages"], "markInterruptedIfActive">;
  /** Shorter drain wait for lifecycle tests. */
  turnDrainWaitMs?: number;
  // Wait for aborted scheduled jobs to write their outcome before the pools close.
  schedulerDrainWaitMs?: number;
  privilegedDb?: { end: () => Promise<void> } | null;
  schedulerWorker: SchedulerWorker | null;
  /**
   * Cross-tenant stale-approval recovery. Backed by the privileged store so the
   * sweep spans all tenants. Optional only so tests can omit it; production
   * always wires it.
   */
  staleApprovalSweeper?: StaleApprovalSweeperDeps | null;
  /**
   * Cross-tenant recovery for assistant rows a killed process left streaming.
   * Backed by the privileged store for the same reason. Optional only so tests
   * can omit it; production always wires it.
   */
  staleMessageSweeper?: StaleMessageSweeperDeps | null;
  expiredExecutions?: Pick<SessionExecutionStore, "sweepExpired">;
}) {
  const {
    app,
    config,
    limits,
    policyService,
    runtimeAdapter,
    activeTurns,
    messages,
    turnDrainWaitMs = 5_000,
    schedulerDrainWaitMs = 15_000,
    privilegedDb,
    schedulerWorker,
    staleApprovalSweeper,
    staleMessageSweeper,
    expiredExecutions
  } = input;

  schedulerWorker?.start(config.SCHEDULER_POLL_INTERVAL_MS);

  const sweepInterval = setInterval(() => limits.sweepExpired(), 60_000);
  sweepInterval.unref();
  const sweepExecutions = () => {
    void expiredExecutions?.sweepExpired().catch(err => app.log.error({ err }, "Expired execution sweep failed"));
  };
  sweepExecutions();
  const executionSweepInterval = setInterval(sweepExecutions, config.SESSION_EXECUTION_HEARTBEAT_MS);
  executionSweepInterval.unref();

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

  // Same shape for assistant rows a prior process left mid-turn: recover the
  // crash backlog at boot, then keep sweeping so a kill during THIS process's
  // lifetime is picked up by the next instance (or by this one, if the row was
  // orphaned by a worker that died without taking the process with it).
  let messageSweepInterval: ReturnType<typeof setInterval> | null = null;
  if (staleMessageSweeper) {
    void sweepStaleAssistantMessages(staleMessageSweeper).catch((err) => {
      app.log.error({ err }, "Startup stale-message sweep failed");
    });
    messageSweepInterval = setInterval(() => {
      void sweepStaleAssistantMessages(staleMessageSweeper).catch((err) => {
        app.log.error({ err }, "Periodic stale-message sweep failed");
      });
    }, staleMessageSweeper.staleAfterMs);
    messageSweepInterval.unref();
  }

  app.addHook("preClose", async () => {
    activeTurns?.beginDrain();
    schedulerWorker?.stop();
    clearInterval(sweepInterval);
    clearInterval(executionSweepInterval);
    if (approvalSweepInterval) clearInterval(approvalSweepInterval);
    if (messageSweepInterval) clearInterval(messageSweepInterval);
    const waitForTurns = async (budgetMs: number) => {
      const deadline = Date.now() + budgetMs;
      while (activeTurns?.snapshot().size && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    };
    await waitForTurns(turnDrainWaitMs);
    const running = activeTurns?.runningOwners() ?? [];
    if (running.length) {
      for (const owner of running) activeTurns?.requestCancel(owner.sessionId, owner.tenantId);
      await Promise.all(running.map((owner) => runtimeAdapter.interruptTurn(owner).catch((err) => {
        app.log.warn({ err, sessionId: owner.sessionId }, "Failed to interrupt turn during shutdown");
      })));
      await waitForTurns(turnDrainWaitMs);
    }
    for (const owner of activeTurns?.runningOwners() ?? []) {
      const turn = activeTurns?.identity(owner.sessionId);
      if (!turn) continue;
      await messages?.markInterruptedIfActive(owner.tenantId, turn.messageId, owner.userId).catch((err) => {
        app.log.error({ err, sessionId: owner.sessionId }, "Failed to mark draining turn interrupted");
      });
    }
    // Scheduled turns are not in activeTurns. Let them finish within the same
    // budget, then abort the rest with the runtimes and wait again, so their
    // outcome writes finish before onClose closes the database pools.
    if (schedulerWorker && !(await schedulerWorker.drain(turnDrainWaitMs))) {
      app.log.warn("Scheduled jobs still running at shutdown; aborting them with the runtimes");
    }
    schedulerWorker?.refuseNewTurns();
    await runtimeAdapter.close();
    // An aborted job still flushes usage (up to USAGE_FLUSH_DEADLINE_MS) and then
    // writes its transcript and outcome, so this wait has its own, longer budget.
    if (schedulerWorker && !(await schedulerWorker.drain(schedulerDrainWaitMs))) {
      app.log.error("Scheduled jobs did not settle after their runtimes closed; the next start marks their runs orphaned");
    }
  });

  app.addHook("onClose", async () => {
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
