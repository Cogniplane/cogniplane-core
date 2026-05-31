import type { FastifyBaseLogger } from "fastify";

import type { ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";

export type ApprovalCleanupReason = "turn_interrupted" | "ttl_expired" | "runtime_terminated";

export type CancelPendingApprovalsInput = {
  tenantId: string;
  sessionId: string;
  userId: string;
  reason: ApprovalCleanupReason;
  approvals: Pick<ApprovalStore, "listPending" | "expire">;
  auditEvents: Pick<AuditEventStore, "create">;
  logger: Pick<FastifyBaseLogger, "warn" | "error">;
  /**
   * Per-runtime in-memory cleanup. Called once per pending approvalId. Codex
   * unblocks the JSON-RPC request and drops its in-memory map entry; Claude
   * drops its e2b-pending map entry. The return value (if any) is merged
   * into the `approval.expired` audit payload — pass `{ itemId, kind }` or
   * similar from the in-memory record while it is still in scope. Throws
   * are logged but never abort the loop.
   *
   * Note on audit-payload field names: `audit_events.payload` flows through
   * `redactSecrets` at the store layer (see audit-event-store.ts). Keys
   * matching SECRET_KEY_PATTERN (authorization/token/secret/api_key/password)
   * will be redacted to "[REDACTED]". The fields used here today
   * (itemId/kind/reason) are safe; new payload keys must avoid those patterns.
   */
  onCancelLocal?: (approvalId: string) => Record<string, unknown> | undefined;
};

/**
 * Drop every pending approval for `sessionId` in a way that is safe to call
 * from any runtime adapter. Used when a turn is interrupted: leaving rows in
 * `status='pending'` would let the UI keep showing approve/reject prompts
 * for a turn that no longer exists, and a late decision would resolve into
 * a torn-down JSON-RPC request.
 *
 * Behavior, in order, per pending approval:
 *   1. Run `onCancelLocal(approvalId)` to release in-memory state and capture
 *      audit-payload extras in one pass — Codex drops its pendingApprovals
 *      entry, unblocks the JSON-RPC request, and returns `{itemId, kind}`;
 *      Claude drops its e2bPendingApprovals entry and returns nothing.
 *   2. Atomically `expire` the DB row. If it returns null (the user's
 *      decision committed first) skip the audit event — that decision will
 *      have its own audit row.
 *   3. Emit one `approval.expired` audit row carrying `{ reason, ...extras }`.
 *
 * Best-effort: every step is wrapped in try/log so a single failing approval
 * cannot block the cleanup of others. Caller is expected to `void` the
 * returned promise — callers should not block on cleanup before responding.
 */
/**
 * Expire a SINGLE pending approval by id. Used by the Claude e2b path when the
 * per-approval wall-clock TTL fires (the in-sandbox harness has already been
 * sent a deny so the SDK turn unblocks): the DB row must move off `pending` and
 * an `approval.expired` audit row must be written, mirroring Codex's TTL sweep.
 * Unlike `cancelPendingApprovals` this does NOT touch the other approvals in the
 * session — only the one that aged out.
 *
 * Best-effort: every step is wrapped in try/log. If `expire` returns null the
 * user's decision committed first, so the audit row is skipped.
 */
export async function expireApprovalById(input: {
  tenantId: string;
  sessionId: string;
  userId: string;
  approvalId: string;
  reason: ApprovalCleanupReason;
  approvals: Pick<ApprovalStore, "expire">;
  auditEvents: Pick<AuditEventStore, "create">;
  logger: Pick<FastifyBaseLogger, "warn" | "error">;
  /** Release in-memory state (e.g. drop the e2bPendingApprovals entry). */
  onCancelLocal?: (approvalId: string) => Record<string, unknown> | undefined;
}): Promise<void> {
  const { tenantId, sessionId, userId, approvalId, reason, approvals, auditEvents, logger } = input;

  let payloadExtras: Record<string, unknown> = {};
  try {
    payloadExtras = input.onCancelLocal?.(approvalId) ?? {};
  } catch (err) {
    logger.warn(
      { err, approvalId, sessionId, reason },
      "onCancelLocal threw during approval expiry; continuing with empty payload"
    );
  }

  try {
    const expired = await approvals.expire(tenantId, approvalId);
    if (!expired) return;

    await auditEvents.create({
      tenantId,
      sessionId,
      userId,
      approvalId,
      type: "approval.expired",
      payload: { ...payloadExtras, reason }
    });
  } catch (err) {
    logger.error(
      { err, approvalId, sessionId, reason },
      "Failed to expire approval on TTL"
    );
  }
}

export async function cancelPendingApprovals(input: CancelPendingApprovalsInput): Promise<void> {
  const { tenantId, sessionId, userId, reason, approvals, auditEvents, logger } = input;

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
    const { approvalId } = row;

    let payloadExtras: Record<string, unknown> = {};
    try {
      payloadExtras = input.onCancelLocal?.(approvalId) ?? {};
    } catch (err) {
      logger.warn(
        { err, approvalId, sessionId, reason },
        "onCancelLocal threw during approval cleanup; continuing with empty payload"
      );
    }

    try {
      const expired = await approvals.expire(tenantId, approvalId);
      if (!expired) continue;

      await auditEvents.create({
        tenantId,
        sessionId,
        userId,
        approvalId,
        type: "approval.expired",
        payload: { ...payloadExtras, reason }
      });
    } catch (err) {
      logger.error(
        { err, approvalId, sessionId, reason },
        "Failed to expire approval during cleanup"
      );
    }
  }
}
