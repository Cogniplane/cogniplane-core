import type { FastifyBaseLogger } from "fastify";

import type {
  PolicyApprovalDisposition,
  RuntimeApprovalDecision,
  RuntimeApprovalKind,
  RuntimeEvent
} from "../../runtime-contracts.js";
import { uuidv7 } from "../../lib/uuid.js";
import type { ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";

// Disposition the MCP gateway uses to allow (`approve`) or refuse
// (`reject`/`expired`) a policy-routed tool call. Single source: runtime-contracts.
export type { PolicyApprovalDisposition };

// The synthetic request method stored on the approvals row for a Policy
// Center–routed approval. Distinguishes these rows from the runtime's native
// shell/file approvals (which carry their JSON-RPC method here).
const POLICY_APPROVAL_METHOD = "policy/requestApproval";

type PendingPolicyApproval = {
  approvalId: string;
  tenantId: string;
  sessionId: string;
  userId: string;
  resolve: (disposition: PolicyApprovalDisposition) => void;
  expiryTimer: NodeJS.Timeout;
  reminderTimer: NodeJS.Timeout | null;
};

export type PolicyApprovalRequest = {
  tenantId: string;
  sessionId: string;
  userId: string;
  runtimeId: string | null;
  toolName: string;
  serverId: string | null;
  kind: RuntimeApprovalKind;
  explanation: string;
};

// Pushes a framework event onto the owning session's active turn. Returns false
// when there is no active turn to receive it (the adapter has no live turn /
// SSE stream for that session right now).
export type PushFrameworkEvent = (sessionId: string, event: RuntimeEvent) => boolean;

/**
 * Holds Policy Center tool-call approvals while the MCP gateway keeps its HTTP
 * response open. Distinct from {@link RuntimeApprovalCoordinator} (the runtime's
 * native shell/file approvals): those pause a JSON-RPC request the runtime owns;
 * these pause the gateway's HTTP turn for an MCP tool call. Both reuse the same
 * ApprovalStore table, TTL/sweep, SSE event type, and `/approvals/:id/decision`
 * route — only the in-memory hold differs.
 *
 * One instance is shared per runtime adapter. The adapter delegates
 * `requestPolicyApproval` (create + await) and consults `resolve` from its
 * `resolveApproval` after a native-approval miss.
 */
export class PolicyApprovalCoordinator {
  private readonly pending = new Map<string, PendingPolicyApproval>();

  constructor(
    private readonly deps: {
      approvals: ApprovalStore;
      auditEvents: AuditEventStore;
      pushFrameworkEvent: PushFrameworkEvent;
      logger: FastifyBaseLogger;
      ttlMs: number;
      // Fraction of the TTL after which a one-shot reminder notice is emitted to
      // the active turn (e.g. 0.5 → halfway). <= 0 or >= 1 disables reminders.
      reminderFraction: number;
    }
  ) {}

  /**
   * Create a pending approval, emit the SSE prompt, and resolve when the human
   * decides or the TTL expires. The returned Promise never rejects — it resolves
   * to `reject`/`expired` so the gateway always gets a clean disposition.
   */
  async request(request: PolicyApprovalRequest): Promise<PolicyApprovalDisposition> {
    const approvalId = `polapr_${uuidv7()}`;
    const expiresAt = new Date(Date.now() + this.deps.ttlMs).toISOString();
    const title = "Approve tool action";
    const summary = request.explanation;

    // Persist the approvals row first so the startup sweep can recover it if the
    // process dies before the in-memory timer fires. requestId is the approvalId
    // (there is no JSON-RPC request id for a gateway-held approval).
    try {
      await this.deps.approvals.create({
        tenantId: request.tenantId,
        approvalId,
        sessionId: request.sessionId,
        userId: request.userId,
        runtimeId: request.runtimeId ?? "",
        turnId: request.sessionId,
        itemId: approvalId,
        requestMethod: POLICY_APPROVAL_METHOD,
        requestId: approvalId,
        kind: request.kind,
        title,
        summary,
        status: "pending",
        decision: null,
        requestPayload: {
          toolName: request.toolName,
          serverId: request.serverId
        },
        expiresAt
      });
    } catch (error) {
      // If we can't persist the approval row we can't reliably resume on
      // decision — fail closed (deny) rather than hang the tool call.
      this.deps.logger.error(
        { err: error, approvalId, sessionId: request.sessionId },
        "policy approval: failed to persist approvals row — denying"
      );
      return "reject";
    }

    await this.createAuditEvent({
      tenantId: request.tenantId,
      sessionId: request.sessionId,
      userId: request.userId,
      approvalId,
      type: "policy.approval.requested",
      payload: { toolName: request.toolName, serverId: request.serverId, kind: request.kind }
    });

    const delivered = this.deps.pushFrameworkEvent(request.sessionId, {
      type: "framework:approval_required",
      responseId: request.sessionId,
      approvalId,
      itemId: approvalId,
      kind: request.kind,
      title,
      summary,
      availableDecisions: ["approve", "reject"],
      command: null,
      cwd: null
    });

    if (!delivered) {
      // No active turn to prompt — there's no human in the loop, so deny and
      // expire the row we just wrote rather than wait out the full TTL.
      this.deps.logger.warn(
        { approvalId, sessionId: request.sessionId },
        "policy approval: no active turn to prompt — denying"
      );
      await this.expireRow(request.tenantId, approvalId);
      return "reject";
    }

    return new Promise<PolicyApprovalDisposition>((resolveFn) => {
      const expiryTimer = setTimeout(() => {
        void this.onExpiry(request.tenantId, approvalId, request.sessionId).catch((err) => {
          this.deps.logger.error({ err, approvalId }, "policy approval expiry failed");
        });
      }, this.deps.ttlMs);

      const reminderTimer = this.scheduleReminder(approvalId, request, title);

      this.pending.set(approvalId, {
        approvalId,
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        userId: request.userId,
        resolve: resolveFn,
        expiryTimer,
        reminderTimer
      });
    });
  }

  /**
   * Settle a pending policy approval from a user decision. Returns "resolved"
   * when this coordinator owned the approval (so the adapter reports the same to
   * the decision route), "missing" otherwise (the adapter falls through).
   */
  async resolve(input: {
    tenantId: string;
    approvalId: string;
    userId: string;
    decision: RuntimeApprovalDecision;
  }): Promise<"resolved" | "missing"> {
    const entry = this.pending.get(input.approvalId);
    if (!entry) return "missing";

    // Atomically flip the DB row. A null means the TTL sweep (or a concurrent
    // decision) already settled it — the in-memory promise was/will be resolved
    // by the expiry path, so report missing and don't double-resolve.
    const approval = await this.deps.approvals.resolve(
      input.tenantId,
      input.approvalId,
      input.userId,
      input.decision
    );
    if (!approval) return "missing";

    this.clearEntry(input.approvalId);

    await this.createAuditEvent({
      tenantId: input.tenantId,
      sessionId: entry.sessionId,
      userId: input.userId,
      approvalId: input.approvalId,
      type: input.decision === "approve" ? "approval.approved" : "approval.rejected",
      payload: { source: "policy" }
    });

    entry.resolve(input.decision === "approve" ? "approve" : "reject");
    return "resolved";
  }

  /** True when this coordinator currently holds the given approval id. */
  has(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  /** Deny every pending approval (used on adapter/session teardown). */
  cancelAll(reason: string): void {
    for (const [approvalId, entry] of this.pending) {
      clearTimeout(entry.expiryTimer);
      if (entry.reminderTimer) clearTimeout(entry.reminderTimer);
      this.deps.logger.warn({ approvalId, reason }, "policy approval cancelled");
      entry.resolve("reject");
    }
    this.pending.clear();
  }

  private scheduleReminder(
    approvalId: string,
    request: PolicyApprovalRequest,
    title: string
  ): NodeJS.Timeout | null {
    const { reminderFraction, ttlMs } = this.deps;
    if (reminderFraction <= 0 || reminderFraction >= 1) return null;
    const delay = Math.floor(ttlMs * reminderFraction);
    if (delay <= 0) return null;
    return setTimeout(() => {
      // Only remind if still pending.
      if (!this.pending.has(approvalId)) return;
      this.deps.pushFrameworkEvent(request.sessionId, {
        type: "framework:runtime_notice",
        responseId: request.sessionId,
        noticeId: `policy-approval-reminder:${approvalId}`,
        level: "info",
        title: "Approval still pending",
        message: `"${title}" is still awaiting a decision and will expire soon.`,
        createdAt: new Date().toISOString()
      });
    }, delay);
  }

  private clearEntry(approvalId: string): PendingPolicyApproval | null {
    const entry = this.pending.get(approvalId);
    if (!entry) return null;
    clearTimeout(entry.expiryTimer);
    if (entry.reminderTimer) clearTimeout(entry.reminderTimer);
    this.pending.delete(approvalId);
    return entry;
  }

  private async onExpiry(tenantId: string, approvalId: string, sessionId: string): Promise<void> {
    // If the entry is already gone, our own resolve() settled it — nothing to do.
    const entry = this.clearEntry(approvalId);
    if (!entry) return;

    // Claim the row atomically. Null means the row was already moved off
    // `pending` — either a user decision (then our resolve() would have removed
    // the entry above, so we wouldn't be here) or, crucially, an EXTERNAL
    // cleanup path: turn interruption / runtime teardown (cancelPendingApprovals)
    // or the DB sweep. Those paths never reach into this coordinator's promise,
    // so we MUST still resolve it here as `expired`; otherwise the gateway's
    // held HTTP response hangs forever. We skip the audit/notice in that case
    // because the external path already wrote its own approval.expired row.
    let expired: Awaited<ReturnType<ApprovalStore["expire"]>> = null;
    try {
      expired = await this.deps.approvals.expire(tenantId, approvalId);
    } catch (error) {
      this.deps.logger.error(
        { err: error, approvalId, sessionId },
        "policy approval expiry failed to update approvals row"
      );
    }
    if (expired) {
      await this.createAuditEvent({
        tenantId,
        sessionId,
        userId: entry.userId,
        approvalId,
        type: "approval.expired",
        payload: { source: "policy" }
      });
      this.deps.pushFrameworkEvent(sessionId, {
        type: "framework:runtime_notice",
        responseId: sessionId,
        noticeId: `policy-approval-expired:${approvalId}`,
        level: "warning",
        title: "Approval request expired",
        message: "The tool action approval timed out and was automatically denied.",
        createdAt: new Date().toISOString()
      });
    }

    // Resolve in both cases (own TTL fired, or row expired out from under us) so
    // the awaiting gateway always gets a disposition.
    entry.resolve("expired");
  }

  private async createAuditEvent(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    approvalId: string;
    type: "policy.approval.requested" | "approval.approved" | "approval.rejected" | "approval.expired";
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.deps.auditEvents.create(input);
    } catch (error) {
      this.deps.logger.warn(
        { err: error, approvalId: input.approvalId, type: input.type },
        "policy approval: failed to create audit event"
      );
    }
  }

  /**
   * Settle a single pending policy approval as denied because an external path
   * (turn interruption / runtime teardown / DB sweep) is expiring its row. Wired
   * into the same `onCancelLocal` hook the native approval cleanup uses, so a
   * policy-held tool call is released immediately instead of waiting out the
   * coordinator's own TTL timer. No-op for ids this coordinator doesn't hold.
   * The caller (cancelPendingApprovals / expireApprovalById) owns the DB row +
   * audit, so this only releases the in-memory promise.
   */
  cancel(approvalId: string): void {
    const entry = this.clearEntry(approvalId);
    if (!entry) return;
    entry.resolve("expired");
  }

  // Best-effort expire of a row whose approval we abandoned before arming timers
  // (no active turn to prompt). Logs but never throws.
  private async expireRow(tenantId: string, approvalId: string): Promise<void> {
    try {
      await this.deps.approvals.expire(tenantId, approvalId);
    } catch (error) {
      this.deps.logger.warn(
        { err: error, approvalId },
        "policy approval: failed to expire abandoned row"
      );
    }
  }
}
