import type { FastifyBaseLogger } from "fastify";

import type { JsonRpcRequest } from "./codex-runtime-process.js";
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
  // Claude equivalent: ClaudeApprovalHandler.autoApprovedKindsForTurn in claude-code-approval-handler.ts — keep both in sync.
  if (activeTurn.autoApprovedKinds.has(approval.kind)) {
    respondToApprovalRequest(runtime.process, approval.pending as PendingApprovalRecord, "approve");
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
    requestPayload: approval.requestPayload
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

  // Claim the DB row first. `approvals.expire` is atomic on `status='pending'`,
  // so if the user's decision committed first we get null here and must NOT
  // touch in-memory pending state or message the runtime — otherwise an
  // already-approved tool call would be rejected to the process while the DB
  // shows `approved`.
  const expired = await input.approvals.expire(tenantId, approvalId);
  if (!expired) return;

  const pending = runtime.pendingApprovals.get(approvalId);
  runtime.pendingApprovals.delete(approvalId);
  runtime.pendingApprovalTimers.delete(approvalId);
  // `pending` can be missing if the runtime was torn down between scheduling
  // and firing; the DB row is already expired, nothing left to message.
  if (!pending) return;

  // Unblock the codex process: synthesize a "reject" so the JSON-RPC request returns.
  respondToApprovalRequest(runtime.process, pending, "reject");

  await input.auditEvents.create({
    tenantId,
    sessionId: runtime.sessionId,
    userId: runtime.userId,
    approvalId,
    type: "approval.expired",
    payload: { itemId: pending.itemId, kind: pending.kind }
  });

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
