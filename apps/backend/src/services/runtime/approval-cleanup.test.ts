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

function makeApprovalsFake(opts: {
  pending: ApprovalRecord[];
  expireResults?: Record<string, ApprovalRecord | null>;
  listPendingThrows?: Error;
  expireThrows?: Set<string>;
}) {
  const expireCalls: string[] = [];
  return {
    expireCalls,
    listPending: async (_t: string, _s: string, _u: string) => {
      if (opts.listPendingThrows) throw opts.listPendingThrows;
      return opts.pending;
    },
    expire: async (_t: string, approvalId: string): Promise<ApprovalRecord | null> => {
      expireCalls.push(approvalId);
      if (opts.expireThrows?.has(approvalId)) throw new Error("expire boom");
      if (opts.expireResults && approvalId in opts.expireResults) {
        return opts.expireResults[approvalId];
      }
      return makeApproval(approvalId);
    }
  };
}

function makeAuditFake() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    create: async (input: Record<string, unknown>) => {
      calls.push(input);
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

test("empty pending list issues no expire and no audit", async () => {
  const approvals = makeApprovalsFake({ pending: [] });
  const audit = makeAuditFake();

  await cancelPendingApprovals({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    reason: "turn_interrupted",
    approvals,
    auditEvents: audit,
    logger: makeLogger()
  });

  expect(approvals.expireCalls).toEqual([]);
  expect(audit.calls).toEqual([]);
});

test("happy path: expires each pending row and audits it with only the reason", async () => {
  const approvals = makeApprovalsFake({
    pending: [makeApproval("a-1"), makeApproval("a-2")]
  });
  const audit = makeAuditFake();

  await cancelPendingApprovals({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    reason: "turn_interrupted",
    approvals,
    auditEvents: audit,
    logger: makeLogger()
  });

  expect(approvals.expireCalls).toEqual(["a-1", "a-2"]);
  expect(audit.calls).toHaveLength(2);
  expect(audit.calls[0]).toMatchObject({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    approvalId: "a-1",
    type: "approval.expired"
  });
  expect((audit.calls[0] as { payload: Record<string, unknown> }).payload).toEqual({
    reason: "turn_interrupted"
  });
});

test("decision-raced row (expire returns null) skips audit", async () => {
  const approvals = makeApprovalsFake({
    pending: [makeApproval("a-raced")],
    expireResults: { "a-raced": null }
  });
  const audit = makeAuditFake();

  await cancelPendingApprovals({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    reason: "turn_interrupted",
    approvals,
    auditEvents: audit,
    logger: makeLogger()
  });

  expect(approvals.expireCalls).toEqual(["a-raced"]);
  expect(audit.calls).toEqual([]);
});

test("expireApprovalById: ttl sweep expires the single row and audits with reason ttl_expired", async () => {
  const approvals = makeApprovalsFake({ pending: [makeApproval("a-1"), makeApproval("a-2")] });
  const audit = makeAuditFake();

  await expireApprovalById({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    approvalId: "a-1",
    reason: "ttl_expired",
    approvals,
    auditEvents: audit,
    logger: makeLogger()
  });

  // Only the aged-out row is touched. Siblings are left alone.
  expect(approvals.expireCalls).toEqual(["a-1"]);
  expect(audit.calls).toHaveLength(1);
  expect(audit.calls[0]).toMatchObject({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    approvalId: "a-1",
    type: "approval.expired",
    payload: { reason: "ttl_expired" }
  });
});

test("expireApprovalById: decision-raced row (expire returns null) skips audit", async () => {
  const approvals = makeApprovalsFake({
    pending: [makeApproval("a-1")],
    expireResults: { "a-1": null }
  });
  const audit = makeAuditFake();

  await expireApprovalById({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    approvalId: "a-1",
    reason: "ttl_expired",
    approvals,
    auditEvents: audit,
    logger: makeLogger()
  });

  expect(approvals.expireCalls).toEqual(["a-1"]);
  expect(audit.calls).toEqual([]);
});

test("expireApprovalById: expire throwing is logged, never rejects", async () => {
  const approvals = makeApprovalsFake({
    pending: [makeApproval("a-1")],
    expireThrows: new Set(["a-1"])
  });
  const audit = makeAuditFake();
  const logger = makeLogger();

  await expireApprovalById({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    approvalId: "a-1",
    reason: "ttl_expired",
    approvals,
    auditEvents: audit,
    logger
  });

  expect(audit.calls).toEqual([]);
  expect(logger._errors).toHaveLength(1);
});

test("listPending failure logs and returns; no expire, no audit", async () => {
  const approvals = makeApprovalsFake({
    pending: [],
    listPendingThrows: new Error("db down")
  });
  const audit = makeAuditFake();
  const logger = makeLogger();

  await cancelPendingApprovals({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    reason: "turn_interrupted",
    approvals,
    auditEvents: audit,
    logger
  });

  expect(approvals.expireCalls).toEqual([]);
  expect(audit.calls).toEqual([]);
  expect(logger._warnings).toHaveLength(1);
});
