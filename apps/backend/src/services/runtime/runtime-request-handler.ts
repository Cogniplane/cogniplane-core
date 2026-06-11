import type { FastifyBaseLogger } from "fastify";

import type { JsonRpcRequest } from "./codex-jsonrpc.js";
import {
  buildApprovalRequest,
  type PendingApprovalRecord,
  respondToApprovalRequest
} from "./runtime-approval-coordinator.js";
import type { RuntimeState } from "./runtime-types.js";
import type { ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";

const MAX_PENDING_APPROVALS_PER_SESSION = 5;

export async function handleRuntimeRequest(input: {
  tenantId: string;
  runtime: RuntimeState;
  request: JsonRpcRequest;
  approvals: ApprovalStore;
  auditEvents: AuditEventStore;
  approvalTtlMs: number;
  logger: FastifyBaseLogger;
}): Promise<void> {
  const { runtime, request } = input;

  // Codex 0.120+ sends mcpServer/elicitation/request to ask whether to proceed
  // with an MCP tool call. Auto-approve these — actual authorization is enforced
  // at the MCP route level (runtime policy, tool enablement, token scope).
  if (request.method === "mcpServer/elicitation/request") {
    runtime.process.sendResponse(request.id, { action: "accept" });
    return;
  }

  // Scope turn-carrying approval requests to the turn that owns the queue —
  // the request-side mirror of the notification guard in the orchestrator.
  // After an interrupt the slot is freed before Codex acknowledges
  // turn/interrupt, so a late requestApproval from the canceled turn would
  // otherwise be persisted and prompted on the NEXT turn — letting the user
  // approve an action they meant to cancel. Reject it so the dying turn
  // unblocks with a denial. Requests without a turnId pass through unscoped.
  const requestTurnId =
    typeof request.params?.turnId === "string" ? request.params.turnId : null;
  if (
    requestTurnId &&
    (runtime.staleTurnIds.has(requestTurnId) ||
      (runtime.activeTurn?.responseId && requestTurnId !== runtime.activeTurn.responseId))
  ) {
    input.logger.warn(
      {
        sessionId: runtime.sessionId,
        method: request.method,
        requestTurnId,
        activeTurnId: runtime.activeTurn?.responseId ?? null
      },
      "rejecting approval request from non-active turn"
    );
    const stale = buildApprovalRequest(runtime, request);
    if (stale) {
      respondToApprovalRequest(runtime.process, stale.pending as PendingApprovalRecord, "reject");
    } else {
      runtime.process.sendError(request.id, -32000, "Turn is no longer active.");
    }
    return;
  }

  const activeTurn = runtime.activeTurn;
  if (!activeTurn) {
    runtime.process.sendError(request.id, -32000, "No active turn is available.");
    return;
  }

  if (runtime.pendingApprovals.size >= MAX_PENDING_APPROVALS_PER_SESSION) {
    runtime.process.sendError(
      request.id,
      -32000,
      `Approval rate limit reached: at most ${MAX_PENDING_APPROVALS_PER_SESSION} approvals may be pending per session at once.`
    );
    return;
  }

  const approval = buildApprovalRequest(runtime, request);
  if (!approval) {
    runtime.process.sendError(request.id, -32601, `Unsupported request method ${request.method}.`);
    return;
  }

  // If the user already approved this kind for the current turn, auto-approve
  // without surfacing another prompt or writing a DB row.
  // Claude equivalent: autoApprovedKindsForTurn check in claude-turn-executor.ts — keep both in sync.
  if (activeTurn.autoApprovedKinds.has(approval.kind)) {
    respondToApprovalRequest(runtime.process, approval.pending as PendingApprovalRecord, "approve");
    return;
  }

  // Persist the row BEFORE arming the in-memory entry/timer. The row is the
  // durable anchor every decision resolves against — if it can't be written,
  // an armed entry could never be settled by a user and would leak a pending
  // slot while Codex waits on an unanswerable request. Deny instead.
  try {
    await input.approvals.create({
      tenantId: input.tenantId,
      approvalId: approval.approvalId,
      sessionId: runtime.sessionId,
      userId: runtime.userId,
      runtimeId: runtime.runtimeId,
      turnId: approval.turnId,
      itemId: approval.itemId,
      requestMethod: request.method,
      requestId: String(request.id),
      kind: approval.kind,
      title: approval.title,
      summary: approval.summary,
      status: "pending",
      decision: null,
      requestPayload: approval.requestPayload,
      // DB-level deadline mirroring the in-process TTL timer below, so a crash
      // before the timer fires still lets the startup sweep recover this row.
      expiresAt: new Date(Date.now() + input.approvalTtlMs).toISOString()
    });
  } catch (error) {
    respondToApprovalRequest(runtime.process, approval.pending as PendingApprovalRecord, "reject");
    throw error;
  }

  // The turn may have been interrupted or torn down while the row write was in
  // flight — its cleanup ran before this entry was armed and could not see it.
  // Don't arm an approval against a dead turn (a pending slot leaked until TTL,
  // a prompt pushed onto a closed queue): deny and expire the row we just wrote.
  if (runtime.activeTurn !== activeTurn) {
    respondToApprovalRequest(runtime.process, approval.pending as PendingApprovalRecord, "reject");
    try {
      await input.approvals.expire(input.tenantId, approval.approvalId);
    } catch (error) {
      input.logger.warn(
        { err: error, approvalId: approval.approvalId, sessionId: runtime.sessionId },
        "failed to expire approval row created for a turn that ended mid-write"
      );
    }
    return;
  }

  runtime.pendingApprovals.set(approval.approvalId, approval.pending as PendingApprovalRecord);
  scheduleApprovalExpiry({
    runtime,
    approvalId: approval.approvalId,
    tenantId: input.tenantId,
    ttlMs: input.approvalTtlMs,
    approvals: input.approvals,
    auditEvents: input.auditEvents,
    logger: input.logger
  });

  await input.auditEvents.create({
    tenantId: input.tenantId,
    sessionId: runtime.sessionId,
    userId: runtime.userId,
    approvalId: approval.approvalId,
    type: "approval.requested",
    payload: {
      kind: approval.kind,
      itemId: approval.itemId,
      title: approval.title
    }
  });

  activeTurn.queue.push({
    type: "framework:approval_required",
    responseId: activeTurn.responseId ?? approval.turnId,
    approvalId: approval.approvalId,
    itemId: approval.itemId,
    kind: approval.kind,
    title: approval.title,
    summary: approval.summary,
    availableDecisions: ["approve", "reject"],
    command: approval.command,
    cwd: approval.cwd
  });
}

export function clearApprovalExpiry(runtime: RuntimeState, approvalId: string): void {
  const timer = runtime.pendingApprovalTimers.get(approvalId);
  if (timer) {
    clearTimeout(timer);
    runtime.pendingApprovalTimers.delete(approvalId);
  }
}

export function clearAllApprovalExpiries(runtime: RuntimeState): void {
  for (const timer of runtime.pendingApprovalTimers.values()) {
    clearTimeout(timer);
  }
  runtime.pendingApprovalTimers.clear();
}

function scheduleApprovalExpiry(input: {
  runtime: RuntimeState;
  approvalId: string;
  tenantId: string;
  ttlMs: number;
  approvals: ApprovalStore;
  auditEvents: AuditEventStore;
  logger: FastifyBaseLogger;
}): void {
  const { runtime, approvalId, ttlMs } = input;
  const timer = setTimeout(() => {
    void expireApproval(input).catch((err) => {
      input.logger.error({ err, approvalId, sessionId: runtime.sessionId }, "approval expiry failed");
    });
  }, ttlMs);
  runtime.pendingApprovalTimers.set(approvalId, timer);
}

async function expireApproval(input: {
  runtime: RuntimeState;
  approvalId: string;
  tenantId: string;
  approvals: ApprovalStore;
  auditEvents: AuditEventStore;
  logger: FastifyBaseLogger;
}): Promise<void> {
  const { runtime, approvalId, tenantId } = input;

  // Claim the in-memory entry synchronously BEFORE any await. A user decision
  // (`resolveApproval`) claims the same entry synchronously before its own DB
  // write, so whoever holds the entry owns answering the JSON-RPC request —
  // there is no window where both paths respond. `pending` can be missing if
  // the runtime was torn down or a decision won; nothing left to message then.
  const pending = runtime.pendingApprovals.get(approvalId);
  runtime.pendingApprovals.delete(approvalId);
  runtime.pendingApprovalTimers.delete(approvalId);
  if (!pending) return;

  // Unblock the codex process first: synthesize a "reject" so the JSON-RPC
  // request returns even if the row update below fails or finds no row (the
  // row may have been expired by the cross-replica sweep, or never persisted).
  respondToApprovalRequest(runtime.process, pending, "reject");

  let expired: Awaited<ReturnType<ApprovalStore["expire"]>> = null;
  try {
    expired = await input.approvals.expire(tenantId, approvalId);
  } catch (error) {
    input.logger.error(
      { err: error, approvalId, sessionId: runtime.sessionId },
      "approval expiry failed to update approvals row"
    );
  }
  // Row already settled externally (sweep / teardown) or never written — the
  // external owner wrote its own audit trail, so only ours gets one here.
  if (expired) {
    await input.auditEvents.create({
      tenantId,
      sessionId: runtime.sessionId,
      userId: runtime.userId,
      approvalId,
      type: "approval.expired",
      payload: { itemId: pending.itemId, kind: pending.kind }
    });
  }

  const activeTurn = runtime.activeTurn;
  if (activeTurn) {
    activeTurn.queue.push({
      type: "framework:runtime_notice",
      responseId: activeTurn.responseId ?? pending.itemId,
      noticeId: `approval-expired:${approvalId}`,
      level: "warning",
      title: "Approval request expired",
      message: "The approval request timed out and was automatically rejected.",
      createdAt: new Date().toISOString()
    });
  }
}
