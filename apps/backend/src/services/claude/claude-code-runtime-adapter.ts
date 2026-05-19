import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";
import type {
  RuntimeAdapter,
  RuntimeApprovalDecision,
  RuntimeEvent,
  RuntimeReasoningEffort,
  RuntimeSessionRef,
  RuntimeUserInput
} from "../../runtime-contracts.js";
import type { ActivationTracker } from "../activation-tracker.js";
import { bootstrapClaudeSession } from "./claude-session-bootstrap.js";
import { executeClaudeTurn } from "./claude-turn-executor.js";
import {
  buildClaudeContentBlocks,
  buildClaudeSdkOptions,
  resolveWorkspacePath,
  resolveSandboxWorkspacePath
} from "./claude-sdk-helpers.js";
import type { ClaudeCodeE2bOptions, ClaudeMcpServerEntry, ClaudeSessionState } from "./claude-types.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import type { ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { IntegrationRegistryService } from "../integrations/integration-registry-service.js";
import { cancelPendingApprovals } from "../runtime/approval-cleanup.js";
import type { RuntimeEgressIpPinStore } from "../runtime-egress-ip-pin.js";
import type { RuntimeSessionStore } from "../runtime/runtime-session-store.js";

export type { ClaudeCodeE2bOptions, ClaudeMcpServerEntry, ClaudeSessionState };

// Re-export helpers consumed by tests and external callers
export { buildClaudeSdkOptions, buildClaudeContentBlocks };

export class ClaudeCodeRuntimeAdapter implements RuntimeAdapter {
  readonly id = "claude-code";

  private readonly sessions = new Map<string, ClaudeSessionState>();
  private readonly activeTurns = new Set<string>();
  /**
   * Maps approvalId → sessionId for pending E2B approvals. The in-sandbox
   * harness owns the SDK's `canUseTool` Promise, so the backend's
   * `ClaudeApprovalHandler` is bypassed in e2b mode — approval resolution
   * must route through this map to reach the correct sandbox instead.
   */
  private readonly e2bPendingApprovals = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly dynamicConfig: DynamicConfigService,
    private readonly log: FastifyBaseLogger,
    private readonly managedToolCatalog: ManagedToolCatalog,
    private readonly stores?: {
      approvals?: ApprovalStore;
      runtimeSessions?: RuntimeSessionStore;
      // Required for HITL approval flows: every cleanup writes an
      // `approval.expired` audit row. If you have `approvals`, you also
      // need this — the pair is what makes interrupt-induced cleanup
      // forensically traceable. The constructor doesn't enforce this
      // strictly because adapters under test may opt out of approvals
      // entirely; production wiring (build-runtime-adapters.ts) provides
      // both.
      auditEvents?: AuditEventStore;
      // Optional so unit tests can opt out. Production wiring threads
      // this in so abortSession can release the runtime's pin slot
      // immediately rather than waiting on the 24-hour TTL.
      egressIpPins?: RuntimeEgressIpPinStore;
    },
    private readonly getTenantApiKey?: (tenantId: string) => Promise<string | null>,
    private readonly e2bOptions?: ClaudeCodeE2bOptions | null,
    private readonly integrationRegistry?: IntegrationRegistryService,
    private readonly activationTracker?: ActivationTracker
  ) {}

  private get mode(): "local" | "e2b" {
    return this.config.CLAUDE_RUNTIME_BACKEND === "e2b" && this.e2bOptions ? "e2b" : "local";
  }

  hasActiveTurn(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  hasRuntime(sessionId: string, runtimeId: string): boolean {
    const state = this.sessions.get(sessionId);
    return Boolean(state && state.runtimeId === runtimeId && !state.abortController.signal.aborted);
  }

  async createSession(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<RuntimeSessionRef> {
    const { tenantId, sessionId, userId } = input;

    // Idempotency: if a session already exists and is still active, reuse it.
    // Rebuilding on every /messages call would discard the captured Claude
    // session id and break the `resume` flow that carries conversation memory
    // across turns. Admins wanting fresh config should abort the session first.
    //
    // In e2b mode we must also verify the in-sandbox harness is still alive.
    // The sandbox-agent can die between turns (timeout, crash, E2B eviction)
    // without anyone flipping the abortController — if we blindly reused that
    // state the next runTurn would throw "E2B Claude sandbox is not available"
    // on every /messages call. Drop the dead session and fall through to a
    // fresh createSession path instead.
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.abortController.signal.aborted) {
      const sandboxStillUsable =
        existing.mode === "local" ||
        (existing.e2bProcess !== null && existing.e2bProcess.isAlive());
      if (sandboxStillUsable) {
        return {
          sessionId,
          runtimeId: existing.runtimeId,
          runtimePolicy: existing.configBundle.runtimePolicy
        };
      }

      // e2b session with a dead sandbox: tear it down before recreating so
      // runtime_sessions, approvalHandler, and any stale approvals are cleaned up.
      this.log.warn(
        { sessionId, runtimeId: existing.runtimeId },
        "Claude E2B sandbox is no longer alive; recreating the session"
      );
      await this.abortSession({ tenantId, sessionId, userId });
    }

    const state = await bootstrapClaudeSession(input, {
      config: this.config,
      dynamicConfig: this.dynamicConfig,
      log: this.log,
      getTenantApiKey: this.getTenantApiKey,
      e2bOptions: this.e2bOptions,
      integrationRegistry: this.integrationRegistry,
      activationTracker: this.activationTracker,
      managedToolCatalog: this.managedToolCatalog,
      stores: this.stores
    });
    this.sessions.set(sessionId, state);

    return {
      sessionId,
      runtimeId: state.runtimeId,
      runtimePolicy: state.configBundle.runtimePolicy
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
    const state = this.sessions.get(session.sessionId);
    if (!state) {
      throw new Error(`No Claude Code session found for ${session.sessionId}`);
    }

    yield* executeClaudeTurn(session, input, {
      state,
      activeTurns: this.activeTurns,
      e2bPendingApprovals: this.e2bPendingApprovals,
      stores: this.stores,
      config: this.config,
      log: this.log,
      managedToolCatalog: this.managedToolCatalog
    });
  }

  async readRuntimeFile(sessionId: string, filePath: string): Promise<Uint8Array> {
    const state = this.requireSessionState(sessionId);
    if (state.mode === "e2b" && state.e2bProcess) {
      return state.e2bProcess.readFile(resolveSandboxWorkspacePath(state.workspacePath, filePath));
    }
    return readFile(resolveWorkspacePath(state.workspacePath, filePath));
  }

  async writeRuntimeFile(
    sessionId: string,
    filePath: string,
    data: Uint8Array | ArrayBuffer | string
  ): Promise<string> {
    const state = this.requireSessionState(sessionId);
    if (state.mode === "e2b" && state.e2bProcess) {
      const sandboxPath = resolveSandboxWorkspacePath(state.workspacePath, filePath);
      await state.e2bProcess.writeFile(sandboxPath, data);
      return sandboxPath;
    }
    const resolvedPath = resolveWorkspacePath(state.workspacePath, filePath);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    const payload: string | Uint8Array =
      typeof data === "string"
        ? data
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
    await writeFile(resolvedPath, payload);
    return resolvedPath;
  }

  // Stop button — interrupt the in-flight turn for `sessionId` while leaving
  // the session warm. The shared `state.activeTurnInterrupt` ref points at
  // either iterator.interrupt() (local) or the sandbox interrupt-frame send
  // (e2b); either way the SDK eventually emits a result(subtype="interrupt")
  // which the event mapper turns into response.completed{interrupted:true}.
  async interruptTurn(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<"interrupted" | "no_active_turn"> {
    const state = this.sessions.get(input.sessionId);
    if (!state || !this.activeTurns.has(input.sessionId)) {
      return "no_active_turn";
    }
    const interrupt = state.activeTurnInterrupt.current;
    if (!interrupt) {
      return "no_active_turn";
    }
    try {
      await interrupt();
    } catch (err) {
      this.log.warn(
        { err, sessionId: input.sessionId, mode: state.mode },
        "Claude iterator.interrupt() failed; expecting SDK to surface the result anyway"
      );
    }
    // Drop any approvals that were still pending at interrupt time so the UI
    // doesn't keep showing an approve/reject prompt for a stopped turn and a
    // late decision can't resolve into a turn that no longer exists.
    //   - local mode: cancel deferred canUseTool promises (deny → SDK moves on)
    //     by clearing the in-process handler once.
    //   - e2b mode: drop the per-approval entry in `e2bPendingApprovals` so
    //     `resolveApproval` can't try to forward a decision over a
    //     torn-down sandbox bridge (handled inside onCancelLocal below).
    //   - both modes: expire the DB rows + emit `approval.expired` audit
    //     events via the shared cleanup helper.
    state.approvalHandler.clearAll();
    if (this.stores?.approvals && this.stores?.auditEvents) {
      void cancelPendingApprovals({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        userId: input.userId,
        reason: "turn_interrupted",
        approvals: this.stores.approvals,
        auditEvents: this.stores.auditEvents,
        logger: this.log,
        onCancelLocal: (approvalId) => {
          this.e2bPendingApprovals.delete(approvalId);
          return undefined;
        }
      });
    } else {
      // Approvals/audit store not wired (test fixtures opting out). Still
      // drain the in-memory e2b map for this session so a stale decision
      // can't be forwarded to a torn-down sandbox bridge.
      for (const [approvalId, sid] of this.e2bPendingApprovals) {
        if (sid === input.sessionId) this.e2bPendingApprovals.delete(approvalId);
      }
    }
    return "interrupted";
  }

  async abortSession(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<void> {
    const state = this.sessions.get(input.sessionId);
    if (!state) return;

    state.abortController.abort();
    state.approvalHandler.clearAll();

    // Drop any e2b approvals outstanding for this session; the sandbox will be
    // killed right after and the deferred Promises would never resolve otherwise.
    for (const [approvalId, sid] of this.e2bPendingApprovals) {
      if (sid === input.sessionId) this.e2bPendingApprovals.delete(approvalId);
    }

    if (state.e2bProcess) {
      await state.e2bProcess.terminate().catch((err) => {
        this.log.warn({ err, sessionId: input.sessionId }, "Failed to terminate E2B Claude sandbox");
      });
    }

    // Release the runtime's IP pin so the slot is reclaimable immediately
    // instead of waiting on the 24-hour TTL. The runtimeId from the dead
    // runtime is never reused (a fresh bootstrap always mints a new
    // uuidv7), so this is purely tidiness — but it also closes a narrow
    // edge case where a still-valid leaked rt_* token could be replayed
    // against a fresh slot under the dead runtimeId after the in-memory
    // pin is gone.
    this.stores?.egressIpPins?.clear(state.runtimeId);

    if (this.stores?.runtimeSessions) {
      try {
        await this.stores.runtimeSessions.setStatus(
          input.tenantId,
          input.sessionId,
          input.userId,
          "terminated"
        );
      } catch (err) {
        this.log.warn({ err, sessionId: input.sessionId }, "Failed to update Claude runtime session status");
      }
    }

    // In e2b mode the backend only has the local staging dir; the sandbox path
    // does not exist on the backend filesystem.
    const cleanupTarget = state.mode === "e2b" ? state.localStagingPath : state.workspacePath;
    if (cleanupTarget) {
      rm(cleanupTarget, { recursive: true, force: true }).catch((err: unknown) => {
        this.log.warn(
          { err, sessionId: input.sessionId, cleanupTarget },
          "failed to clean up Claude workspace dir"
        );
      });
    }

    this.sessions.delete(input.sessionId);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((state) =>
        this.abortSession({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          userId: state.userId
        })
      )
    );
  }

  // Tear down every active Claude session for the tenant after an admin flips
  // an integration toggle. Mirrors CodexRuntimeManager.invalidateIntegrationRuntimesForTenant.
  // The next /messages call rebuilds the session bundle with the new tool catalog.
  async invalidateIntegrationRuntimesForTenant(
    tenantId: string,
    _integrationId: string
  ): Promise<string[]> {
    const targets = [...this.sessions.values()].filter((state) => state.tenantId === tenantId);
    await Promise.all(
      targets.map((state) =>
        this.abortSession({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          userId: state.userId
        })
      )
    );
    return targets.map((state) => state.sessionId);
  }

  async resolveApproval(input: {
    tenantId: string;
    approvalId: string;
    userId: string;
    decision: RuntimeApprovalDecision;
    rememberForTurn?: boolean;
  }): Promise<"resolved" | "missing"> {
    const { tenantId, approvalId, userId, decision, rememberForTurn } = input;

    // In e2b mode the approval Promise lives inside the sandbox harness. Look
    // up the owning session and forward the decision over stdin. The SDK
    // inside the sandbox then resumes the canUseTool handler.
    const e2bSessionId = this.e2bPendingApprovals.get(approvalId);
    if (e2bSessionId) {
      const state = this.sessions.get(e2bSessionId);
      if (!state || state.tenantId !== tenantId || state.userId !== userId) {
        return "missing";
      }
      this.e2bPendingApprovals.delete(approvalId);
      if (state.e2bProcess) {
        void state.e2bProcess
          .sendApprovalResponse(approvalId, decision === "approve" ? "approve" : "reject")
          .catch((err) => {
            this.log.warn(
              { err, approvalId, sessionId: e2bSessionId },
              "Failed to forward approval to E2B sandbox"
            );
          });
        return "resolved";
      }
      return "missing";
    }

    // Local mode: approval lives in the in-process ClaudeApprovalHandler.
    // Only search sessions belonging to the requesting tenant and user.
    for (const [, state] of this.sessions) {
      if (
        state.mode === "local" &&
        state.tenantId === tenantId &&
        state.userId === userId &&
        state.approvalHandler.resolveApproval(approvalId, decision, rememberForTurn)
      ) {
        return "resolved";
      }
    }
    return "missing";
  }

  private requireSessionState(sessionId: string): ClaudeSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`No Claude Code session found for ${sessionId}`);
    }
    return state;
  }
}
