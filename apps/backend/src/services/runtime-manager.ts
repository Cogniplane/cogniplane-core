import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import {
  SessionBusyError,
  type PolicyApprovalDisposition,
  type PolicyApprovalRouteInput,
  type RuntimeAdapter,
  type RuntimeApprovalDecision,
  type RuntimeEvent,
  type RuntimeReasoningEffort,
  type RuntimeSessionRef,
  type RuntimeUserInput
} from "../runtime-contracts.js";

import type { AppConfig } from "../config.js";
import { AsyncQueue } from "../lib/async-queue.js";
import { getErrorMessage } from "../lib/http-errors.js";
import { respondToApprovalRequest } from "./runtime/runtime-approval-coordinator.js";
import { PolicyApprovalCoordinator } from "./runtime/policy-approval-coordinator.js";
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
  ActiveTurnState,
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
  private readonly policyApprovals: PolicyApprovalCoordinator;

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
      // Required: both runtimes run inside E2B; build-runtime-adapters always
      // supplies the sandbox-backed factories (tests inject fakes).
      processFactory: RuntimeProcessFactory;
      workspaceFactory: RuntimeWorkspaceFactory;
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
      deps.egressIpPins,
      // Expire any still-pending approvals when a runtime is torn down by any
      // path (idle/crash/socket-close/invalidation). Without this, a teardown
      // mid-approval orphans `status='pending'` rows: the UI keeps showing a
      // dead approve/reject prompt and a late decision 404s into a gone turn.
      // interruptTurn already does this for the explicit-interrupt path; this
      // closes the implicit-teardown gap. Runs before the in-memory map is
      // cleared so onCancelLocal can still read it.
      (runtime) =>
        cancelPendingApprovals({
          tenantId: runtime.tenantId,
          sessionId: runtime.sessionId,
          userId: runtime.userId,
          reason: "runtime_terminated",
          approvals: this.deps.approvals,
          auditEvents: this.deps.auditEvents,
          logger: this.deps.logger,
          onCancelLocal: (approvalId) => {
            // Release a policy-held tool call immediately (no-op if not ours) so
            // the gateway's awaiting HTTP response doesn't hang until the
            // coordinator's own TTL fires.
            this.policyApprovals.cancel(approvalId);
            const pending = runtime.pendingApprovals.get(approvalId);
            return pending ? { itemId: pending.itemId, kind: pending.kind } : undefined;
          }
        })
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

    // Policy Center tool-call approvals (gateway-held). Pushes the prompt onto
    // the session's active turn queue; the existing /approvals decision route
    // settles it via resolveApproval below.
    this.policyApprovals = new PolicyApprovalCoordinator({
      approvals: deps.approvals,
      auditEvents: deps.auditEvents,
      logger: deps.logger,
      ttlMs: deps.config.APPROVAL_REQUEST_TTL_MS,
      reminderFraction: deps.config.POLICY_APPROVAL_REMINDER_FRACTION,
      pushFrameworkEvent: (sessionId, event) => {
        const runtime = this.lifecycle.runtimes.get(sessionId);
        if (!runtime?.activeTurn) return false;
        runtime.activeTurn.queue.push(event);
        return true;
      }
    });

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

    // Reserve the turn slot SYNCHRONOUSLY — no await between the busy check
    // and this assignment — so a concurrent runMessage for the same session
    // can't pass the check during onBeforeTurn (multi-second artifact sync)
    // and overwrite this turn.
    const queue = new AsyncQueue<RuntimeEvent>();
    const activeTurn: ActiveTurnState = {
      queue,
      responseId: null,
      outputItemDone: false,
      watchdogTimer: null,
      runtimePolicyId: input.runtimePolicyId,
      toolContextId: input.toolContextId,
      assistantMessageId: input.assistantMessageId ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      autoApprovedKinds: new Set()
    };
    runtime.activeTurn = activeTurn;
    this.armTurnWatchdog(session.sessionId, runtime, activeTurn);

    if (input.onBeforeTurn) {
      try {
        await input.onBeforeTurn();
      } catch (error) {
        // The turn never started — release the reservation (no process-side
        // turn to interrupt, idle timer untouched) and surface the error.
        if (runtime.activeTurn?.queue === queue) {
          runtime.activeTurn = null;
        }
        throw error;
      }
    }

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
      // If a runtime still holds this turn here, the consumer exited WITHOUT a
      // terminal event (e.g. the SSE writer threw mid-stream, or the scheduler
      // worker died) — every terminal path in the orchestrator nulls the slot
      // before ending the queue. Nothing else will stop the process-side turn
      // or re-arm idle teardown (startTurn cleared the idle timer and the
      // terminal notification handlers early-return once the slot is empty),
      // so the sandbox would stay warm until the E2B hard timeout and the
      // runtime_sessions row would stay 'active'. Stop the turn the same way
      // the Stop button does. The restart path in startTurn can re-point the
      // turn onto a replacement runtime, so check both candidates.
      const currentRuntime = this.lifecycle.runtimes.get(session.sessionId);
      for (const owner of new Set([currentRuntime, runtime])) {
        if (owner?.activeTurn?.queue === queue) {
          this.stopActiveTurn(owner, "turn_abandoned");
        }
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
    // Find the owning runtime in memory BEFORE mutating the shared `approvals`
    // row. The production route consults this manager first for EVERY approval
    // (Codex and Claude alike); flipping the DB row here for an approval owned
    // by another provider would settle it and strand the real owner (its
    // resolveApproval, tried next, would see a null row and never deliver the
    // decision to its runtime). approvalIds are globally unique, so scanning by
    // id is safe; the tenant/user gate is still enforced by `approvals.resolve`.
    let runtime: RuntimeState | undefined;
    for (const candidate of this.lifecycle.runtimes.values()) {
      if (candidate.pendingApprovals.has(input.approvalId)) {
        runtime = candidate;
        break;
      }
    }
    const pending = runtime?.pendingApprovals.get(input.approvalId);
    if (!runtime || !pending) {
      // Not a native (shell/file) approval owned here — it may be a Policy
      // Center tool-call approval this adapter is holding at the gateway.
      if (this.policyApprovals.has(input.approvalId)) {
        return this.policyApprovals.resolve({
          tenantId: input.tenantId,
          approvalId: input.approvalId,
          userId: input.userId,
          decision: input.decision
        });
      }
      return "missing";
    }

    // Mirror the DB gate (`tenant_id`/`user_id` on approvals.resolve) before
    // claiming, so a caller who isn't the approval's owner can't disturb the
    // pending entry — for them this approval simply doesn't exist.
    if (runtime.tenantId !== input.tenantId || runtime.userId !== input.userId) {
      return "missing";
    }

    // Claim the entry synchronously (and disarm its TTL timer) BEFORE the DB
    // write. The expiry timer claims the same way, so exactly one path ever
    // answers the JSON-RPC request — without this, a TTL tick during the await
    // below could reject a call the DB just recorded as approved.
    runtime.pendingApprovals.delete(input.approvalId);
    clearApprovalExpiry(runtime, input.approvalId);
    // Capture the turn that owns this approval NOW: if it ends during the DB
    // write below, a rememberForTurn must land on the (then-orphaned) old
    // turn's set, not auto-approve actions in whatever turn replaced it.
    const turnAtClaim = runtime.activeTurn;

    let approval: Awaited<ReturnType<ApprovalStore["resolve"]>>;
    try {
      approval = await this.deps.approvals.resolve(
        input.tenantId,
        input.approvalId,
        input.userId,
        input.decision
      );
    } catch (error) {
      // We hold the claim — deny so the runtime unblocks, then surface the
      // error to the decision route. The still-pending row is left for the sweep.
      respondToApprovalRequest(runtime.process, pending, "reject");
      throw error;
    }
    if (!approval) {
      // Row settled externally (cross-replica sweep) or never persisted. The
      // external path can't reach this process's JSON-RPC request, so deny it
      // here to unblock the runtime instead of leaking the pending slot.
      respondToApprovalRequest(runtime.process, pending, "reject");
      return "missing";
    }

    if (input.rememberForTurn && input.decision === "approve" && turnAtClaim) {
      turnAtClaim.autoApprovedKinds.add(pending.kind);
    }
    respondToApprovalRequest(runtime.process, pending, input.decision);

    // Best-effort: the decision has already been delivered to the runtime and
    // is irreversible — an audit-write failure must not 500 the decision route
    // and invite a retry of an action whose side effects already occurred.
    try {
      await this.deps.auditEvents.create({
        tenantId: input.tenantId,
        sessionId: approval.sessionId,
        userId: approval.userId,
        approvalId: approval.approvalId,
        type: input.decision === "approve" ? "approval.approved" : "approval.rejected",
        payload: { itemId: approval.itemId, kind: approval.kind }
      });
    } catch (error) {
      this.deps.logger.warn(
        { err: error, approvalId: input.approvalId, sessionId: approval.sessionId },
        "failed to write approval decision audit event (decision already delivered)"
      );
    }
    return "resolved";
  }

  async requestPolicyApproval(input: PolicyApprovalRouteInput): Promise<PolicyApprovalDisposition> {
    return this.policyApprovals.request(input);
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
    if (!runtime.activeTurn.responseId) {
      this.deps.logger.info(
        { sessionId: input.sessionId },
        "Codex interrupt rejected — turnId not yet assigned"
      );
      return "no_active_turn";
    }
    this.stopActiveTurn(runtime, "turn_interrupted");
    return "interrupted";
  }

  // Turn-duration watchdog (RUNTIME_TURN_TIMEOUT_MS). The turn is
  // notification-driven: per-request timeouts bound turn/start, but nothing
  // else bounds how long Codex can sit between notifications — a wedged turn
  // pins the session busy (SessionBusyError on every send) until the E2B hard
  // timeout. On expiry: fail the turn (terminal frame unblocks the SSE
  // consumer) and recycle the runtime — a wedged process can't be trusted
  // with the next turn.
  private armTurnWatchdog(sessionId: string, runtime: RuntimeState, activeTurn: ActiveTurnState): void {
    const timeoutMs = this.deps.config.RUNTIME_TURN_TIMEOUT_MS;
    if (timeoutMs <= 0) return;
    activeTurn.watchdogTimer = setTimeout(() => {
      activeTurn.watchdogTimer = null;
      // The restart path can re-point the turn onto a replacement runtime —
      // find the runtime that holds this turn NOW; no holder means it settled.
      const current = this.lifecycle.runtimes.get(sessionId);
      const owner =
        current?.activeTurn === activeTurn ? current : runtime.activeTurn === activeTurn ? runtime : null;
      if (!owner) return;
      this.deps.logger.error(
        { sessionId, runtimeId: owner.runtimeId, timeoutMs },
        "turn watchdog expired — failing turn and recycling runtime"
      );
      this.turnOrchestrator.failActiveTurn(
        owner,
        `Turn exceeded the ${timeoutMs}ms limit and was aborted.`
      );
      void this.lifecycle.requestRuntimeShutdown(owner, "turn_timeout").catch((err: unknown) => {
        this.deps.logger.error({ err, sessionId }, "runtime shutdown after turn timeout failed");
      });
    }, timeoutMs);
    activeTurn.watchdogTimer.unref?.();
  }

  // Shared turn-stopping tail for the Stop button (interruptTurn) and the
  // abandoned-consumer cleanup in runMessage's finally. Synchronous on
  // purpose: the active-turn slot must be released before anything awaits so
  // a follow-up send can't hit SessionBusyError; the turn/interrupt RPC and
  // the DB writes are best-effort and must not block the caller. Late
  // notifications from the stopped turn are dropped via staleTurnIds.
  private stopActiveTurn(runtime: RuntimeState, activity: "turn_interrupted" | "turn_abandoned"): void {
    const turnId = runtime.activeTurn?.responseId ?? null;
    this.turnOrchestrator.interruptActiveTurn(runtime);
    if (turnId) {
      void runtime.process
        .sendRequest("turn/interrupt", { threadId: runtime.threadId, turnId })
        .catch((err: unknown) => {
          // The interrupt request can fail if Codex already moved on. Logging
          // is enough — the terminal frame was already synthesized above.
          this.deps.logger.warn(
            { err, sessionId: runtime.sessionId, turnId },
            "Codex turn/interrupt request failed; terminal frame already synthesized"
          );
        });
    }
    // Drop any approvals that were still pending when the turn stopped —
    // leaving them would let the UI keep showing an approve/reject prompt for
    // a turn that no longer exists, and a later decision would respond to the
    // old (stopped) JSON-RPC request. Best-effort, doesn't block the caller.
    void cancelPendingApprovals({
      tenantId: runtime.tenantId,
      sessionId: runtime.sessionId,
      userId: runtime.userId,
      reason: activity,
      approvals: this.deps.approvals,
      auditEvents: this.deps.auditEvents,
      logger: this.deps.logger,
      onCancelLocal: (approvalId) => {
        // Release a policy-held tool call (no-op if not ours) so the gateway's
        // awaiting HTTP response unblocks immediately on interrupt.
        this.policyApprovals.cancel(approvalId);
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
    // turn/completed path re-arms it via scheduleIdleTeardown. Both synthetic
    // stop paths bypass that, so without this the runtime would stay warm
    // forever (and keep billing the sandbox).
    this.lifecycle.touchRuntime(runtime, activity);
    void this.lifecycle.persistRuntime(runtime, "active").catch((err: unknown) => {
      this.deps.logger.error(
        { err, sessionId: runtime.sessionId, activity },
        "persistRuntime failed (turn stopped)"
      );
    });
    this.lifecycle.scheduleIdleTeardown(runtime);
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

  async statRuntimeFile(sessionId: string, filePath: string): Promise<{ sizeBytes: number }> {
    const runtime = this.lifecycle.runtimes.get(sessionId);
    if (!runtime || !runtime.process.isAlive() || !runtime.process.statFile) {
      throw new Error(`No active runtime for session ${sessionId}.`);
    }
    return runtime.process.statFile(resolveInsideSandbox(runtime.workspacePath, filePath));
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

  // Aggregate counts only — served by the UNAUTHENTICATED /health endpoint.
  // Per-runtime identifiers (sessionId, runtimeId, port) span every tenant
  // and must never appear here; getRuntimeHealthDetail is the tenant-scoped
  // admin view.
  getHealthSnapshot() {
    const runtimes = [...this.lifecycle.runtimes.values()];
    return {
      activeRuntimeCount: runtimes.length,
      activeTurnCount: runtimes.filter((runtime) => Boolean(runtime.activeTurn)).length
    };
  }

  // Tenant-scoped live process detail for the admin workbench.
  getRuntimeHealthDetail(tenantId: string) {
    return [...this.lifecycle.runtimes.values()]
      .filter((runtime) => runtime.tenantId === tenantId)
      .map((runtime) => ({
        sessionId: runtime.sessionId,
        runtimeId: runtime.runtimeId,
        healthStatus: runtime.healthStatus,
        lastActiveAt: runtime.lastActiveAt,
        hasActiveTurn: Boolean(runtime.activeTurn),
        processId: runtime.process.pid,
        port: runtime.process.port,
        isAlive: runtime.process.isAlive()
      }));
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

  async invalidateTenantRuntimes(tenantId: string): Promise<string[]> {
    return this.lifecycle.invalidateUserRuntimes(
      (runtime) => runtime.tenantId === tenantId,
      (pendingStart) => pendingStart.tenantId === tenantId,
      {
        reason: "config_refresh",
        message: "Runtime refreshed after tenant settings changed.",
        logLabel: "tenant-settings"
      }
    );
  }
}
