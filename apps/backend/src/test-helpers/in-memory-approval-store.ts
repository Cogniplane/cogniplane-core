import { vi } from "vitest";

import type { ApprovalRecord, ApprovalStore } from "../services/auth/approval-store.js";

/**
 * An in-memory approvals table with the status transitions of ApprovalStore:
 * resolve only a pending row, remember only on approve, consume an approved
 * row once, and expire only a pending row. Reads and writes are scoped by
 * tenant and user. Expiry time and session access are not checked: those SQL
 * guards run against Postgres in the approval-*.integration tests.
 *
 * Each method is a `vi.fn` spy, so a test can wrap or replace one call.
 * `rows` and `consumed` are the table state that tests read and seed.
 */
export function createInMemoryApprovalStore() {
  const rows = new Map<string, ApprovalRecord>();
  const consumed = new Set<string>();
  const owned = (tenantId: string, approvalId: string, userId: string) => {
    const row = rows.get(approvalId);
    return row?.tenantId === tenantId && row.userId === userId ? row : null;
  };
  return {
    rows,
    consumed,
    create: vi.fn(async (input: Parameters<ApprovalStore["create"]>[0]): Promise<ApprovalRecord> => {
      const now = new Date().toISOString();
      const row: ApprovalRecord = { ...input, createdAt: now, updatedAt: now, resolvedAt: null };
      rows.set(input.approvalId, row);
      return row;
    }),
    get: vi.fn(async (tenantId: string, approvalId: string, userId: string) => owned(tenantId, approvalId, userId)),
    resolve: vi.fn(async (tenantId: string, approvalId: string, userId: string, decision: "approve" | "reject",
      rememberForTurn = false) => {
      const row = owned(tenantId, approvalId, userId);
      if (row?.status !== "pending") return null;
      row.status = decision === "approve" ? "approved" : "rejected";
      row.decision = decision;
      row.rememberForTurn = rememberForTurn && decision === "approve";
      return row;
    }),
    consume: vi.fn(async (tenantId: string, approvalId: string, userId: string) => {
      const row = owned(tenantId, approvalId, userId);
      if (row?.status !== "approved" || row.decision !== "approve" || consumed.has(approvalId)) return false;
      consumed.add(approvalId);
      return true;
    }),
    listPending: vi.fn(async (tenantId: string, sessionId: string, userId: string) => [...rows.values()].filter(
      (row) => row.tenantId === tenantId && row.sessionId === sessionId && row.userId === userId && row.status === "pending")),
    expire: vi.fn(async (tenantId: string, approvalId: string) => {
      const row = rows.get(approvalId);
      if (row?.tenantId !== tenantId || row.status !== "pending") return null;
      row.status = "expired";
      return row;
    })
  };
}
