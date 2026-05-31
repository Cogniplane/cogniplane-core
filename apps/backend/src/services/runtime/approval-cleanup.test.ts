import type { FastifyBaseLogger } from "fastify";
import { test, expect } from "vitest";

import { cancelPendingApprovals, expireApprovalById } from "./approval-cleanup.js";

type FakeApproval = { approvalId: string };

function makeApprovalsFake(opts: {
  pending: FakeApproval[];
  expireResults?: Record<string, FakeApproval | null>;
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
    expire: async (_t: string, approvalId: string): Promise<FakeApproval | null> => {
      expireCalls.push(approvalId);
      if (opts.expireThrows?.has(approvalId)) throw new Error("expire boom");
      if (opts.expireResults && approvalId in opts.expireResults) {
        return opts.expireResults[approvalId];
      }
      return { approvalId };
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

test("happy path: onCancelLocal both releases in-memory state and supplies audit payload extras in one pass", async () => {
  const approvals = makeApprovalsFake({
    pending: [{ approvalId: "a-1" }, { approvalId: "a-2" }]
  });
  const audit = makeAuditFake();
  const localCalls: string[] = [];

  await cancelPendingApprovals({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    reason: "turn_interrupted",
    approvals,
    auditEvents: audit,
    logger: makeLogger(),
    onCancelLocal: (id) => {
      localCalls.push(id);
      return { itemId: `item-${id}`, kind: "command" };
    }
  });

  expect(localCalls).toEqual(["a-1", "a-2"]);
  expect(approvals.expireCalls).toEqual(["a-1", "a-2"]);
  expect(audit.calls).toHaveLength(2);
  expect(audit.calls[0]).toMatchObject({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    approvalId: "a-1",
    type: "approval.expired",
    payload: { itemId: "item-a-1", kind: "command", reason: "turn_interrupted" }
  });
});

test("onCancelLocal returning undefined is fine — audit payload contains only `reason`", async () => {
  const approvals = makeApprovalsFake({ pending: [{ approvalId: "a-only" }] });
  const audit = makeAuditFake();

  await cancelPendingApprovals({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    reason: "turn_interrupted",
    approvals,
    auditEvents: audit,
    logger: makeLogger(),
    onCancelLocal: () => undefined
  });

  expect(audit.calls).toHaveLength(1);
  expect(audit.calls[0]).toMatchObject({
    payload: { reason: "turn_interrupted" }
  });
  // Sanity: nothing else snuck into the payload.
  expect((audit.calls[0] as { payload: Record<string, unknown> }).payload).toEqual({
    reason: "turn_interrupted"
  });
});

test("decision-raced row (expire returns null) skips audit but still ran onCancelLocal", async () => {
  const approvals = makeApprovalsFake({
    pending: [{ approvalId: "a-raced" }],
    expireResults: { "a-raced": null }
  });
  const audit = makeAuditFake();
  const localCalls: string[] = [];

  await cancelPendingApprovals({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    reason: "turn_interrupted",
    approvals,
    auditEvents: audit,
    logger: makeLogger(),
    onCancelLocal: (id) => { localCalls.push(id); }
  });

  expect(localCalls).toEqual(["a-raced"]);
  expect(approvals.expireCalls).toEqual(["a-raced"]);
  expect(audit.calls).toEqual([]);
});

test("onCancelLocal throwing on one approval does not abort cleanup of subsequent rows; failed row gets empty payload extras", async () => {
  const approvals = makeApprovalsFake({
    pending: [{ approvalId: "a-1" }, { approvalId: "a-2" }, { approvalId: "a-3" }]
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
    logger,
    onCancelLocal: (id) => {
      if (id === "a-2") throw new Error("local boom");
      return { itemId: `item-${id}` };
    }
  });

  expect(approvals.expireCalls).toEqual(["a-1", "a-2", "a-3"]);
  expect(audit.calls).toHaveLength(3);
  expect((audit.calls[1] as { payload: Record<string, unknown> }).payload).toEqual({
    reason: "turn_interrupted"
  });
  expect(logger._warnings).toHaveLength(1);
});

test("expireApprovalById: ttl sweep expires the single row, drops in-memory state, and audits with reason ttl_expired", async () => {
  const approvals = makeApprovalsFake({ pending: [{ approvalId: "a-1" }, { approvalId: "a-2" }] });
  const audit = makeAuditFake();
  const dropped: string[] = [];

  await expireApprovalById({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    approvalId: "a-1",
    reason: "ttl_expired",
    approvals,
    auditEvents: audit,
    logger: makeLogger(),
    onCancelLocal: (id) => {
      dropped.push(id);
      return undefined;
    }
  });

  // Only the aged-out row is touched — siblings are left alone.
  expect(approvals.expireCalls).toEqual(["a-1"]);
  expect(dropped).toEqual(["a-1"]);
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

test("expireApprovalById: decision-raced row (expire returns null) skips audit but still released memory", async () => {
  const approvals = makeApprovalsFake({
    pending: [{ approvalId: "a-1" }],
    expireResults: { "a-1": null }
  });
  const audit = makeAuditFake();
  const dropped: string[] = [];

  await expireApprovalById({
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    approvalId: "a-1",
    reason: "ttl_expired",
    approvals,
    auditEvents: audit,
    logger: makeLogger(),
    onCancelLocal: (id) => { dropped.push(id); }
  });

  expect(dropped).toEqual(["a-1"]);
  expect(approvals.expireCalls).toEqual(["a-1"]);
  expect(audit.calls).toEqual([]);
});

test("expireApprovalById: expire throwing is logged, never rejects", async () => {
  const approvals = makeApprovalsFake({
    pending: [{ approvalId: "a-1" }],
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
    logger,
    onCancelLocal: () => undefined
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
