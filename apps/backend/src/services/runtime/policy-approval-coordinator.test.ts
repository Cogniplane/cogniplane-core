import { test, expect, vi, beforeEach, afterEach } from "vitest";

import type { RuntimeEvent } from "../../runtime-contracts.js";
import type { ApprovalRecord, ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";

import { PolicyApprovalCoordinator } from "./policy-approval-coordinator.js";

// Minimal status-aware approvals fake: create inserts a pending row, resolve and
// expire flip it once (subsequent calls return null), matching the real store's
// once-only semantics that the coordinator relies on.
class FakeApprovals {
  readonly rows = new Map<string, ApprovalRecord>();
  createCalls = 0;
  failCreate = false;

  async create(input: Omit<ApprovalRecord, "createdAt" | "updatedAt" | "resolvedAt">): Promise<ApprovalRecord> {
    this.createCalls += 1;
    if (this.failCreate) throw new Error("approvals table unwritable");
    const row: ApprovalRecord = {
      ...input,
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-05-31T00:00:00.000Z",
      resolvedAt: null
    };
    this.rows.set(input.approvalId, row);
    return row;
  }

  async resolve(
    _tenantId: string,
    approvalId: string,
    _userId: string,
    decision: "approve" | "reject"
  ): Promise<ApprovalRecord | null> {
    const row = this.rows.get(approvalId);
    if (!row || row.status !== "pending") return null;
    row.status = decision === "approve" ? "approved" : "rejected";
    row.decision = decision;
    return row;
  }

  async expire(_tenantId: string, approvalId: string): Promise<ApprovalRecord | null> {
    const row = this.rows.get(approvalId);
    if (!row || row.status !== "pending") return null;
    row.status = "expired";
    return row;
  }
}

class FakeAudit {
  readonly events: { type: string; payload: Record<string, unknown> }[] = [];
  failCreate = false;
  async create(event: { type: string; payload?: Record<string, unknown> }): Promise<void> {
    if (this.failCreate) throw new Error("audit table unwritable");
    this.events.push({ type: event.type, payload: event.payload ?? {} });
  }
}

function build(opts: { ttlMs?: number; reminderFraction?: number; deliver?: boolean } = {}) {
  const approvals = new FakeApprovals();
  const audit = new FakeAudit();
  const pushed: { sessionId: string; event: RuntimeEvent }[] = [];
  const deliver = opts.deliver ?? true;
  const coordinator = new PolicyApprovalCoordinator({
    approvals: approvals as unknown as ApprovalStore,
    auditEvents: audit as unknown as AuditEventStore,
    logger: createSilentLogger(),
    ttlMs: opts.ttlMs ?? 10_000,
    reminderFraction: opts.reminderFraction ?? 0.5,
    pushFrameworkEvent: (sessionId, event) => {
      pushed.push({ sessionId, event });
      return deliver;
    }
  });
  return { coordinator, approvals, audit, pushed };
}

const baseRequest = {
  tenantId: "t1",
  sessionId: "s1",
  userId: "u1",
  runtimeId: "r1",
  toolName: "github_write_file",
  serverId: "github",
  kind: "file_change" as const,
  explanation: "Routed for approval by policy."
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("request → approve resolves the held promise with 'approve'", async () => {
  const { coordinator, approvals, audit, pushed } = build();
  const promise = coordinator.request(baseRequest);
  // Let the create + push run.
  await vi.advanceTimersByTimeAsync(0);

  // The SSE prompt was emitted and a pending row written.
  expect(pushed[0].event.type).toBe("framework:approval_required");
  expect(approvals.createCalls).toBe(1);
  const approvalId = (pushed[0].event as { approvalId: string }).approvalId;
  expect(coordinator.has(approvalId)).toBe(true);
  expect(audit.events[0].type).toBe("policy.approval.requested");

  const resolved = await coordinator.resolve({
    tenantId: "t1",
    approvalId,
    userId: "u1",
    decision: "approve"
  });
  expect(resolved).toBe("resolved");
  await expect(promise).resolves.toBe("approve");
  expect(coordinator.has(approvalId)).toBe(false);
  expect(audit.events.some((e) => e.type === "approval.approved")).toBe(true);
});

test("request → reject resolves with 'reject'", async () => {
  const { coordinator, pushed } = build();
  const promise = coordinator.request(baseRequest);
  await vi.advanceTimersByTimeAsync(0);
  const approvalId = (pushed[0].event as { approvalId: string }).approvalId;

  await coordinator.resolve({ tenantId: "t1", approvalId, userId: "u1", decision: "reject" });
  await expect(promise).resolves.toBe("reject");
});

test("resolve for an unknown approval id returns 'missing'", async () => {
  const { coordinator } = build();
  const result = await coordinator.resolve({
    tenantId: "t1",
    approvalId: "does-not-exist",
    userId: "u1",
    decision: "approve"
  });
  expect(result).toBe("missing");
});

test("TTL expiry resolves with 'expired', expires the row, and notifies the turn", async () => {
  const { coordinator, approvals, audit, pushed } = build({ ttlMs: 10_000, reminderFraction: 0 });
  const promise = coordinator.request(baseRequest);
  await vi.advanceTimersByTimeAsync(0);
  const approvalId = (pushed[0].event as { approvalId: string }).approvalId;

  await vi.advanceTimersByTimeAsync(10_000);
  await expect(promise).resolves.toBe("expired");
  expect(approvals.rows.get(approvalId)?.status).toBe("expired");
  expect(audit.events.some((e) => e.type === "approval.expired")).toBe(true);
  // A warning notice was pushed to the turn.
  expect(pushed.some((p) => p.event.type === "framework:runtime_notice")).toBe(true);
});

test("a decision after the TTL fired does not double-resolve", async () => {
  const { coordinator, pushed } = build({ ttlMs: 10_000, reminderFraction: 0 });
  const promise = coordinator.request(baseRequest);
  await vi.advanceTimersByTimeAsync(0);
  const approvalId = (pushed[0].event as { approvalId: string }).approvalId;

  await vi.advanceTimersByTimeAsync(10_000);
  await expect(promise).resolves.toBe("expired");

  // Late decision: row already expired → resolve reports missing, no throw.
  const late = await coordinator.resolve({ tenantId: "t1", approvalId, userId: "u1", decision: "approve" });
  expect(late).toBe("missing");
});

test("a reminder notice is emitted at the configured fraction of the TTL", async () => {
  const { coordinator, pushed } = build({ ttlMs: 10_000, reminderFraction: 0.5 });
  void coordinator.request(baseRequest);
  await vi.advanceTimersByTimeAsync(0);

  // Before the halfway point: no reminder yet.
  await vi.advanceTimersByTimeAsync(4_999);
  expect(pushed.some((p) => p.event.type === "framework:runtime_notice")).toBe(false);

  // At halfway: reminder fires.
  await vi.advanceTimersByTimeAsync(2);
  const reminder = pushed.find(
    (p) => p.event.type === "framework:runtime_notice" && (p.event as { noticeId: string }).noticeId.startsWith("policy-approval-reminder:")
  );
  expect(reminder).toBeDefined();
});

test("when the prompt can't be delivered (no active turn) it denies and expires the row", async () => {
  const { coordinator, approvals } = build({ deliver: false });
  const result = await coordinator.request(baseRequest);
  expect(result).toBe("reject");
  // The row we wrote is expired rather than left pending.
  const [row] = [...approvals.rows.values()];
  expect(row.status).toBe("expired");
});

test("when the approvals row can't be persisted it fails closed (deny)", async () => {
  const { coordinator, approvals, pushed } = build();
  approvals.failCreate = true;
  const result = await coordinator.request(baseRequest);
  expect(result).toBe("reject");
  // No prompt emitted since we never got past persistence.
  expect(pushed).toHaveLength(0);
});

test("request still prompts when audit persistence fails after the approval row is created", async () => {
  const { coordinator, audit, pushed } = build();
  audit.failCreate = true;

  const promise = coordinator.request(baseRequest);
  await vi.advanceTimersByTimeAsync(0);

  expect(pushed[0].event.type).toBe("framework:approval_required");
  const approvalId = (pushed[0].event as { approvalId: string }).approvalId;
  await coordinator.resolve({ tenantId: "t1", approvalId, userId: "u1", decision: "approve" });
  await expect(promise).resolves.toBe("approve");
});

test("resolve settles the held promise even when decision audit persistence fails", async () => {
  const { coordinator, audit, pushed } = build();
  const promise = coordinator.request(baseRequest);
  await vi.advanceTimersByTimeAsync(0);
  const approvalId = (pushed[0].event as { approvalId: string }).approvalId;

  audit.failCreate = true;
  await expect(
    coordinator.resolve({ tenantId: "t1", approvalId, userId: "u1", decision: "approve" })
  ).resolves.toBe("resolved");
  await expect(promise).resolves.toBe("approve");
});

test("TTL expiry settles the held promise even when the row update fails", async () => {
  const { coordinator, approvals, pushed } = build({ ttlMs: 10_000, reminderFraction: 0 });
  const promise = coordinator.request(baseRequest);
  await vi.advanceTimersByTimeAsync(0);
  const approvalId = (pushed[0].event as { approvalId: string }).approvalId;
  const originalExpire = approvals.expire.bind(approvals);
  approvals.expire = async () => {
    throw new Error("approval table unavailable");
  };

  await vi.advanceTimersByTimeAsync(10_000);
  await expect(promise).resolves.toBe("expired");
  expect(approvals.rows.get(approvalId)?.status).toBe("pending");
  approvals.expire = originalExpire;
});

test("cancel() resolves a held approval as 'expired' (external teardown path)", async () => {
  const { coordinator, pushed } = build();
  const promise = coordinator.request(baseRequest);
  await vi.advanceTimersByTimeAsync(0);
  const approvalId = (pushed[0].event as { approvalId: string }).approvalId;

  // Simulate cancelPendingApprovals / interrupt calling into the coordinator.
  coordinator.cancel(approvalId);
  await expect(promise).resolves.toBe("expired");
  expect(coordinator.has(approvalId)).toBe(false);
  // cancel() for an unknown id is a harmless no-op.
  expect(() => coordinator.cancel("nope")).not.toThrow();
});

test("an externally-expired row still resolves the held promise on the TTL tick (no hang)", async () => {
  // Regression for the P1 hang: a cleanup path (cancelPendingApprovals / sweep)
  // moves the row to 'expired' WITHOUT calling cancel(). The coordinator's own
  // TTL timer then fires, sees expire() return null, and must still resolve the
  // awaiting promise instead of silently dropping it.
  const { coordinator, approvals, audit, pushed } = build({ ttlMs: 10_000, reminderFraction: 0 });
  const promise = coordinator.request(baseRequest);
  await vi.advanceTimersByTimeAsync(0);
  const approvalId = (pushed[0].event as { approvalId: string }).approvalId;

  // External path flips the row to expired behind the coordinator's back.
  const row = approvals.rows.get(approvalId)!;
  row.status = "expired";
  const auditCountBefore = audit.events.length;

  // The coordinator's TTL fires; expire() returns null (already expired), but
  // the promise must still resolve.
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(promise).resolves.toBe("expired");
  // No duplicate audit/notice — the external path owns those for its row.
  expect(audit.events.length).toBe(auditCountBefore);
});

test("cancelAll denies every pending approval", async () => {
  const { coordinator, pushed } = build();
  const p1 = coordinator.request(baseRequest);
  await vi.advanceTimersByTimeAsync(0);
  const p2 = coordinator.request({ ...baseRequest, sessionId: "s2" });
  await vi.advanceTimersByTimeAsync(0);
  expect(pushed.length).toBeGreaterThanOrEqual(2);

  coordinator.cancelAll("session torn down");
  await expect(p1).resolves.toBe("reject");
  await expect(p2).resolves.toBe("reject");
});
