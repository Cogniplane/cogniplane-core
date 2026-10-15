import type { FastifyBaseLogger } from "fastify";
import type { CustomEventValue } from "@cogniplane/shared-types";

import { uuidv7 } from "../../lib/uuid.js";
import type { ApprovalKind, ApprovalRecord, ApprovalStatus, ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import {
  POLICY_APPROVAL_REQUEST_METHOD,
  type PolicyApprovalProof
} from "../policy/policy-approval-proof.js";
import { redactSecrets } from "../redact-secrets.js";
import { cancelPendingApprovals, expireApprovalById, type ApprovalCleanupReason } from "./approval-cleanup.js";
import { approvalPresentation } from "./approval-presentation.js";

export type ApprovalOutcome = "approve" | "reject" | "expired" | "unavailable";
export type ApprovalActor = { tenantId: string; userId: string };
export type ApprovalIdentity = ApprovalActor & {
  sessionId: string; runtimeId: string; turnId: string;
};
export type ApprovalRequest = {
  name: string; kind: ApprovalKind; args: Record<string, unknown>; policyApproval?: PolicyApprovalProof;
  server?: { id: string; mode: "managed" | "proxy" };
  /**
   * For a tool that saves durable data: the card text that shows the exact value, and
   * server facts that the write checks later. They are stored beside the approval row.
   */
  durableWrite?: { title: string; summary: string; bound: Record<string, unknown> };
};
export type ApprovalPublication =
  | { name: "approval_required"; value: CustomEventValue<"approval_required"> }
  | { name: "runtime_notice"; value: CustomEventValue<"runtime_notice"> };
export type ApprovalTurnOptions = {
  identity: ApprovalIdentity;
  projectId: string | null;
  durableNative: boolean;
  signal: AbortSignal;
  hasLocalActor: (actor: ApprovalActor) => boolean;
  validateLocalDecision: (actor: ApprovalActor) => Promise<void>;
};
/** Sends the request's card and notices to the run that asked for approval. */
export type ApprovalPublish = (notice: ApprovalPublication) => void;
export type ApprovalTurn = {
  request: (action: ApprovalRequest, publish: ApprovalPublish) => Promise<ApprovalOutcome>;
  cancelLocal: () => void;
  cancelAndExpire: (reason: ApprovalCleanupReason) => void;
};
// A turn is open while it is in `ApprovalCoordinator.turns`. Its waits are
// the `pending` entries whose `turn` is this turn.
type TurnState = ApprovalTurnOptions & { remembered: Set<string>; persisted: Set<string> };
type PendingApproval = {
  turn: TurnState;
  requiresDurableProof: boolean;
  rememberApproval: () => void;
  settle: (outcome: ApprovalOutcome) => void;
};
const STORED_OUTCOME: Partial<Record<ApprovalStatus, ApprovalOutcome>> = {
  approved: "approve", rejected: "reject", expired: "expired"
};

export class ApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly turns = new Set<TurnState>();
  private closed = false;

  constructor(private readonly deps: {
    approvals: Pick<ApprovalStore, "get" | "create" | "resolve" | "listPending" | "expire">;
    auditEvents: Pick<AuditEventStore, "create">;
    logger: Pick<FastifyBaseLogger, "debug" | "warn" | "error">;
    ttlMs: number;
  }) {}

  openTurn(options: ApprovalTurnOptions): ApprovalTurn {
    const turn: TurnState = {
      ...options, identity: { ...options.identity }, remembered: new Set(), persisted: new Set()
    };
    if (!this.closed) this.turns.add(turn);
    return {
      request: (action, publish) => this.request(turn, action, publish),
      cancelLocal: () => this.cancelTurn(turn),
      cancelAndExpire: (reason) => this.cancelAndExpireTurn(turn, reason)
    };
  }

  async decide(input: ApprovalActor & {
    approvalId: string; decision: "approve" | "reject"; rememberForTurn?: boolean;
  }): Promise<"resolved" | "missing"> {
    const { tenantId, approvalId, userId, decision, rememberForTurn } = input;
    const actor = { tenantId, userId };
    const entry = this.pending.get(approvalId);
    if (entry) {
      const { turn } = entry;
      if (turn.identity.tenantId !== tenantId || turn.identity.userId !== userId ||
          !turn.hasLocalActor(actor)) return "missing";
      try { await turn.validateLocalDecision(actor); } catch { return "missing"; }
    }
    if (entry && !entry.requiresDurableProof) {
      if (!entry.turn.hasLocalActor(actor)) return "missing";
      if (rememberForTurn && decision === "approve") entry.rememberApproval();
      entry.settle(decision);
      try {
        const approval = await this.deps.approvals.resolve(tenantId, approvalId, userId, decision,
          rememberForTurn === true);
        if (approval) await this.auditDecision(tenantId, approval, decision);
      } catch (err) {
        this.deps.logger.error({ err, approvalId, tenantId }, "failed to persist native approval decision");
      }
      return "resolved";
    }

    // Durable authority must commit before a local wait can resume.
    let approval: ApprovalRecord | null;
    try {
      approval = await this.deps.approvals.resolve(tenantId, approvalId, userId, decision,
        rememberForTurn === true);
    } catch (err) {
      this.deps.logger.error({ err, approvalId, tenantId }, "failed to persist approval decision");
      throw err;
    }
    if (!approval) return "missing";
    if (entry && entry.turn.hasLocalActor(actor)) {
      if (rememberForTurn && decision === "approve") entry.rememberApproval();
      entry.settle(decision);
    }
    try {
      await this.auditDecision(tenantId, approval, decision);
    } catch (err) {
      this.deps.logger.warn({ err, approvalId }, "failed to write approval decision audit event");
    }
    return "resolved";
  }

  private async auditDecision(tenantId: string, approval: ApprovalRecord, decision: "approve" | "reject"): Promise<void> {
    await this.deps.auditEvents.create({
      tenantId, sessionId: approval.sessionId, userId: approval.userId,
      approvalId: approval.approvalId, type: decision === "approve" ? "approval.approved" : "approval.rejected",
      payload: { itemId: approval.itemId, kind: approval.kind }
    });
  }

  cancelPending(scope: ApprovalActor & { sessionId: string; runtimeId: string }, reason: ApprovalCleanupReason): Promise<void> {
    for (const turn of this.turns) {
      if (turn.identity.tenantId === scope.tenantId && turn.identity.userId === scope.userId &&
          turn.identity.sessionId === scope.sessionId && turn.identity.runtimeId === scope.runtimeId)
        this.cancelAndExpireTurn(turn, reason);
    }
    return cancelPendingApprovals({ ...scope, reason, ...this.deps });
  }

  close(): void {
    this.closed = true;
    for (const turn of this.turns) this.cancelTurn(turn);
  }

  private cancelTurn(turn: TurnState): void {
    if (!this.turns.delete(turn)) return;
    for (const entry of [...this.pending.values()]) {
      if (entry.turn === turn) entry.settle("reject");
    }
  }

  private cancelAndExpireTurn(turn: TurnState, reason: ApprovalCleanupReason): void {
    // Keep persisted IDs after local abort settlement. A later turn can start
    // before these writes finish, so cleanup must never enumerate its rows.
    const approvalIds = [...turn.persisted];
    turn.persisted.clear();
    this.cancelTurn(turn);
    for (const approvalId of approvalIds) this.expire(turn, approvalId, reason);
  }

  private ended(turn: TurnState): boolean {
    return !this.turns.has(turn) || turn.signal.aborted;
  }

  private expire(turn: TurnState, approvalId: string, reason: ApprovalCleanupReason): void {
    void expireApprovalById({
      ...turn.identity, approvalId, reason, ...this.deps
    });
  }

  private async request(turn: TurnState, action: ApprovalRequest, publish: ApprovalPublish): Promise<ApprovalOutcome> {
    if (this.ended(turn)) return "reject";
    const { identity, signal } = turn;
    const { name, kind } = action;
    // Per tool: a remembered write or read must not approve `delete`.
    const rememberKey = `${kind}:${name}`;
    if (!action.policyApproval && turn.remembered.has(rememberKey)) {
      try {
        await this.deps.auditEvents.create({
          ...identity, approvalId: null, type: "approval.auto_approved", payload: { toolName: name, kind }
        });
      } catch (err) {
        this.deps.logger.warn({ err, toolName: name }, "Failed to write auto-approval audit event");
      }
      return "approve";
    }

    const approvalId = action.policyApproval?.approvalId ?? `daapr_${uuidv7()}`;
    const redactedArgs = redactSecrets(action.args);
    let approval = action.policyApproval
      ? await this.deps.approvals.get(identity.tenantId, approvalId, identity.userId)
      : null;
    const replayed = approval && STORED_OUTCOME[approval.status];
    if (replayed) return replayed;
    try {
      if (!approval) {
        const { title, summary } = action.durableWrite ?? approvalPresentation(action, turn.projectId);
        approval = await this.deps.approvals.create({
          ...identity, approvalId, itemId: approvalId,
          requestMethod: action.policyApproval ? POLICY_APPROVAL_REQUEST_METHOD : `deepagents/${name}`,
          requestId: approvalId, kind, title, summary,
          status: "pending", decision: null,
          // `bound` is set after the arguments, so a model cannot supply its own.
          requestPayload: action.policyApproval
            ? { ...redactedArgs, policyApproval: action.policyApproval, bound: action.durableWrite?.bound }
            : redactedArgs,
          expiresAt: new Date(Date.now() + this.deps.ttlMs).toISOString()
        });
      }
    } catch (err) {
      if (action.policyApproval) {
        approval = await this.deps.approvals.get(identity.tenantId, approvalId, identity.userId);
        const winner = approval && STORED_OUTCOME[approval.status];
        if (winner) return winner;
      }
      if (approval?.status === "pending") {
        this.deps.logger.debug({ approvalId }, "Reusing checkpointed Policy Center approval");
      } else {
        this.deps.logger.error({ err, approvalId, sessionId: identity.sessionId, toolName: name },
          "Failed to persist approval request; denying");
        publish({ name: "runtime_notice", value: {
          noticeId: `approval-unavailable:${approvalId}`, level: "warning", title: "Approval unavailable",
          message: `The approval request for ${name} could not be recorded, so it was denied.`,
          createdAt: new Date().toISOString()
        } });
        return "unavailable";
      }
    }

    turn.persisted.add(approvalId);
    if (this.ended(turn)) {
      this.expire(turn, approvalId, "turn_interrupted");
      return "reject";
    }
    try {
      publish({ name: "approval_required", value: {
        approvalId, itemId: approvalId, kind, title: approval.title, summary: approval.summary,
        availableDecisions: ["approve", "reject"],
        command: name === "execute" && typeof action.args.command === "string" ? action.args.command : name,
        cwd: null
      } });
    } catch (err) {
      this.deps.logger.error({ err, approvalId }, "Failed to publish approval request; denying");
      this.expire(turn, approvalId, "turn_abandoned");
      return "unavailable";
    }
    if (this.ended(turn)) {
      this.expire(turn, approvalId, "turn_interrupted");
      return "reject";
    }

    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: ApprovalOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(ttlTimer);
        if (pollTimer) clearTimeout(pollTimer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(approvalId);
        resolve(outcome);
      };
      const rememberApproval = () => {
        if (!settled && !this.ended(turn)) turn.remembered.add(rememberKey);
      };
      const onAbort = () => settle("reject");
      const remainingTtlMs = Math.max(0,
        new Date(approval?.expiresAt ?? Date.now() + this.deps.ttlMs).getTime() - Date.now());
      const ttlTimer = setTimeout(() => {
        this.expire(turn, approvalId, "ttl_expired");
        try {
          publish({ name: "runtime_notice", value: {
            noticeId: `approval-expired:${approvalId}`, level: "warning", title: "Approval expired",
            message: `The approval request for ${name} expired without an answer.`,
            createdAt: new Date().toISOString()
          } });
        } catch (err) {
          this.deps.logger.warn({ err, approvalId }, "Failed to publish approval expiry notice");
        } finally {
          settle("expired");
        }
      }, remainingTtlMs);
      ttlTimer.unref?.();
      let pollDelayMs = 1_000;
      const poll = () => {
        if (settled) return;
        void this.deps.approvals.get(identity.tenantId, approvalId, identity.userId)
          .then((row) => {
            const outcome = row && STORED_OUTCOME[row.status];
            if (settled || this.ended(turn) || !outcome) return;
            if (outcome === "approve" && row.rememberForTurn) rememberApproval();
            settle(outcome);
          })
          .catch((err) => this.deps.logger.warn({ err, approvalId }, "Failed to poll approval status"))
          .finally(() => {
            if (settled) return;
            pollDelayMs = Math.min(pollDelayMs * 2, 8_000);
            pollTimer = setTimeout(poll, pollDelayMs);
            pollTimer.unref?.();
          });
      };
      pollTimer = setTimeout(poll, pollDelayMs);
      pollTimer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(approvalId, {
        turn,
        requiresDurableProof: Boolean(action.policyApproval || turn.durableNative), rememberApproval, settle
      });
    });
  }
}
