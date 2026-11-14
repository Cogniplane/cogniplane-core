import type { FastifyBaseLogger } from "fastify";

import type { ApprovalStore } from "../auth/approval-store.js";

export type ApprovalCleanupReason = "turn_interrupted" | "turn_abandoned" | "ttl_expired" | "runtime_terminated";

export type CancelPendingApprovalsInput = {
  tenantId: string;
  sessionId: string;
  userId: string;
  /** Limit runtime teardown to rows owned by the terminating runtime. */
  runtimeId?: string;
  reason: ApprovalCleanupReason;
  approvals: Pick<ApprovalStore, "listPending" | "expire">;
  logger: Pick<FastifyBaseLogger, "warn" | "error">;
};

/**
 * Expire a SINGLE pending approval by id. Used when a per-approval wall-clock
 * TTL fires or a turn ends (the coordinator has already settled its local
 * wait): the DB row must move off `pending`. `ApprovalStore.expire` writes
 * the `approval.expired` audit row in the same transaction.
 * Unlike `cancelPendingApprovals` this does NOT touch the other approvals in the
 * session — only the one that aged out.
 *
 * Best-effort: a failure is logged. The row then stays `pending` with no
 * audit row, and the stale-approval sweep expires it after `expires_at`. If
 * `expire` returns null, the user's decision committed first.
 */
export async function expireApprovalById(input: {
  tenantId: string;
  sessionId: string;
  userId: string;
  approvalId: string;
  reason: ApprovalCleanupReason;
  approvals: Pick<ApprovalStore, "expire">;
  logger: Pick<FastifyBaseLogger, "warn" | "error">;
}): Promise<void> {
  const { sessionId, approvalId, reason, approvals, logger } = input;

  try {
    await approvals.expire(input.tenantId, approvalId, reason);
  } catch (err) {
    logger.error(
      { err, approvalId, sessionId, reason },
      "Failed to expire approval on TTL"
    );
  }
}

/**
 * Expire pending approvals for a session, optionally limited to one runtime.
 * Turn cleanup uses captured approval IDs instead. Leaving rows in
 * `status='pending'` would let the UI keep showing approve/reject prompts
 * for a turn that no longer exists, and a late decision would resolve into
 * a torn-down turn.
 *
 * This function does not touch in-memory waits. The coordinator releases the
 * local waits of the matching turns before it calls this function. A wait of another
 * runtime on the same row sees `expired` at its next poll.
 *
 * Per pending approval, `expireApprovalById` expires the row and writes one
 * `approval.expired` audit row carrying `{ reason }`, in one transaction. If
 * the user's decision committed first, nothing changes: that decision has its
 * own audit row.
 *
 * Best-effort: every step is wrapped in try/log so a single failing approval
 * cannot block the cleanup of others. Caller is expected to `void` the
 * returned promise — callers should not block on cleanup before responding.
 */
export async function cancelPendingApprovals(input: CancelPendingApprovalsInput): Promise<void> {
  const { tenantId, sessionId, userId, reason, approvals, logger } = input;

  let pendingRows;
  try {
    pendingRows = await approvals.listPending(tenantId, sessionId, userId);
  } catch (err) {
    logger.warn(
      { err, sessionId, reason },
      "Failed to enumerate pending approvals during cleanup"
    );
    return;
  }

  for (const row of pendingRows) {
    if (input.runtimeId !== undefined && row.runtimeId !== input.runtimeId) continue;
    await expireApprovalById({
      tenantId,
      sessionId,
      userId,
      approvalId: row.approvalId,
      reason,
      approvals,
      logger
    });
  }
}
