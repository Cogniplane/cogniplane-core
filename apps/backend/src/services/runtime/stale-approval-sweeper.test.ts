import { test, expect } from "vitest";

import type { ApprovalRecord } from "../auth/approval-store.js";
import { InMemoryAuditEventStore } from "../../test-helpers/in-memory-audit-events.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { sweepStaleApprovals } from "./stale-approval-sweeper.js";

function fakeRow(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalId: "ap-1",
    tenantId: "tenant-1",
    sessionId: "session-1",
    userId: "user-1",
    runtimeId: "runtime-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestMethod: "tool/exec",
    requestId: "req-1",
    kind: "command_execution",
    title: "Run cmd",
    summary: "ls",
    status: "expired",
    decision: null,
    requestPayload: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    ...overrides
  };
}

test("sweepStaleApprovals writes one approval.expired audit event per swept row", async () => {
  const audit = new InMemoryAuditEventStore();
  const swept = [fakeRow({ approvalId: "a", tenantId: "t1" }), fakeRow({ approvalId: "b", tenantId: "t2" })];
  let calls = 0;
  const approvals = {
    sweepExpired: async () => {
      calls += 1;
      return calls === 1 ? swept : [];
    }
  };

  const total = await sweepStaleApprovals(
    { approvals, auditEvents: audit, logger: createSilentLogger() },
    500
  );

  expect(total).toBe(2);
  expect(audit.events).toHaveLength(2);
  expect(audit.events.every((e) => e.type === "approval.expired")).toBe(true);
  expect(audit.events[0].payload).toMatchObject({ reason: "stale_on_sweep" });
  // Loop stops once a batch returns fewer than the batch size.
  expect(calls).toBe(1);
});

test("sweepStaleApprovals drains multiple full batches", async () => {
  const audit = new InMemoryAuditEventStore();
  const batch = Array.from({ length: 2 }, (_, i) => fakeRow({ approvalId: `x${i}` }));
  let calls = 0;
  const approvals = {
    // Two full batches of 2, then an empty one.
    sweepExpired: async () => {
      calls += 1;
      return calls <= 2 ? batch : [];
    }
  };

  const total = await sweepStaleApprovals(
    { approvals, auditEvents: audit, logger: createSilentLogger() },
    2
  );

  expect(total).toBe(4);
  expect(calls).toBe(3);
});

test("sweepStaleApprovals continues past a failed audit write", async () => {
  let failed = false;
  const audit = {
    create: async () => {
      if (!failed) {
        failed = true;
        throw new Error("audit down");
      }
    }
  };
  const approvals = {
    sweepExpired: async (limit: number) =>
      // one short batch (< limit) so the loop terminates after a single pass
      limit > 1 ? [fakeRow({ approvalId: "a" }), fakeRow({ approvalId: "b" })] : []
  };

  const total = await sweepStaleApprovals(
    { approvals, auditEvents: audit, logger: createSilentLogger() },
    500
  );

  // Both rows counted even though the first audit write threw.
  expect(total).toBe(2);
});
