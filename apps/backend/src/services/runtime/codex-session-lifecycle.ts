
import type { FastifyBaseLogger } from "fastify";
import { uuidv7 } from "../../lib/uuid.js";

import type { AppConfig } from "../../config.js";
import { getErrorMessage } from "../../lib/http-errors.js";
import type { WorkspaceArtifacts } from "./runtime-workspace.js";
import {
  CodexRuntimeProcessStartError
} from "./codex-jsonrpc.js";
import type { ResolvedRuntimePolicy } from "../admin-config-records.js";
import type {
  RuntimeProcessHandle,
  RuntimeShutdownReason,
  RuntimeState
} from "./runtime-types.js";
import type { RuntimeEgressIpPinStore } from "../runtime-egress-ip-pin.js";
import type { RuntimeSessionStore } from "./runtime-session-store.js";
import {
  clearIdleTimer as clearIdleTimerShared,
  scheduleIdleTeardown as scheduleIdleTeardownShared
} from "./idle-teardown.js";

type PendingRuntimeStart = {
  tenantId: string;
  userId: string;
  invalidated: boolean;
  invalidation: { reason: RuntimeShutdownReason; message: string };
  promise: Promise<RuntimeState>;
};

export class CodexSessionLifecycle {
  readonly runtimes = new Map<string, RuntimeState>();
  readonly runtimeStarts = new Map<string, PendingRuntimeStart>();

  constructor(
    private readonly config: Pick<
      AppConfig,
      "RUNTIME_IDLE_TIMEOUT_MS" | "CODEX_VERSION" | "CODEX_SCHEMA_VERSION"
    >,
    readonly runtimeSessions: RuntimeSessionStore,
    private readonly logger: FastifyBaseLogger,
    // Optional so unit tests can construct the lifecycle without wiring
    // the pin store; production passes it from build-runtime-adapters.
    private readonly egressIpPins?: RuntimeEgressIpPinStore,
    // Invoked once per runtime when it is finalized (any teardown path: idle,
    // crash, socket close, invalidation), BEFORE in-memory approval state is
    // cleared so the hook can still read `runtime.pendingApprovals` to build
    // audit payloads. The manager wires this to expire the runtime's still-
    // pending approval DB rows — otherwise a crash/teardown mid-approval leaves
    // rows stuck in `status='pending'` forever, with the UI showing a dead
    // approve/reject prompt and a late decision 404-ing into a torn-down turn.
    // Best-effort: a throw here is logged but never blocks teardown.
    private readonly onFinalize?: (runtime: RuntimeState) => Promise<void>
  ) {}

  async ensureRuntime(
    tenantId: string,
    sessionId: string,
    userId: string,
    startFn: (tenantId: string, sessionId: string, userId: string) => Promise<RuntimeState>
  ): Promise<RuntimeState> {
    while (true) {
      const existing = this.runtimes.get(sessionId);
      if (existing && !existing.closed && existing.process.isAlive()) {
        this.touchRuntime(existing, "runtime_reused");
        await this.persistRuntime(existing, "active");
        this.scheduleIdleTeardown(existing);
        return existing;
      }

      const pendingStart = this.runtimeStarts.get(sessionId);
      if (pendingStart) {
        return pendingStart.promise;
      }

      const startPromise = startFn(tenantId, sessionId, userId);
      const startState: PendingRuntimeStart = {
        tenantId,
        userId,
        invalidated: false,
        // Default placeholder — overwritten by `invalidateUserRuntimes` when
        // an actual invalidation lands; never read otherwise. Kept here so
        // the PendingRuntimeStart shape stays uniform.
        invalidation: {
          reason: "integration_credentials_changed",
          message: "Runtime refreshed after integration credential changes."
        },
        promise: startPromise
      };
      this.runtimeStarts.set(sessionId, startState);

      try {
        const runtime = await startPromise;
        if (startState.invalidated) {
          await this.invalidateRuntime(runtime, startState.invalidation);
          continue;
        }
        return runtime;
      } finally {
        if (this.runtimeStarts.get(sessionId) === startState) {
          this.runtimeStarts.delete(sessionId);
        }
      }
    }
  }

  async requestRuntimeShutdown(runtime: RuntimeState, reason: RuntimeShutdownReason): Promise<void> {
    if (runtime.finalized) return;
    this.clearIdleTimer(runtime);
    runtime.shutdownReason = reason;
    runtime.closed = true;
    runtime.healthStatus = "terminating";
    runtime.lifecycleMetadata = {
      ...runtime.lifecycleMetadata,
      shutdownReason: reason,
      shutdownRequestedAt: new Date().toISOString()
    };
    await this.persistRuntime(runtime, "terminating");
    // terminate() fires close listeners (stream end) then kills the sandbox.
    runtime.process.terminate();
  }

  async finalizeRuntimeClosure(
    runtime: RuntimeState,
    input: { reason: RuntimeShutdownReason; message: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    if (runtime.finalized) return;

    const currentRuntime = this.runtimes.get(runtime.sessionId);
    const isCurrentRuntime = currentRuntime === runtime;

    runtime.finalized = true;
    runtime.closed = true;

    // Expire still-pending approval DB rows BEFORE we drop the in-memory map —
    // the hook reads `runtime.pendingApprovals` to build audit payloads and to
    // unblock the codex JSON-RPC requests. Best-effort: never let cleanup
    // failure abort teardown.
    if (this.onFinalize) {
      try {
        await this.onFinalize(runtime);
      } catch (err) {
        this.logger.error(
          { err, sessionId: runtime.sessionId },
          "onFinalize hook failed during runtime teardown"
        );
      }
    }

    runtime.pendingApprovals.clear();
    for (const timer of runtime.pendingApprovalTimers.values()) {
      clearTimeout(timer);
    }
    runtime.pendingApprovalTimers.clear();
    this.clearIdleTimer(runtime);
    if (isCurrentRuntime) {
      this.runtimes.delete(runtime.sessionId);
    }
    // Release the runtime's egress-IP pin slot. New bootstraps mint a
    // fresh runtimeId so the dead pin is harmless either way, but
    // clearing it here reclaims the slot immediately and closes a
    // narrow edge case where a leaked rt_* could re-pin a fresh
    // sandbox under the dead runtimeId.
    this.egressIpPins?.clear(runtime.runtimeId);

    runtime.terminatedAt = new Date().toISOString();
    runtime.healthStatus = "terminated";
    runtime.shutdownReason = runtime.shutdownReason ?? input.reason;
    runtime.lifecycleMetadata = {
      ...runtime.lifecycleMetadata,
      ...input.metadata,
      shutdownReason: runtime.shutdownReason,
      terminatedAt: runtime.terminatedAt
    };

    const expectedShutdown =
      runtime.shutdownReason !== "runtime_exit" && runtime.shutdownReason !== "socket_closed";
    const finalStatus = expectedShutdown ? "inactive" : "terminated";

    if (runtime.activeTurn) {
      runtime.activeTurn.queue.push({
        type: "response.failed",
        responseId: runtime.activeTurn.responseId ?? uuidv7(),
        message: input.message
      });
      runtime.activeTurn.queue.end();
      runtime.activeTurn = null;
    }

    runtime.process.rejectPendingRequests("Codex runtime exited before responding.");
    if (isCurrentRuntime) {
      await this.persistRuntime(runtime, finalStatus);
    }
    // The workspace files that embed the plaintext runtime token (codex.toml,
    // runtime-manifest.json) live inside the E2B sandbox, which is destroyed
    // wholesale on teardown — nothing to scrub on the backend filesystem.
  }

  async invalidateRuntime(
    runtime: RuntimeState,
    input: { reason: RuntimeShutdownReason; message: string }
  ): Promise<void> {
    await this.requestRuntimeShutdown(runtime, input.reason);
    await this.finalizeRuntimeClosure(runtime, input);
  }

  async invalidateUserRuntimes(
    shouldInvalidateRuntime: (runtime: RuntimeState) => boolean,
    shouldInvalidatePendingStart: (pendingStart: PendingRuntimeStart) => boolean,
    invalidation: { reason: RuntimeShutdownReason; message: string; logLabel: string }
  ): Promise<string[]> {
    const invalidatedSessionIds = new Set<string>();

    for (const [sessionId, pendingStart] of this.runtimeStarts.entries()) {
      if (shouldInvalidatePendingStart(pendingStart)) {
        pendingStart.invalidated = true;
        pendingStart.invalidation = invalidation;
        invalidatedSessionIds.add(sessionId);
      }
    }

    const runtimesToInvalidate = [...this.runtimes.values()].filter(shouldInvalidateRuntime);
    const results = await Promise.allSettled(
      runtimesToInvalidate.map(async (runtime) => {
        invalidatedSessionIds.add(runtime.sessionId);
        await this.invalidateRuntime(runtime, invalidation);
      })
    );
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.warn(
          { err: result.reason },
          `${invalidation.logLabel} runtime invalidation failed`
        );
      }
    }

    return [...invalidatedSessionIds];
  }

  async persistRuntime(
    runtime: RuntimeState,
    status: string,
    workspace?: WorkspaceArtifacts
  ): Promise<void> {
    await this.runtimeSessions.upsert({
      tenantId: runtime.tenantId,
      sessionId: runtime.sessionId,
      userId: runtime.userId,
      runtimeId: runtime.runtimeId,
      runtimeProvider: runtime.provider,
      workspacePath: runtime.workspacePath,
      runtimeVersion: this.config.CODEX_VERSION,
      runtimeSchemaVersion: this.config.CODEX_SCHEMA_VERSION,
      manifestPath: workspace?.manifestPath ?? runtime.manifestPath,
      manifestMetadata: workspace?.manifest ?? runtime.manifest,
      healthStatus: runtime.healthStatus,
      lastActiveAt: runtime.lastActiveAt,
      startedAt: runtime.startedAt,
      terminatedAt: runtime.terminatedAt,
      lifecycleMetadata: runtime.lifecycleMetadata,
      status
    });
  }

  async persistStartupFailure(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    runtimeId: string;
    workspace: WorkspaceArtifacts;
    startedAt: string;
    error: unknown;
    process: RuntimeProcessHandle | null;
  }): Promise<void> {
    const { tenantId, sessionId, userId, runtimeId, workspace, startedAt, error, process } = input;

    const startupError =
      error instanceof CodexRuntimeProcessStartError
        ? error
        : new CodexRuntimeProcessStartError(
            getErrorMessage(error, "Runtime startup failed"),
            process?.port ?? 0,
            process?.pid ?? null
          );

    await this.runtimeSessions.upsert({
      tenantId,
      sessionId,
      userId,
      runtimeId,
      runtimeProvider: "codex",
      workspacePath: workspace.workspacePath,
      runtimeVersion: this.config.CODEX_VERSION,
      runtimeSchemaVersion: this.config.CODEX_SCHEMA_VERSION,
      manifestPath: workspace.manifestPath,
      manifestMetadata: workspace.manifest,
      healthStatus: "error",
      lastActiveAt: startedAt,
      startedAt,
      terminatedAt: new Date().toISOString(),
      lifecycleMetadata: {
        port: startupError.port,
        processId: startupError.processId,
        idleTimeoutMs: this.config.RUNTIME_IDLE_TIMEOUT_MS,
        shutdownReason: "startup_failure",
        lastError: startupError.message
      },
      status: "error"
    });
  }

  clearIdleTimer(runtime: RuntimeState): void {
    clearIdleTimerShared(runtime);
  }

  scheduleIdleTeardown(runtime: RuntimeState): void {
    scheduleIdleTeardownShared(runtime, {
      timeoutMs: this.config.RUNTIME_IDLE_TIMEOUT_MS,
      isBusy: () => runtime.closed || Boolean(runtime.activeTurn),
      onIdle: () => this.requestRuntimeShutdown(runtime, "idle_timeout"),
      logger: this.logger,
      logContext: { sessionId: runtime.sessionId }
    });
  }

  touchRuntime(runtime: RuntimeState, activity: string): void {
    runtime.lastActiveAt = new Date().toISOString();
    runtime.lifecycleMetadata = { ...runtime.lifecycleMetadata, lastActivity: activity };
  }

  createRuntimeState(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    runtimeId: string;
    workspace: WorkspaceArtifacts;
    runtimePolicy: ResolvedRuntimePolicy;
    process: RuntimeProcessHandle;
    startedAt: string;
  }): RuntimeState {
    return {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      runtimeId: input.runtimeId,
      provider: "codex",
      workspacePath: input.workspace.workspacePath,
      manifestPath: input.workspace.manifestPath,
      manifest: input.workspace.manifest,
      runtimePolicy: input.runtimePolicy,
      process: input.process,
      threadId: "",
      activeTurn: null,
      staleTurnIds: new Set(),
      pendingApprovals: new Map(),
      pendingApprovalTimers: new Map(),
      idleTimer: null,
      healthStatus: "starting",
      startedAt: input.startedAt,
      lastActiveAt: input.startedAt,
      terminatedAt: null,
      lifecycleMetadata: {
        port: input.process.port,
        processId: input.process.pid,
        idleTimeoutMs: this.config.RUNTIME_IDLE_TIMEOUT_MS,
        startupCompletedAt: null,
        lastActivity: "runtime_spawned"
      },
      shutdownReason: null,
      finalized: false,
      closed: false
    };
  }

  registerRuntime(runtime: RuntimeState): void {
    this.runtimes.set(runtime.sessionId, runtime);
  }

}
