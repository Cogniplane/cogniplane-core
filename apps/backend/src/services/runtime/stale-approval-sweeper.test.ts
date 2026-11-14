import { test, expect } from "vitest";

import type { ApprovalRecord } from "../auth/approval-store.js";
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

// `ApprovalStore.sweepExpired` writes each row's `approval.expired` event in
// the batch's transaction (approval-store.test.ts, and against PostgreSQL in
// approval-sweep.integration.test.ts). These tests cover the batch loop.

test("sweepStaleApprovals stops once a batch returns fewer than the batch size", async () => {
  const swept = [fakeRow({ approvalId: "a", tenantId: "t1" }), fakeRow({ approvalId: "b", tenantId: "t2" })];
  let calls = 0;
  const approvals = {
    sweepExpired: async () => {
      calls += 1;
      return calls === 1 ? swept : [];
    }
  };

  const total = await sweepStaleApprovals({ approvals, logger: createSilentLogger() }, 500);

  expect(total).toBe(2);
  expect(calls).toBe(1);
});

test("sweepStaleApprovals drains multiple full batches", async () => {
  const batch = Array.from({ length: 2 }, (_, i) => fakeRow({ approvalId: `x${i}` }));
  let calls = 0;
  const approvals = {
    // Two full batches of 2, then an empty one.
    sweepExpired: async () => {
      calls += 1;
      return calls <= 2 ? batch : [];
    }
  };

  const total = await sweepStaleApprovals({ approvals, logger: createSilentLogger() }, 2);

  expect(total).toBe(4);
  expect(calls).toBe(3);
});

test("sweepStaleApprovals stops and rejects when a batch fails, so the rows stay for the next sweep", async () => {
  let calls = 0;
  const approvals = {
    sweepExpired: async () => {
      calls += 1;
      throw new Error("audit insert failed");
    }
  };

  await expect(sweepStaleApprovals({ approvals, logger: createSilentLogger() }, 500))
    .rejects.toThrow("audit insert failed");
  expect(calls).toBe(1);
});
