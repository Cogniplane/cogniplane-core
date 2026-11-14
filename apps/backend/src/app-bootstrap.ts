import { registerProjectFileRoutes } from "./routes/project-files.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerProjectMemberRoutes } from "./routes/project-members.js";
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { runtimeTokenSecret } from "./lib/derived-secrets.js";
import { closeRedis } from "./lib/redis.js";
import { buildAdminRouteStores, registerAdminRoutes } from "./routes/admin.js";
import type { DataRouteControl } from "./services/data-route-control.js";
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
import type { RuntimeAdapter } from "./runtime-contracts.js";
import type { AppDependencies } from "./app-dependencies.js";
import type { SessionExecutionStore } from "./services/session-execution-store.js";
import { RUNTIME_OWNER_HEARTBEAT_MS, type RuntimeSessionStore } from "./services/runtime/runtime-session-store.js";
import type { StopSignal } from "./services/turn-coordination-bus.js";
import { buildApiKeyPresenceCheckers } from "./services/runtime/api-key-presence.js";
import type { SchedulerWorker } from "./services/scheduler-worker.js";
import type { MailOutboxWorker } from "./services/mail/mail-outbox-worker.js";
import {
  sweepStaleApprovals,
  type StaleApprovalSweeperDeps
} from "./services/runtime/stale-approval-sweeper.js";
import {
  sweepStaleAssistantMessages,
  type StaleMessageSweeperDeps
} from "./services/runtime/stale-message-sweeper.js";

// How often expired in-memory rate-limit windows are removed.
const RATE_LIMIT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Interrupts the local turn of an execution that the stop route fenced on
 * another replica. A scheduled turn has no request slot, only a turn in the
 * runtime. The interrupt names the stopped execution, so it cannot stop a newer
 * turn of the session.
 */
export async function stopRemoteExecution(
  deps: {
    executions: Pick<SessionExecutionStore, "ownerId" | "isStopped">;
    activeTurns: Pick<AppDependencies["activeTurns"], "requestCancelExecution">;
    runtimeAdapter: Pick<RuntimeAdapter, "hasActiveTurn" | "interruptTurn">;
  },
  signal: StopSignal
): Promise<void> {
  if (signal.ownerId !== deps.executions.ownerId) return;
  if (!await deps.executions.isStopped(signal)) return;
  const cancelled = deps.activeTurns.requestCancelExecution(signal.sessionId, signal.tenantId, signal.executionId);
  if (!cancelled && !deps.runtimeAdapter.hasActiveTurn(signal.sessionId)) return;
  await deps.runtimeAdapter.interruptTurn({
    tenantId: signal.tenantId, sessionId: signal.sessionId, userId: signal.userId, executionId: signal.executionId
  });
}

export async function registerAppRoutes(
  app: FastifyInstance,
  deps: AppDependencies,
  routeControls: { dataRoutes: DataRouteControl }
): Promise<void> {
  if (deps.turnBus) {
    await deps.turnBus.subscribeStop(signal => {
      void stopRemoteExecution(deps, signal).catch(err => {
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
  await registerAdminRoutes(app, buildAdminRouteStores(deps, { config: app.config, dataRoutes: routeControls.dataRoutes }));
  await registerSessionRoutes(app, buildSessionRouteStores(deps));
  await registerSessionCapabilityRoutes(app, deps);
  await registerProjectCapabilityRoutes(app, deps);
  await registerPersonalCapabilityRoutes(app, deps);
  await registerPersonalSkillRoutes(app, deps);
  await registerOrganizationSkillSubmissionRoutes(app, {
    organizationSkillSubmissions: deps.organizationSkillSubmissions,
    dataRoutes: routeControls.dataRoutes
  });
  await registerProjectSkillRoutes(app, { projectSkills: deps.projectSkills, dataRoutes: routeControls.dataRoutes });
  await registerMemberMcpRoutes(app, deps);
  await registerMemoryRoutes(app, deps);
  await registerProjectRoutes(app, deps);
  await registerProjectMemberRoutes(app, deps.projectMembers);
  await registerProjectFileRoutes(app, deps);
  await registerSettingsRoutes(app, buildSettingsRouteStores(deps, { config: app.config }));
  // Built-in connector routes (GitHub, Notion, Jira member routes). Their
  // OAuth callbacks register earlier, from the integration registry.
  await deps.builtinConnectors.attachRoutes(app);
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

  // Overlays attach their routes last (the bundled SharePoint overlay through
  // overlays.ts), so they can add routes without changing core.
  deps.overlays.attachRoutes(app, { dataRoutes: routeControls.dataRoutes });
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
  /** Sends and cleans email_outbox; null in dev-headers mode. */
  mailWorker?: MailOutboxWorker | null;
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
  /**
   * Cross-tenant lease recovery on the privileged pool: expired leases, and
   * replies left active in a session with no work.
   */
  expiredExecutions?: Pick<SessionExecutionStore, "sweepExpired" | "sweepOrphanedReplies">;
  /**
   * Runtime rows on the privileged pool, with the owner id of this process:
   * renews this process's stamp and terminates the rows of a gone process.
   */
  runtimeOwners?: Pick<RuntimeSessionStore, "heartbeatOwner" | "sweepOrphaned"> | null;
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
    mailWorker,
    staleApprovalSweeper,
    staleMessageSweeper,
    expiredExecutions,
    runtimeOwners
  } = input;

  schedulerWorker?.start(config.SCHEDULER_POLL_INTERVAL_MS);
  mailWorker?.start();

  const sweepInterval = setInterval(() => limits.sweepExpired(), RATE_LIMIT_SWEEP_INTERVAL_MS);
  sweepInterval.unref();
  const sweepExecutions = () => {
    if (!expiredExecutions) return;
    // Then a reply of a turn that ended without closing it, also with the turn watchdog off.
    void expiredExecutions.sweepExpired()
      .then(() => expiredExecutions.sweepOrphanedReplies(config.SESSION_EXECUTION_LEASE_MS))
      .catch(err => app.log.error({ err }, "Expired execution sweep failed"));
  };
  sweepExecutions();
  const executionSweepInterval = setInterval(sweepExecutions, config.SESSION_EXECUTION_HEARTBEAT_MS);
  executionSweepInterval.unref();
  const sweepRuntimeOwners = () => {
    if (!runtimeOwners) return;
    void runtimeOwners.heartbeatOwner()
      .then(() => runtimeOwners.sweepOrphaned())
      .catch(err => app.log.error({ err }, "Runtime owner sweep failed"));
  };
  sweepRuntimeOwners();
  const runtimeOwnerInterval = setInterval(sweepRuntimeOwners, RUNTIME_OWNER_HEARTBEAT_MS);
  runtimeOwnerInterval.unref();

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
    mailWorker?.stop();
    clearInterval(sweepInterval);
    clearInterval(executionSweepInterval);
    clearInterval(runtimeOwnerInterval);
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
    // A message still sending keeps its claim; the claim expires and another
    // process sends it again (at least once).
    if (mailWorker && !(await mailWorker.drain(turnDrainWaitMs))) {
      app.log.warn("Mail outbox pass still running at shutdown; its claims expire and are sent again later");
    }
    mailWorker?.close();
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
