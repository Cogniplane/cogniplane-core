import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import type {
  RuntimeAdapter,
  RuntimeApprovalDecision,
  RuntimeEvent,
  RuntimeReasoningEffort,
  RuntimeSessionRef,
  RuntimeUserInput
} from "../runtime-contracts.js";

import type { AppConfig } from "../config.js";
import { AsyncQueue } from "../lib/async-queue.js";
import { getErrorMessage } from "../lib/http-errors.js";
import { respondToApprovalRequest } from "./runtime/runtime-approval-coordinator.js";
import { cancelPendingApprovals } from "./runtime/approval-cleanup.js";
import { clearApprovalExpiry } from "./runtime/runtime-request-handler.js";
import type { DynamicConfigService } from "./dynamic-config-service.js";
import type { GithubConnectionService } from "./integrations/github/github-connection-service.js";
import type { IntegrationRegistryService } from "./integrations/integration-registry-service.js";
import type { ArtifactStorage } from "./artifacts/artifact-storage.js";
import type { ArtifactStore } from "./artifacts/artifact-store.js";
import type { ManagedToolCatalog } from "./managed-tools/catalog.js";
import type { SkillBundleStorage } from "./skills/skill-bundle-storage.js";
import type { ActivationTracker } from "./activation-tracker.js";
import type { RuntimeEgressIpPinStore } from "./runtime-egress-ip-pin.js";
import { CodexSkillDiscoveryService } from "./runtime/codex-skill-discovery-service.js";
import type { ResolvedRuntimePolicy } from "./admin-config-records.js";
import type { ApprovalStore } from "./auth/approval-store.js";
import type { AuditEventStore } from "./audit-event-store.js";
import type { RuntimeSessionStore } from "./runtime/runtime-session-store.js";
import type { ToolEventStore } from "./tool-event-store.js";
import type {
  RuntimeProcessFactory,
  RuntimeShutdownReason,
  RuntimeState,
  RuntimeWorkspaceFactory
} from "./runtime/runtime-types.js";
import { CodexSessionLifecycle } from "./runtime/codex-session-lifecycle.js";
import { CodexWorkspaceBootstrap } from "./runtime/codex-workspace-bootstrap.js";
import { CodexTurnOrchestrator } from "./runtime/codex-turn-orchestrator.js";

export type { RuntimeProcessFactory, RuntimeShutdownReason, RuntimeState, RuntimeWorkspaceFactory };

export type BoundRuntimeSessionRef = Omit<RuntimeSessionRef, "runtimePolicy"> & {
  runtimePolicy: ResolvedRuntimePolicy;
};

export class SessionBusyError extends Error {
  constructor(sessionId: string) {
    super(`A turn is already running for session ${sessionId}.`);
  }
}

// Resolve `filePath` against a posix sandbox workspace and reject anything
// that escapes the root — prevents path-traversal into host paths shared
// by the sandbox.
export function resolveInsideSandbox(workspacePath: string, filePath: string): string {
  const root = workspacePath.endsWith("/") ? workspacePath : workspacePath + "/";
  const resolved = path.posix.isAbsolute(filePath)
    ? path.posix.normalize(filePath)
    : path.posix.normalize(path.posix.join(workspacePath, filePath));
  if (!resolved.startsWith(root) && resolved !== workspacePath) {
    throw new Error("filePath must be inside the session workspace.");
  }
  return resolved;
}

export class CodexRuntimeManager implements RuntimeAdapter {
  readonly id = "codex-app-server";

  private readonly lifecycle: CodexSessionLifecycle;
  private readonly bootstrap: CodexWorkspaceBootstrap;
  private readonly turnOrchestrator: CodexTurnOrchestrator;

  constructor(
    private readonly deps: {
      config: AppConfig;
      dynamicConfig: DynamicConfigService;
      logger: FastifyBaseLogger;
      runtimeSessions: RuntimeSessionStore;
      approvals: ApprovalStore;
      auditEvents: AuditEventStore;
      toolEvents: ToolEventStore;
      artifacts: ArtifactStore;
      storage: ArtifactStorage;
      isBetaTester?: (tenantId: string, userId: string) => Promise<boolean>;
      getTenantApiKey?: (tenantId: string) => Promise<string | null>;
      githubConnections?: GithubConnectionService;
      integrationRegistry?: IntegrationRegistryService;
      processFactory?: RuntimeProcessFactory;
      workspaceFactory?: RuntimeWorkspaceFactory;
      skillDiscovery?: CodexSkillDiscoveryService;
      skillBundleStorage: SkillBundleStorage;
      managedToolCatalog: ManagedToolCatalog;
      activationTracker?: ActivationTracker;
      egressIpPins?: RuntimeEgressIpPinStore;
    }
  ) {
    this.lifecycle = new CodexSessionLifecycle(
      deps.config,
      deps.runtimeSessions,
      deps.logger,
      deps.egressIpPins
    );

    this.turnOrchestrator = new CodexTurnOrchestrator(
      {
        logger: deps.logger,
        approvals: deps.approvals,
        auditEvents: deps.auditEvents,
        toolEvents: deps.toolEvents,
        artifacts: deps.artifacts,
        storage: deps.storage,
        approvalTtlMs: deps.config.APPROVAL_REQUEST_TTL_MS
      },
      this.lifecycle,
      this.startRuntime.bind(this)
    );

    this.bootstrap = new CodexWorkspaceBootstrap(
      deps.config,
      {
        dynamicConfig: deps.dynamicConfig,
        logger: deps.logger,
        isBetaTester: deps.isBetaTester,
        getTenantApiKey: deps.getTenantApiKey,
        githubConnections: deps.githubConnections,
        integrationRegistry: deps.integrationRegistry,
        processFactory: deps.processFactory,
        workspaceFactory: deps.workspaceFactory,
        skillDiscovery: deps.skillDiscovery,
        skillBundleStorage: deps.skillBundleStorage,
        managedToolCatalog: deps.managedToolCatalog,
        activationTracker: deps.activationTracker
      },
      this.lifecycle,
      this.turnOrchestrator.bindProcessHandlers.bind(this.turnOrchestrator)
    );
  }

  // Orchestrates the bootstrap + process-handler binding as a single atomic
  // operation. Passed as a callback to both the lifecycle (ensureRuntime) and
  // the turn orchestrator (restart-and-retry path).
  private async startRuntime(
    tenantId: string,
    sessionId: string,
    userId: string
  ): Promise<RuntimeState> {
    return this.bootstrap.startRuntime(tenantId, sessionId, userId);
  }

  async getRuntimePolicyId(tenantId: string): Promise<string> {
    const profile = await this.deps.dynamicConfig.getRuntimePolicy(tenantId);
    return profile.id;
  }

  hasRuntime(sessionId: string, runtimeId: string): boolean {
    const runtime = this.lifecycle.runtimes.get(sessionId);
    return Boolean(runtime && runtime.runtimeId === runtimeId && !runtime.closed);
  }

  async createSession(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<BoundRuntimeSessionRef> {
    const runtime = await this.lifecycle.ensureRuntime(
      input.tenantId,
      input.sessionId,
      input.userId,
      this.startRuntime.bind(this)
    );
    return {
      sessionId: input.sessionId,
      runtimeId: runtime.runtimeId,
      runtimePolicy: runtime.runtimePolicy
    };
  }

  async *runMessage(
    session: RuntimeSessionRef,
    input: {
      prompt: string;
      userInputs?: RuntimeUserInput[];
      runtimePolicyId: string;
      toolContextId: string | null;
      assistantMessageId?: string | null;
      model?: string;
      effort?: RuntimeReasoningEffort;
      onBeforeTurn?: () => Promise<void>;
    }
  ): AsyncIterable<RuntimeEvent> {
    let runtime = this.lifecycle.runtimes.get(session.sessionId);
    if (!runtime || runtime.closed || !runtime.process.isAlive()) {
      if (runtime) {
        this.deps.logger.warn(
          { sessionId: session.sessionId, runtimeId: runtime.runtimeId },
          "Runtime process died — restarting before runMessage"
        );
        runtime = await this.lifecycle.ensureRuntime(
          runtime.tenantId,
          session.sessionId,
          runtime.userId,
          this.startRuntime.bind(this)
        );
      } else {
        throw new Error(`No active runtime exists for session ${session.sessionId}.`);
      }
    }

    if (runtime.activeTurn) {
      throw new SessionBusyError(session.sessionId);
    }

    if (input.onBeforeTurn) {
      await input.onBeforeTurn();
    }

    const queue = new AsyncQueue<RuntimeEvent>();
    runtime.activeTurn = {
      queue,
      responseId: null,
      outputItemDone: false,
      runtimePolicyId: input.runtimePolicyId,
      toolContextId: input.toolContextId,
      assistantMessageId: input.assistantMessageId ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      autoApprovedKinds: new Set()
    };

    this.turnOrchestrator
      .startTurn(runtime, input.prompt, input.userInputs)
      .catch((error) => {
        this.turnOrchestrator.failActiveTurn(runtime!, getErrorMessage(error, "Turn start failed"));
      });

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      const currentRuntime = this.lifecycle.runtimes.get(session.sessionId);
      if (currentRuntime?.activeTurn?.queue === queue) {
        currentRuntime.activeTurn = null;
      }
      if (runtime !== currentRuntime && runtime.activeTurn?.queue === queue) {
        runtime.activeTurn = null;
      }
    }
  }

  async resolveApproval(input: {
    tenantId: string;
    approvalId: string;
    userId: string;
    decision: RuntimeApprovalDecision;
    rememberForTurn?: boolean;
  }): Promise<"resolved" | "missing"> {
    const approval = await this.deps.approvals.resolve(
      input.tenantId,
      input.approvalId,
      input.userId,
      input.decision
    );
    if (!approval) return "missing";

    const runtime = this.lifecycle.runtimes.get(approval.sessionId);
    const pending = runtime?.pendingApprovals.get(input.approvalId);
    if (!runtime || !pending) return "missing";

    await this.deps.auditEvents.create({
      tenantId: input.tenantId,
      sessionId: approval.sessionId,
      userId: approval.userId,
      approvalId: approval.approvalId,
      type: input.decision === "approve" ? "approval.approved" : "approval.rejected",
      payload: { itemId: approval.itemId, kind: approval.kind }
    });

    if (input.rememberForTurn && input.decision === "approve" && runtime.activeTurn) {
      runtime.activeTurn.autoApprovedKinds.add(pending.kind);
    }

    runtime.pendingApprovals.delete(input.approvalId);
    clearApprovalExpiry(runtime, input.approvalId);
    respondToApprovalRequest(runtime.process, pending, input.decision);
    return "resolved";
  }

  async abortSession(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<void> {
    const runtime = this.lifecycle.runtimes.get(input.sessionId);
    if (!runtime) {
      await this.deps.runtimeSessions.setStatus(
        input.tenantId,
        input.sessionId,
        input.userId,
        "inactive"
      );
      return;
    }
    await this.lifecycle.requestRuntimeShutdown(runtime, "session_abort");
  }

  // Stop the current turn while keeping the runtime process alive. Sends Codex's
  // `turn/interrupt` JSON-RPC so the app-server cancels in-flight model calls
  // and tool dispatches, then synthesizes a terminal `response.completed` event
  // with `interrupted: true` so the SSE consumer + persistence layer get a
  // proper terminal frame. We do NOT wait for Codex's own `turn/completed`
  // notification before terminating the queue — at this point the runtime may
  // be stuck on a slow upstream and waiting could leave the user staring at a
  // disabled textbox.
  async interruptTurn(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<"interrupted" | "no_active_turn"> {
    const runtime = this.lifecycle.runtimes.get(input.sessionId);
    if (!runtime || !runtime.activeTurn) {
      return "no_active_turn";
    }
    // The Stop button appears immediately on Send, so a fast click can land
    // before `turn/start` has returned a turnId. Synthesizing a terminal frame
    // without sending `turn/interrupt` would tell the UI we stopped while the
    // Codex process kept running the original turn with no owner — its
    // notifications would be dropped or leak into the next turn. Refuse the
    // request: the user can click again once the turn is fully started.
    const turnId = runtime.activeTurn.responseId;
    if (!turnId) {
      this.deps.logger.info(
        { sessionId: input.sessionId },
        "Codex interrupt rejected — turnId not yet assigned"
      );
      return "no_active_turn";
    }
    try {
      await runtime.process.sendRequest("turn/interrupt", {
        threadId: runtime.threadId,
        turnId
      });
    } catch (err) {
      // The interrupt request can fail if Codex already moved on. Logging is
      // enough — we still synthesize a terminal frame below so the UI exits
      // its streaming state.
      this.deps.logger.warn(
        { err, sessionId: input.sessionId, turnId },
        "Codex turn/interrupt request failed; synthesizing terminal frame anyway"
      );
    }
    this.turnOrchestrator.interruptActiveTurn(runtime);
    // Drop any approvals that were still pending at interrupt time — leaving
    // them would let the UI keep showing an approve/reject prompt for a turn
    // that no longer exists, and a later decision would respond to the old
    // (interrupted) JSON-RPC request. Best-effort, doesn't block the response.
    void cancelPendingApprovals({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      reason: "turn_interrupted",
      approvals: this.deps.approvals,
      auditEvents: this.deps.auditEvents,
      logger: this.deps.logger,
      onCancelLocal: (approvalId) => {
        const pending = runtime.pendingApprovals.get(approvalId);
        runtime.pendingApprovals.delete(approvalId);
        const timer = runtime.pendingApprovalTimers.get(approvalId);
        if (timer) {
          clearTimeout(timer);
          runtime.pendingApprovalTimers.delete(approvalId);
        }
        // Unblock the codex process so its JSON-RPC request returns. If the
        // in-memory entry is missing the runtime was torn down already and
        // there's nothing to message.
        if (!pending) return undefined;
        respondToApprovalRequest(runtime.process, pending, "reject");
        return { itemId: pending.itemId, kind: pending.kind };
      }
    });
    // Re-arm idle cleanup. `startTurn` cleared the idle timer; the normal
    // turn/completed path re-arms it via scheduleIdleTeardown. The synthetic
    // interrupt path bypasses that, so without this the runtime would stay
    // warm forever after a Stop click.
    this.lifecycle.touchRuntime(runtime, "turn_interrupted");
    void this.lifecycle.persistRuntime(runtime, "active").catch((err: unknown) => {
      this.deps.logger.error(
        { err, sessionId: input.sessionId },
        "persistRuntime failed (turn interrupted)"
      );
    });
    this.lifecycle.scheduleIdleTeardown(runtime);
    return "interrupted";
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.lifecycle.runtimes.values()].map(async (runtime) => {
        await this.lifecycle.requestRuntimeShutdown(runtime, "app_shutdown");
        await this.lifecycle.finalizeRuntimeClosure(runtime, {
          reason: "app_shutdown",
          message: "Runtime shut down during application close."
        });
      })
    );
    this.lifecycle.runtimes.clear();
  }

  async readRuntimeFile(sessionId: string, filePath: string): Promise<Uint8Array> {
    const runtime = this.lifecycle.runtimes.get(sessionId);
    if (!runtime || !runtime.process.isAlive()) {
      throw new Error(`No active runtime for session ${sessionId}.`);
    }
    return runtime.process.readFile(resolveInsideSandbox(runtime.workspacePath, filePath));
  }

  async writeRuntimeFile(
    sessionId: string,
    filePath: string,
    data: Uint8Array | ArrayBuffer | string
  ): Promise<string> {
    const runtime = this.lifecycle.runtimes.get(sessionId);
    if (!runtime || !runtime.process.isAlive()) {
      throw new Error(`No active runtime for session ${sessionId}.`);
    }
    const resolved = resolveInsideSandbox(runtime.workspacePath, filePath);
    await runtime.process.writeFile(resolved, data);
    return resolved;
  }

  hasActiveTurn(sessionId: string): boolean {
    return Boolean(this.lifecycle.runtimes.get(sessionId)?.activeTurn);
  }

  hasSession(sessionId: string): boolean {
    return this.lifecycle.runtimes.has(sessionId);
  }

  getHealthSnapshot() {
    const runtimes = [...this.lifecycle.runtimes.values()].map((runtime) => ({
      sessionId: runtime.sessionId,
      runtimeId: runtime.runtimeId,
      healthStatus: runtime.healthStatus,
      lastActiveAt: runtime.lastActiveAt,
      hasActiveTurn: Boolean(runtime.activeTurn),
      processId: runtime.process.pid,
      port: runtime.process.port,
      socketState: this.lifecycle.describeSocketState(runtime.process.socketReadyState)
    }));

    return {
      activeRuntimeCount: runtimes.length,
      activeTurnCount: runtimes.filter((r) => r.hasActiveTurn).length,
      runtimes
    };
  }

  async refreshIdleRuntimes(
    tenantId: string,
    action: "drain_idle" | "refresh_idle"
  ): Promise<string[]> {
    const idleRuntimes = [...this.lifecycle.runtimes.values()].filter(
      (r) => r.tenantId === tenantId && !r.activeTurn
    );

    await Promise.all(
      idleRuntimes.map(async (runtime) => {
        const reason = action === "drain_idle" ? "config_drain" : "config_refresh";
        await this.lifecycle.requestRuntimeShutdown(runtime, reason);
        await this.lifecycle.finalizeRuntimeClosure(runtime, {
          reason,
          message:
            action === "drain_idle"
              ? "Runtime drained by admin rollout action."
              : "Runtime refreshed by admin rollout action."
        });
      })
    );

    return idleRuntimes.map((r) => r.sessionId);
  }

  // Generic per-user invalidation, parameterized by integration id. Used by
  // every connection service (github/microsoft/notion/...) when a user
  // (re)connects or disconnects. The integrationId flows into the audit
  // reason and runtime notice so different providers stay distinguishable.
  async invalidateRuntimesForIntegration(
    tenantId: string,
    userId: string,
    integrationId: string
  ): Promise<string[]> {
    return this.lifecycle.invalidateUserRuntimes(
      (runtime) => runtime.tenantId === tenantId && runtime.userId === userId,
      (pendingStart) => pendingStart.tenantId === tenantId && pendingStart.userId === userId,
      {
        reason: "integration_credentials_changed",
        message: `Runtime refreshed after ${integrationId} credential changes.`,
        logLabel: integrationId
      }
    );
  }

  // Tenant-wide invalidation triggered when an admin flips an integration toggle.
  // Toggle changes are rare and runtime restarts are cheap; rather than reasoning
  // about which users actually had the integration in their session, drain every
  // runtime in the tenant and let the next message rebuild with the new catalog.
  // The integrationId is captured for logging only.
  async invalidateIntegrationRuntimesForTenant(
    tenantId: string,
    integrationId: string
  ): Promise<string[]> {
    return this.lifecycle.invalidateUserRuntimes(
      (runtime) => runtime.tenantId === tenantId,
      (pendingStart) => pendingStart.tenantId === tenantId,
      {
        reason: "integration_state_changed",
        message: `Runtime refreshed after ${integrationId} integration state change.`,
        logLabel: `integration:${integrationId}`
      }
    );
  }
}
