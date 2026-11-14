import type { FastifyBaseLogger } from "fastify";
import { test, expect } from "vitest";

import type { ApprovalRecord } from "../auth/approval-store.js";
import { cancelPendingApprovals, expireApprovalById } from "./approval-cleanup.js";

function makeApproval(approvalId: string): ApprovalRecord {
  return {
    approvalId,
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    runtimeId: "rt",
    turnId: "turn",
    itemId: `item-${approvalId}`,
    requestMethod: "tools/call",
    requestId: `request-${approvalId}`,
    kind: "mcp_tool",
    title: "Approve tool call",
    summary: "Test approval",
    status: "pending",
    decision: null,
    requestPayload: {},
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
    resolvedAt: null,
    expiresAt: "2026-09-04T12:10:00.000Z"
  };
}

/**
 * A fake ApprovalStore. `expire` stands for the store's transaction: it
 * records the expired row and its `approval.expired` reason together, or
 * neither when it throws.
 */
function makeApprovalsFake(opts: {
  pending: ApprovalRecord[];
  expireResults?: Record<string, ApprovalRecord | null>;
  listPendingThrows?: Error;
  expireThrows?: Set<string>;
}) {
  const expireCalls: Array<{ approvalId: string; reason: string }> = [];
  return {
    expireCalls,
    listPending: async (_t: string, _s: string, _u: string) => {
      if (opts.listPendingThrows) throw opts.listPendingThrows;
      return opts.pending;
    },
    expire: async (_t: string, approvalId: string, reason: string): Promise<ApprovalRecord | null> => {
      if (opts.expireThrows?.has(approvalId)) throw new Error("expire boom");
      expireCalls.push({ approvalId, reason });
      if (opts.expireResults && approvalId in opts.expireResults) {
        return opts.expireResults[approvalId];
      }
      return makeApproval(approvalId);
    }
  };
}

function makeLogger() {
  const warn: unknown[][] = [];
  const error: unknown[][] = [];
  return {
    warn: ((...args: unknown[]) => warn.push(args)) as unknown as FastifyBaseLogger["warn"],
    error: ((...args: unknown[]) => error.push(args)) as unknown as FastifyBaseLogger["error"],
    _warnings: warn,
    _errors: error
  };
}

const scope = { tenantId: "t", sessionId: "s", userId: "u" };

test("empty pending list issues no expire", async () => {
  const approvals = makeApprovalsFake({ pending: [] });
  await cancelPendingApprovals({ ...scope, reason: "turn_interrupted", approvals, logger: makeLogger() });
  expect(approvals.expireCalls).toEqual([]);
});

test("happy path: expires each pending row with only the reason", async () => {
  const approvals = makeApprovalsFake({ pending: [makeApproval("a-1"), makeApproval("a-2")] });
  await cancelPendingApprovals({ ...scope, reason: "turn_interrupted", approvals, logger: makeLogger() });
  expect(approvals.expireCalls).toEqual([
    { approvalId: "a-1", reason: "turn_interrupted" },
    { approvalId: "a-2", reason: "turn_interrupted" }
  ]);
});

test("runtime teardown expires only the rows of its runtime", async () => {
  const other = { ...makeApproval("a-other"), runtimeId: "rt-2" };
  const approvals = makeApprovalsFake({ pending: [makeApproval("a-1"), other] });
  await cancelPendingApprovals({ ...scope, runtimeId: "rt", reason: "runtime_terminated", approvals, logger: makeLogger() });
  expect(approvals.expireCalls).toEqual([{ approvalId: "a-1", reason: "runtime_terminated" }]);
});

test("expireApprovalById: ttl sweep expires the single row with reason ttl_expired", async () => {
  const approvals = makeApprovalsFake({ pending: [makeApproval("a-1"), makeApproval("a-2")] });
  await expireApprovalById({ ...scope, approvalId: "a-1", reason: "ttl_expired", approvals, logger: makeLogger() });
  // Only the aged-out row is touched. Siblings are left alone.
  expect(approvals.expireCalls).toEqual([{ approvalId: "a-1", reason: "ttl_expired" }]);
});

test("expireApprovalById: a decision-raced row (expire returns null) is not an error", async () => {
  const approvals = makeApprovalsFake({ pending: [makeApproval("a-1")], expireResults: { "a-1": null } });
  const logger = makeLogger();
  await expireApprovalById({ ...scope, approvalId: "a-1", reason: "ttl_expired", approvals, logger });
  expect(logger._errors).toEqual([]);
});

test("expireApprovalById: expire throwing (for example a failed audit insert) is logged, never rejects", async () => {
  const approvals = makeApprovalsFake({ pending: [makeApproval("a-1")], expireThrows: new Set(["a-1"]) });
  const logger = makeLogger();
  await expireApprovalById({ ...scope, approvalId: "a-1", reason: "ttl_expired", approvals, logger });
  expect(approvals.expireCalls).toEqual([]);
  expect(logger._errors).toHaveLength(1);
});

test("one failing row does not stop the cleanup of the others", async () => {
  const approvals = makeApprovalsFake({
    pending: [makeApproval("a-1"), makeApproval("a-2")],
    expireThrows: new Set(["a-1"])
  });
  const logger = makeLogger();
  await cancelPendingApprovals({ ...scope, reason: "turn_interrupted", approvals, logger });
  expect(approvals.expireCalls).toEqual([{ approvalId: "a-2", reason: "turn_interrupted" }]);
  expect(logger._errors).toHaveLength(1);
});

test("listPending failure logs and returns; no expire", async () => {
  const approvals = makeApprovalsFake({ pending: [], listPendingThrows: new Error("db down") });
  const logger = makeLogger();
  await cancelPendingApprovals({ ...scope, reason: "turn_interrupted", approvals, logger });
  expect(approvals.expireCalls).toEqual([]);
  expect(logger._warnings).toHaveLength(1);
});
