import { rm } from "node:fs/promises";

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
  resolveSandboxWorkspacePath
} from "./claude-sdk-helpers.js";
import type { ClaudeCodeE2bOptions, ClaudeMcpServerEntry, ClaudeSessionState } from "./claude-types.js";
import type { ManagedToolCatalog } from "../managed-tools/catalog.js";
import type { ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { DynamicConfigService } from "../dynamic-config-service.js";
import type { IntegrationRegistryService } from "../integrations/integration-registry-service.js";
import { cancelPendingApprovals, expireApprovalById } from "../runtime/approval-cleanup.js";
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
   * harness owns the SDK's `canUseTool` Promise, so approval resolution must
   * route through this map to reach the correct sandbox.
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
      if (existing.e2bProcess.isAlive()) {
        return {
          sessionId,
          runtimeId: existing.runtimeId,
          runtimePolicy: existing.configBundle.runtimePolicy
        };
      }

      // Dead sandbox: tear it down before recreating so runtime_sessions and
      // any stale approvals are cleaned up.
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
      stores: this.stores,
      // e2b-only: the in-sandbox harness owns the SDK's `canUseTool` Promise, so
      // an unanswered approval can only be swept by a backend timer. The process
      // arms a per-approval TTL that (a) sends the harness a deny so the turn
      // unblocks and (b) calls this back so the DB row + audit mirror Codex.
      approvalRequestTtlMs: this.config.APPROVAL_REQUEST_TTL_MS,
      onApprovalExpired: (approvalId) =>
        this.handleE2bApprovalExpired({ tenantId, sessionId, userId, approvalId })
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
    return state.e2bProcess.readFile(resolveSandboxWorkspacePath(state.workspacePath, filePath));
  }

  async writeRuntimeFile(
    sessionId: string,
    filePath: string,
    data: Uint8Array | ArrayBuffer | string
  ): Promise<string> {
    const state = this.requireSessionState(sessionId);
    const sandboxPath = resolveSandboxWorkspacePath(state.workspacePath, filePath);
    await state.e2bProcess.writeFile(sandboxPath, data);
    return sandboxPath;
  }

  // Stop button — interrupt the in-flight turn for `sessionId` while leaving
  // the session warm. The shared `state.activeTurnInterrupt` ref sends the
  // sandbox an interrupt frame; the SDK eventually emits a result(subtype=
  // "interrupt") which the event mapper turns into response.completed{
  // interrupted:true}.
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
        { err, sessionId: input.sessionId },
        "Claude interrupt() failed; expecting SDK to surface the result anyway"
      );
    }
    // Drop any approvals that were still pending at interrupt time so the UI
    // doesn't keep showing an approve/reject prompt for a stopped turn and a
    // late decision can't resolve into a turn that no longer exists.
    //   - drop the per-approval entry in `e2bPendingApprovals` so
    //     `resolveApproval` can't try to forward a decision over a torn-down
    //     sandbox bridge (handled inside onCancelLocal below).
    //   - expire the DB rows + emit `approval.expired` audit events via the
    //     shared cleanup helper.
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

    // Drop any e2b approvals outstanding for this session; the sandbox will be
    // killed right after and the deferred Promises would never resolve otherwise.
    for (const [approvalId, sid] of this.e2bPendingApprovals) {
      if (sid === input.sessionId) this.e2bPendingApprovals.delete(approvalId);
    }

    await state.e2bProcess.terminate().catch((err) => {
      this.log.warn({ err, sessionId: input.sessionId }, "Failed to terminate E2B Claude sandbox");
    });

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

    // The backend only has the local staging dir; the sandbox workspace path
    // does not exist on the backend filesystem.
    rm(state.localStagingPath, { recursive: true, force: true }).catch((err: unknown) => {
      this.log.warn(
        { err, sessionId: input.sessionId, cleanupTarget: state.localStagingPath },
        "failed to clean up Claude workspace staging dir"
      );
    });

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

  /**
   * Backend sweep for an e2b approval that aged out. The process has already
   * sent the harness a deny (so the SDK turn unblocks); here we move the DB row
   * off `pending` and write the `approval.expired` audit row so the Claude e2b
   * path matches Codex's `scheduleApprovalExpiry`. Drops the in-memory entry so
   * a late `resolveApproval` can't try to forward to a settled prompt. Fired
   * from a timer — never throws into the caller.
   */
  private handleE2bApprovalExpired(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    approvalId: string;
  }): void {
    const { tenantId, sessionId, userId, approvalId } = input;
    if (!this.stores?.approvals || !this.stores?.auditEvents) {
      // No approvals/audit wiring (opt-out test fixtures): just release memory.
      this.e2bPendingApprovals.delete(approvalId);
      return;
    }
    void expireApprovalById({
      tenantId,
      sessionId,
      userId,
      approvalId,
      reason: "ttl_expired",
      approvals: this.stores.approvals,
      auditEvents: this.stores.auditEvents,
      logger: this.log,
      onCancelLocal: (id) => {
        this.e2bPendingApprovals.delete(id);
        return undefined;
      }
    });
  }

  async resolveApproval(input: {
    tenantId: string;
    approvalId: string;
    userId: string;
    decision: RuntimeApprovalDecision;
    rememberForTurn?: boolean;
  }): Promise<"resolved" | "missing"> {
    const { tenantId, approvalId, userId, decision } = input;
    const decisionStatus = decision === "approve" ? "approve" : "reject";

    // Deliver to the owning live runtime FIRST, and confirm it was actually
    // received, BEFORE settling the shared DB row. Two correctness reasons:
    //  1. Cross-adapter: the production route tries adapters in order (Codex,
    //     then Claude) until one returns "resolved". Forwarding first means a
    //     non-owning adapter returns "missing" WITHOUT flipping the row, so the
    //     real owner (tried next) can still resolve it.
    //  2. e2b: forwarding is async (a stdin frame to the sandbox). Awaiting it
    //     means we never report a decision as resolved (DB approved/rejected +
    //     audit) while the sandbox never actually received it (dead sandbox /
    //     failed write) — in that case the row stays pending for the TTL sweep.
    const forwarded = await this.forwardApprovalDecision(approvalId, tenantId, userId, decision);
    if (!forwarded) return "missing";

    if (this.stores?.approvals) {
      // Atomic once-only guard: ApprovalStore.resolve flips pending→settled a
      // single time. A concurrent double-click, a retried POST, or a row already
      // settled by the TTL sweep returns null — we already delivered to the
      // runtime, so still report "resolved" but skip a duplicate audit row.
      const approval = await this.stores.approvals.resolve(
        tenantId,
        approvalId,
        userId,
        decisionStatus
      );
      if (approval) {
        await this.stores.auditEvents?.create({
          tenantId,
          sessionId: approval.sessionId,
          userId: approval.userId,
          approvalId: approval.approvalId,
          type: decision === "approve" ? "approval.approved" : "approval.rejected",
          payload: { itemId: approval.itemId, kind: approval.kind }
        });
      }
    }
    return "resolved";
  }

  /**
   * Routes an approval decision to the sandbox harness that owns the pending
   * `canUseTool` Promise. Resolves to true when a matching pending approval was
   * found AND the decision was delivered (the stdin write to the sandbox
   * succeeded), false otherwise. Does NOT touch the DB or audit trail; the
   * caller owns that.
   */
  private async forwardApprovalDecision(
    approvalId: string,
    tenantId: string,
    userId: string,
    decision: RuntimeApprovalDecision
  ): Promise<boolean> {
    // The approval Promise lives inside the sandbox harness. Look up the owning
    // session and forward the decision over stdin. The SDK inside the sandbox
    // then resumes the canUseTool handler.
    const e2bSessionId = this.e2bPendingApprovals.get(approvalId);
    if (!e2bSessionId) {
      return false;
    }
    const state = this.sessions.get(e2bSessionId);
    if (!state || state.tenantId !== tenantId || state.userId !== userId) {
      return false;
    }
    // Drop the pending entry synchronously (before the await) so a concurrent
    // double-click can't forward twice. If the stdin write then fails, the
    // decision was NOT delivered — report false so the caller leaves the DB
    // row pending for the TTL sweep instead of falsely auditing it settled.
    this.e2bPendingApprovals.delete(approvalId);
    try {
      await state.e2bProcess.sendApprovalResponse(
        approvalId,
        decision === "approve" ? "approve" : "reject"
      );
      return true;
    } catch (err) {
      this.log.warn(
        { err, approvalId, sessionId: e2bSessionId },
        "Failed to forward approval to E2B sandbox"
      );
      return false;
    }
  }

  private requireSessionState(sessionId: string): ClaudeSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`No Claude Code session found for ${sessionId}`);
    }
    return state;
  }
}
