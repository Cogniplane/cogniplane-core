import { vi } from "vitest";

import type { ApprovalRecord, ApprovalStore } from "../services/auth/approval-store.js";
import type { AuditEventInput } from "../services/audit-event-store.js";

/**
 * An in-memory approvals table with the status transitions of ApprovalStore:
 * resolve only a pending row, remember only on approve, consume an approved
 * row once, expire only a pending row, and read a saved decision only from an
 * approved or rejected row. Reads and writes are scoped by tenant and user.
 * Expiry time and session access are not checked: those SQL guards run
 * against Postgres in the approval-*.integration tests.
 *
 * Each method is a `vi.fn` spy, so a test can wrap or replace one call.
 * `rows` and `consumed` are the table state that tests read and seed.
 *
 * `audit` stands for the audit insert that `resolve`, `expire` and
 * `sweepExpired` make in their transaction. When it throws, the status change
 * is undone and the error goes to the caller, as a rollback would do.
 */
export function createInMemoryApprovalStore() {
  const rows = new Map<string, ApprovalRecord>();
  const consumed = new Set<string>();
  const owned = (tenantId: string, approvalId: string, userId: string) => {
    const row = rows.get(approvalId);
    return row?.tenantId === tenantId && row.userId === userId ? row : null;
  };
  const audit = vi.fn(async (_event: AuditEventInput) => {});
  const changeStatus = async (row: ApprovalRecord, change: Partial<ApprovalRecord>, event: AuditEventInput) => {
    const before = { ...row };
    Object.assign(row, change);
    try {
      await audit(event);
    } catch (error) {
      Object.assign(row, before);
      throw error;
    }
    return row;
  };
  const eventOf = (row: ApprovalRecord, type: AuditEventInput["type"], payload: Record<string, unknown>): AuditEventInput => ({
    tenantId: row.tenantId, sessionId: row.sessionId, userId: row.userId, approvalId: row.approvalId, type, payload
  });
  return {
    rows,
    consumed,
    audit,
    create: vi.fn(async (input: Parameters<ApprovalStore["create"]>[0]): Promise<ApprovalRecord> => {
      const now = new Date().toISOString();
      const row: ApprovalRecord = { ...input, createdAt: now, updatedAt: now, resolvedAt: null };
      rows.set(input.approvalId, row);
      return row;
    }),
    get: vi.fn(async (tenantId: string, approvalId: string, userId: string) => owned(tenantId, approvalId, userId)),
    getDecided: vi.fn(async (tenantId: string, approvalId: string, userId: string) => {
      const row = owned(tenantId, approvalId, userId);
      const decided = (row?.status === "approved" && row.decision === "approve") ||
        (row?.status === "rejected" && row.decision === "reject");
      return decided ? row : null;
    }),
    resolve: vi.fn(async (tenantId: string, approvalId: string, userId: string, decision: "approve" | "reject",
      rememberForTurn = false) => {
      const row = owned(tenantId, approvalId, userId);
      if (row?.status !== "pending") return null;
      return changeStatus(row, {
        status: decision === "approve" ? "approved" : "rejected",
        decision,
        rememberForTurn: rememberForTurn && decision === "approve"
      }, eventOf(row, decision === "approve" ? "approval.approved" : "approval.rejected",
        { itemId: row.itemId, kind: row.kind }));
    }),
    consume: vi.fn(async (tenantId: string, approvalId: string, userId: string) => {
      const row = owned(tenantId, approvalId, userId);
      if (row?.status !== "approved" || row.decision !== "approve" || consumed.has(approvalId)) return false;
      consumed.add(approvalId);
      return true;
    }),
    listPending: vi.fn(async (tenantId: string, sessionId: string, userId: string) => [...rows.values()].filter(
      (row) => row.tenantId === tenantId && row.sessionId === sessionId && row.userId === userId && row.status === "pending")),
    expire: vi.fn(async (tenantId: string, approvalId: string, reason: string) => {
      const row = rows.get(approvalId);
      if (row?.tenantId !== tenantId || row.status !== "pending") return null;
      return changeStatus(row, { status: "expired" }, eventOf(row, "approval.expired", { reason }));
    })
  };
}
