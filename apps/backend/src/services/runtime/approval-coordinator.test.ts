import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryApprovalStore } from "../../test-helpers/in-memory-approval-store.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import type { AuditEventStore } from "../audit-event-store.js";
import { createPolicyApprovalProof } from "../policy/policy-approval-proof.js";
import { ApprovalCoordinator, type ApprovalPublication, type ApprovalRequest, type ApprovalTurnOptions } from "./approval-coordinator.js";

const identity = { tenantId: "tenant-1", userId: "user-1", sessionId: "session-1", runtimeId: "runtime-1", turnId: "turn-1" };
const action = { name: "execute", kind: "command_execution" as const, args: { command: "pwd" } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
function setup() {
  const approvals = createInMemoryApprovalStore();
  const { rows } = approvals;
  const auditEvents = { create: vi.fn(async (_input: Parameters<AuditEventStore["create"]>[0]) => null as never) };
  const coordinator = new ApprovalCoordinator({ approvals, auditEvents, logger: createSilentLogger(), ttlMs: 60_000 });
  const controller = new AbortController();
  const published: ApprovalPublication[] = [];
  const hasActor = vi.fn(() => true);
  const validate = vi.fn(async () => {});
  const options: ApprovalTurnOptions = {
    identity, projectId: null, signal: controller.signal, durableNative: false,
    hasLocalActor: hasActor, validateLocalDecision: validate
  };
  const publish = (notice: ApprovalPublication) => { published.push(notice); };
  return { rows, approvals, auditEvents, coordinator, controller, published, publish, options, hasActor, validate };
}

afterEach(() => { vi.useRealTimers(); });

describe("approval request ownership", () => {
  it("expires only captured turn IDs after abort, even when cleanup writes finish in a later turn", async () => {
    const f = setup();
    const expiry = deferred();
    const expire = f.approvals.expire.getMockImplementation()!;
    f.approvals.expire.mockImplementation(async (...args) => { await expiry.promise; return expire(...args); });
    const first = f.coordinator.openTurn(f.options);
    const oldWait = first.request(action, f.publish);
    await flush();
    const oldId = [...f.rows.keys()][0]!;
    f.controller.abort();
    await expect(oldWait).resolves.toBe("reject");
    first.cancelAndExpire("turn_interrupted");
    const next = f.coordinator.openTurn({ ...f.options, identity: { ...identity, turnId: "turn-2" },
      signal: new AbortController().signal });
    const nextWait = next.request(action, f.publish);
    try {
      await flush();
      const nextId = [...f.rows.keys()].find((id) => id !== oldId)!;
      expiry.resolve();
      await flush();
      expect(f.approvals.listPending).not.toHaveBeenCalled();
      expect(f.rows.get(oldId)?.status).toBe("expired");
      expect(f.rows.get(nextId)?.status).toBe("pending");
      await expect(f.coordinator.decide({ ...identity, approvalId: nextId, decision: "approve" })).resolves.toBe("resolved");
      await expect(nextWait).resolves.toBe("approve");
    } finally { expiry.resolve(); f.coordinator.close(); await nextWait; }
  });

  it("captures reused policy rows even when their stored turn differs from the interrupted turn", async () => {
    const f = setup();
    const proof = createPolicyApprovalProof({ ...identity, toolContextId: "original-context", toolCallId: "call-1",
      toolName: action.name, serverId: "managed", args: action.args, ruleId: null, explanation: "Review" });
    const original = f.coordinator.openTurn(f.options);
    const first = original.request({ ...action, policyApproval: proof }, f.publish);
    await flush();
    original.cancelLocal();
    await first;
    const replay = f.coordinator.openTurn({ ...f.options, identity: { ...identity, turnId: "replay-turn" } });
    const replayWait = replay.request({ ...action, policyApproval: proof }, f.publish);
    await flush();
    expect(f.rows.get(proof.approvalId)?.turnId).toBe(identity.turnId);
    replay.cancelAndExpire("turn_interrupted");
    await expect(replayWait).resolves.toBe("reject");
    await flush();
    expect(f.rows.get(proof.approvalId)?.status).toBe("expired");
    f.coordinator.close();
  });

  it("limits delayed runtime enumeration to the terminated runtime", async () => {
    const f = setup();
    const enumeration = deferred();
    const listPending = f.approvals.listPending.getMockImplementation()!;
    f.approvals.listPending.mockImplementation(async (...args) => { await enumeration.promise; return listPending(...args); });
    const first = f.coordinator.openTurn(f.options);
    const oldWait = first.request(action, f.publish);
    await flush();
    const oldId = [...f.rows.keys()][0]!;
    const cleanup = f.coordinator.cancelPending(identity, "runtime_terminated");
    await expect(oldWait).resolves.toBe("reject");
    const next = f.coordinator.openTurn({ ...f.options, identity: { ...identity, runtimeId: "runtime-2", turnId: "turn-2" },
      signal: new AbortController().signal });
    const nextWait = next.request(action, f.publish);
    try {
      await flush();
      const nextId = [...f.rows.keys()].find((id) => id !== oldId)!;
      enumeration.resolve();
      await cleanup;
      expect(f.rows.get(oldId)?.status).toBe("expired");
      expect(f.rows.get(nextId)?.status).toBe("pending");
      await expect(f.coordinator.decide({ ...identity, approvalId: nextId, decision: "approve" })).resolves.toBe("resolved");
      await expect(nextWait).resolves.toBe("approve");
    } finally { enumeration.resolve(); f.coordinator.close(); await nextWait; }
  });

  it.each(["abort", "turn close", "coordinator close"] as const)(
    "does not install a wait when %s occurs during request persistence", async (end) => {
      vi.useFakeTimers();
      const f = setup();
      const write = deferred();
      const create = f.approvals.create.getMockImplementation()!;
      f.approvals.create.mockImplementation(async (input) => { await write.promise; return create(input); });
      const turn = f.coordinator.openTurn(f.options);
      const outcome = turn.request(action, f.publish);
      expect(f.approvals.create).toHaveBeenCalledOnce();
      if (end === "abort") f.controller.abort();
      else if (end === "turn close") turn.cancelLocal();
      else f.coordinator.close();
      write.resolve();
      await expect(outcome).resolves.toBe("reject");
      await flush();
      expect([...f.rows.values()]).toMatchObject([{ status: "expired" }]);
      expect(f.published).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      turn.cancelLocal();
      f.coordinator.close();
    }
  );

  it("expires a persisted request and returns unavailable when card publication throws", async () => {
    vi.useFakeTimers();
    const f = setup();
    const publish = vi.fn(() => { throw new Error("sink closed"); });
    const turn = f.coordinator.openTurn(f.options);
    await expect(turn.request(action, publish)).resolves.toBe("unavailable");
    await flush();
    const row = [...f.rows.values()][0]!;
    expect(row.status).toBe("expired");
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" })).resolves.toBe("missing");
    expect(publish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    f.coordinator.close();
  });

  it("settles timer expiry even when its notice cannot be published", async () => {
    vi.useFakeTimers();
    const f = setup();
    const turn = f.coordinator.openTurn(f.options);
    const outcome = turn.request(action, (notice) => {
      if (notice.name === "runtime_notice") throw new Error("notice sink closed");
      f.published.push(notice);
    });
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(outcome).resolves.toBe("expired");
    const row = [...f.rows.values()][0]!;
    expect(row.status).toBe("expired");
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" })).resolves.toBe("missing");
    expect(vi.getTimerCount()).toBe(0);
    f.coordinator.close();
  });

  it("retries failed and pending reads with capped backoff and keeps remote remember in its turn", async () => {
    vi.useFakeTimers();
    const f = setup();
    const reads: number[] = [];
    const base = Date.now();
    const get = f.approvals.get.getMockImplementation()!;
    f.approvals.get.mockImplementation(async (...args) => {
      reads.push(Date.now() - base);
      if (reads.length === 1) throw new Error("read failed");
      return get(...args);
    });
    const turn = f.coordinator.openTurn(f.options);
    const outcome = turn.request(action, f.publish);
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reads).toEqual([1_000, 3_000, 7_000, 15_000]);
    const row = [...f.rows.values()][0]!;
    row.status = "approved"; row.decision = "approve"; row.rememberForTurn = true;
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(outcome).resolves.toBe("approve");
    expect(reads).toEqual([1_000, 3_000, 7_000, 15_000, 23_000]);
    f.auditEvents.create.mockRejectedValueOnce(new Error("audit failed"));
    await expect(turn.request(action, f.publish)).resolves.toBe("approve");
    expect(f.approvals.create).toHaveBeenCalledOnce();
    expect(f.published).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    f.coordinator.close();
  });

  it("replays a decided policy row without remembering it for a later native action", async () => {
    vi.useFakeTimers();
    const f = setup();
    const proof = createPolicyApprovalProof({ ...identity, toolContextId: "original-context", toolCallId: "call-1",
      toolName: action.name, serverId: "managed", args: action.args, ruleId: null, explanation: "Review" });
    const turn = f.coordinator.openTurn(f.options);
    const first = turn.request({ ...action, policyApproval: proof }, f.publish);
    await flush();
    const row = f.rows.get(proof.approvalId)!;
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve", rememberForTurn: true })).resolves.toBe("resolved");
    await first;
    expect(row).toMatchObject({ status: "approved", decision: "approve", rememberForTurn: true });
    turn.cancelLocal();

    const replayTurn = f.coordinator.openTurn({ ...f.options, identity: { ...identity, turnId: "turn-2" } });
    await expect(replayTurn.request({ ...action, policyApproval: proof }, f.publish)).resolves.toBe("approve");
    const native = replayTurn.request(action, f.publish);
    await flush();
    expect(f.published.filter((notice) => notice.name === "approval_required")).toHaveLength(2);
    const nativeRow = [...f.rows.values()].find((candidate) => candidate.approvalId !== proof.approvalId)!;
    await f.coordinator.decide({ ...identity, approvalId: nativeRow.approvalId, decision: "reject" });
    await expect(native).resolves.toBe("reject");
    expect(vi.getTimerCount()).toBe(0);
    f.coordinator.close();
  });

  it("releases all concurrent waits on close and denies new requests", async () => {
    vi.useFakeTimers();
    const f = setup();
    const turn = f.coordinator.openTurn(f.options);
    const outcomes = [turn.request(action, f.publish), turn.request({ ...action, name: "write_file", kind: "file_change" }, f.publish)];
    await flush();
    expect(f.rows.size).toBe(2);
    f.coordinator.close(); f.coordinator.close();
    await expect(Promise.all(outcomes)).resolves.toEqual(["reject", "reject"]);
    await expect(turn.request(action, f.publish)).resolves.toBe("reject");
    await expect(f.coordinator.openTurn(f.options).request(action, f.publish)).resolves.toBe("reject");
    expect(vi.getTimerCount()).toBe(0);
  });
});

function policyAction() {
  return { ...action, policyApproval: createPolicyApprovalProof({ ...identity,
    toolContextId: "original-context", toolCallId: "call-1", toolName: action.name,
    serverId: "managed", args: action.args, ruleId: null, explanation: "Review" }) };
}

describe("approval decision ownership", () => {
  it.each(["native", "execution", "policy"] as const)(
    "resumes no %s wait before its decision and audit event commit", async (source) => {
      vi.useFakeTimers();
      const f = setup();
      const write = deferred();
      const storeResolve = f.approvals.resolve.getMockImplementation()!;
      f.approvals.resolve.mockImplementation(async (...args) => { await write.promise; return storeResolve(...args); });
      const turn = f.coordinator.openTurn({ ...f.options, durableNative: source === "execution" });
      const outcome = turn.request(source === "policy" ? policyAction() : action, f.publish);
      let settled = false;
      void outcome.then(() => { settled = true; });
      await flush();
      const row = [...f.rows.values()][0]!;
      const decision = f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve", rememberForTurn: true });
      await flush();
      expect(f.approvals.resolve).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(row.status).toBe("pending");
      write.resolve();
      await expect(decision).resolves.toBe("resolved");
      await expect(outcome).resolves.toBe("approve");
      expect(row).toMatchObject({ status: "approved", decision: "approve", rememberForTurn: true });
      expect(f.approvals.audit).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: identity.tenantId, userId: identity.userId, approvalId: row.approvalId, type: "approval.approved"
      }));
      expect(f.auditEvents.create).not.toHaveBeenCalled();
      await expect(turn.request(action, f.publish)).resolves.toBe("approve");
      expect(f.rows.size).toBe(1);
      f.coordinator.close();
    }
  );

  it.each(["throw", "missing"] as const)("does not settle a durable wait on a %s decision write", async (failure) => {
    vi.useFakeTimers();
    const f = setup();
    const turn = f.coordinator.openTurn({ ...f.options, durableNative: true });
    const outcome = turn.request(action, f.publish);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await flush();
    const row = [...f.rows.values()][0]!;
    if (failure === "throw") f.approvals.resolve.mockRejectedValueOnce(new Error("write failed"));
    else f.approvals.resolve.mockResolvedValueOnce(null);
    const decision = f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" });
    if (failure === "throw") await expect(decision).rejects.toThrow("write failed");
    else await expect(decision).resolves.toBe("missing");
    await flush();
    expect(settled).toBe(false);
    expect(row.status).toBe("pending");
    expect(f.approvals.audit).not.toHaveBeenCalled();
    f.controller.abort();
    await expect(outcome).resolves.toBe("reject");
    f.coordinator.close();
  });

  it("keeps a native local approval when its write changes no pending row", async () => {
    vi.useFakeTimers();
    const f = setup();
    const outcome = f.coordinator.openTurn(f.options).request(action, f.publish);
    await flush();
    const row = [...f.rows.values()][0]!;
    f.approvals.resolve.mockResolvedValueOnce(null);
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" })).resolves.toBe("resolved");
    await expect(outcome).resolves.toBe("approve");
    expect(row.status).toBe("pending");
    expect(f.approvals.audit).not.toHaveBeenCalled();
    f.coordinator.close();
  });

  it("does not settle a native wait when its decision write throws", async () => {
    vi.useFakeTimers();
    const f = setup();
    const outcome = f.coordinator.openTurn(f.options).request(action, f.publish);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await flush();
    const row = [...f.rows.values()][0]!;
    f.approvals.resolve.mockRejectedValueOnce(new Error("write failed"));
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" })).rejects.toThrow("write failed");
    await flush();
    expect(settled).toBe(false);
    expect(row.status).toBe("pending");
    f.coordinator.close();
    await expect(outcome).resolves.toBe("reject");
  });

  it.each([false, true])("rolls the decision back and keeps the wait when its audit event fails, durable: %s", async (durableNative) => {
    vi.useFakeTimers();
    const f = setup();
    const outcome = f.coordinator.openTurn({ ...f.options, durableNative }).request(action, f.publish);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await flush();
    const row = [...f.rows.values()][0]!;
    f.approvals.audit.mockRejectedValueOnce(new Error("audit failed"));
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "reject" })).rejects.toThrow("audit failed");
    await flush();
    expect(settled).toBe(false);
    expect(row).toMatchObject({ status: "pending", decision: null });
    // The user decides again once the audit insert works.
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "reject" })).resolves.toBe("resolved");
    await expect(outcome).resolves.toBe("reject");
    expect(row).toMatchObject({ status: "rejected", decision: "reject" });
    expect(f.approvals.audit).toHaveBeenLastCalledWith(expect.objectContaining({ type: "approval.rejected", approvalId: row.approvalId }));
    // The failed attempt saved nothing. A later retry reads the saved decision
    // and writes no second event.
    const events = f.approvals.audit.mock.calls.length;
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "reject" })).resolves.toBe("resolved");
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" })).resolves.toBe("conflict");
    expect(f.approvals.audit).toHaveBeenCalledTimes(events);
    expect(row).toMatchObject({ status: "rejected", decision: "reject" });
    f.coordinator.close();
  });

  it.each(["approve", "reject"] as const)(
    "lets the first native write settle the wait when a concurrent %s request saves second", async (second) => {
      vi.useFakeTimers();
      const f = setup();
      const outcome = f.coordinator.openTurn(f.options).request(action, f.publish);
      await flush();
      const row = [...f.rows.values()][0]!;
      const write = deferred();
      const storeResolve = f.approvals.resolve.getMockImplementation()!;
      f.approvals.resolve.mockImplementationOnce(async (...args) => { await write.promise; return storeResolve(...args); });
      const first = f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "reject" });
      await flush();
      const later = f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: second });
      await expect(later).resolves.toBe("resolved");
      await expect(outcome).resolves.toBe(second);
      write.resolve();
      // The write that waited changed no row, so it compares with the saved decision.
      await expect(first).resolves.toBe(second === "reject" ? "resolved" : "conflict");
      expect(row).toMatchObject({ status: second === "approve" ? "approved" : "rejected", decision: second });
      expect(f.approvals.audit).toHaveBeenCalledOnce();
      f.coordinator.close();
    });

  it.each(["tenant", "user", "actor removed", "execution check failed"] as const)("refuses a local decision for %s before writing", async (guard) => {
    vi.useFakeTimers();
    const f = setup();
    const outcome = f.coordinator.openTurn({ ...f.options, durableNative: true }).request(action, f.publish);
    await flush();
    const row = [...f.rows.values()][0]!;
    if (guard === "actor removed") f.hasActor.mockReturnValue(false);
    if (guard === "execution check failed") f.validate.mockRejectedValueOnce(new Error("execution stopped"));
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve",
      ...(guard === "tenant" ? { tenantId: "other-tenant" } : guard === "user" ? { userId: "other-user" } : {})
    })).resolves.toBe("missing");
    expect(f.approvals.resolve).not.toHaveBeenCalled();
    expect(row.status).toBe("pending");
    f.controller.abort();
    await expect(outcome).resolves.toBe("reject");
    f.coordinator.close();
  });

  it("uses scoped persistence without a local callback for a decision received on another replica", async () => {
    const f = setup();
    const row = await f.approvals.create({ ...identity, approvalId: "remote-request", itemId: "remote-request",
      requestMethod: "deepagents/execute", requestId: "remote-request", kind: "command_execution",
      title: "Approve execute", summary: "pwd", status: "pending", decision: null,
      requestPayload: {}, expiresAt: "2099-01-01T00:00:00Z" });
    await expect(f.coordinator.decide({ ...identity, tenantId: "other-tenant", approvalId: row.approvalId, decision: "approve" })).resolves.toBe("missing");
    await expect(f.coordinator.decide({ ...identity, userId: "other-user", approvalId: row.approvalId, decision: "approve" })).resolves.toBe("missing");
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve", rememberForTurn: true })).resolves.toBe("resolved");
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "reject" })).resolves.toBe("conflict");
    expect(f.hasActor).not.toHaveBeenCalled();
    expect(f.validate).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: "approved", decision: "approve", rememberForTurn: true });
    f.coordinator.close();
  });

  it("rechecks the local actor after a durable write without undoing stored authority", async () => {
    vi.useFakeTimers();
    const f = setup();
    const outcome = f.coordinator.openTurn({ ...f.options, durableNative: true }).request(action, f.publish);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await flush();
    const row = [...f.rows.values()][0]!;
    f.hasActor.mockReturnValueOnce(true).mockReturnValue(false);
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" })).resolves.toBe("resolved");
    await flush();
    expect(row.status).toBe("approved");
    expect(settled).toBe(false);
    f.controller.abort();
    await expect(outcome).resolves.toBe("reject");
    f.coordinator.close();
  });
});

function seedRemoteRow(f: ReturnType<typeof setup>, overrides: Partial<Parameters<typeof f.approvals.create>[0]> = {}) {
  return f.approvals.create({ ...identity, approvalId: "remote-request", itemId: "remote-request",
    requestMethod: "deepagents/execute", requestId: "remote-request", kind: "command_execution",
    title: "Approve execute", summary: "pwd", status: "pending", decision: null,
    requestPayload: {}, expiresAt: "2099-01-01T00:00:00Z", ...overrides });
}

describe("repeated approval decisions", () => {
  it.each(["approve", "reject"] as const)(
    "gives the same answer to a %s retry on each replica and after a restart, with one effect", async (decision) => {
      vi.useFakeTimers();
      const f = setup();
      const deps = { approvals: f.approvals, auditEvents: f.auditEvents, logger: createSilentLogger(), ttlMs: 60_000 };
      const remote = new ApprovalCoordinator(deps);
      const turn = f.coordinator.openTurn({ ...f.options, durableNative: true });
      const outcome = turn.request(action, f.publish);
      let settled = 0;
      void outcome.then(() => { settled += 1; });
      await flush();
      const row = [...f.rows.values()][0]!;
      const request = { ...identity, approvalId: row.approvalId, decision };
      await expect(remote.decide(request)).resolves.toBe("resolved");
      // The owner's wait still waits: only the durable row, read by its poll, resumes it.
      await expect(f.coordinator.decide(request)).resolves.toBe("resolved");
      await flush();
      expect(settled).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(outcome).resolves.toBe(decision);
      const restarted = new ApprovalCoordinator(deps);
      const opposite = decision === "approve" ? "reject" : "approve";
      for (const coordinator of [f.coordinator, remote, restarted]) {
        await expect(coordinator.decide(request)).resolves.toBe("resolved");
        await expect(coordinator.decide({ ...request, decision: opposite })).resolves.toBe("conflict");
      }
      expect(row).toMatchObject({ status: decision === "approve" ? "approved" : "rejected", decision });
      expect(f.approvals.audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        approvalId: row.approvalId, type: decision === "approve" ? "approval.approved" : "approval.rejected"
      }));
      expect(settled).toBe(1);
      for (const coordinator of [f.coordinator, remote, restarted]) coordinator.close();
    });

  it.each([
    { name: "a turn approval", bound: false, saved: true, retry: true, result: "resolved" },
    { name: "a turn approval", bound: false, saved: true, retry: false, result: "conflict" },
    { name: "a turn approval", bound: false, saved: false, retry: true, result: "conflict" },
    { name: "a turn approval", bound: false, saved: false, retry: undefined, result: "resolved" },
    { name: "a bound save", bound: true, saved: true, retry: false, result: "resolved" },
    { name: "a bound save", bound: true, saved: false, retry: true, result: "resolved" }
  ] as const)("compares the effective turn scope of $name: saved $saved, retry $retry", async (c) => {
    const f = setup();
    const row = await seedRemoteRow(f, c.bound
      ? { requestMethod: "policy/toolApproval", requestPayload: { bound: { previousContentSha256: null } } }
      : {});
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve",
      rememberForTurn: c.saved })).resolves.toBe("resolved");
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve",
      rememberForTurn: c.retry })).resolves.toBe(c.result);
    expect(f.approvals.audit).toHaveBeenCalledOnce();
    f.coordinator.close();
  });

  it("ignores the turn flag of a rejection", async () => {
    const f = setup();
    const row = await seedRemoteRow(f);
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "reject" })).resolves.toBe("resolved");
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "reject", rememberForTurn: true }))
      .resolves.toBe("resolved");
    f.coordinator.close();
  });

  it.each(["tenant", "user", "pending", "expired"] as const)("returns missing for a retry with a %s mismatch", async (refusal) => {
    const f = setup();
    const row = await seedRemoteRow(f);
    if (refusal === "pending") f.approvals.resolve.mockResolvedValueOnce(null);
    else if (refusal === "expired") row.status = "expired";
    else await f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" });
    const auditCalls = f.approvals.audit.mock.calls.length;
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve",
      ...(refusal === "tenant" ? { tenantId: "other-tenant" } : refusal === "user" ? { userId: "other-user" } : {})
    })).resolves.toBe("missing");
    expect(f.approvals.getDecided).toHaveBeenCalledWith(
      refusal === "tenant" ? "other-tenant" : identity.tenantId, row.approvalId,
      refusal === "user" ? "other-user" : identity.userId);
    expect(f.approvals.audit).toHaveBeenCalledTimes(auditCalls);
    f.coordinator.close();
  });

  it("propagates a failed read of the saved decision", async () => {
    const f = setup();
    const row = await seedRemoteRow(f);
    await f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" });
    f.approvals.getDecided.mockRejectedValueOnce(new Error("read failed"));
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" }))
      .rejects.toThrow("read failed");
    expect(f.approvals.audit).toHaveBeenCalledOnce();
    f.coordinator.close();
  });

  it.each([
    { decision: "approve", refusal: "execution check failed" },
    { decision: "reject", refusal: "execution check failed" },
    { decision: "approve", refusal: "actor removed" },
    { decision: "reject", refusal: "actor removed" }
  ] as const)("answers a $decision retry from the saved row when the owner's local wait refuses it: $refusal",
    async ({ decision, refusal }) => {
      vi.useFakeTimers();
      const f = setup();
      const remote = new ApprovalCoordinator({ approvals: f.approvals, auditEvents: f.auditEvents,
        logger: createSilentLogger(), ttlMs: 60_000 });
      const outcome = f.coordinator.openTurn({ ...f.options, durableNative: true }).request(action, f.publish);
      let settled = 0;
      void outcome.then(() => { settled += 1; });
      await flush();
      const row = [...f.rows.values()][0]!;
      const request = { ...identity, approvalId: row.approvalId, decision };
      const opposite = decision === "approve" ? "reject" : "approve";
      await expect(remote.decide(request)).resolves.toBe("resolved");
      // The owner's lease stops before its poll reads the row.
      if (refusal === "execution check failed") f.validate.mockRejectedValue(new Error("execution stopped"));
      else f.hasActor.mockReturnValue(false);
      await expect(f.coordinator.decide(request)).resolves.toBe("resolved");
      await expect(f.coordinator.decide({ ...request, decision: opposite })).resolves.toBe("conflict");
      // The owner read the saved row and did not write a decision.
      expect(f.approvals.resolve).toHaveBeenCalledOnce();
      expect(f.approvals.getDecided).toHaveBeenCalledTimes(2);
      await expect(remote.decide(request)).resolves.toBe("resolved");
      await expect(remote.decide({ ...request, decision: opposite })).resolves.toBe("conflict");
      await flush();
      expect(settled).toBe(0);
      expect(f.approvals.audit).toHaveBeenCalledOnce();
      expect(row).toMatchObject({ status: decision === "approve" ? "approved" : "rejected", decision });
      f.controller.abort();
      await expect(outcome).resolves.toBe("reject");
      expect(settled).toBe(1);
      f.coordinator.close(); remote.close();
    });

  it("answers from the saved row when a native local actor leaves during the owner's check", async () => {
    vi.useFakeTimers();
    const f = setup();
    const remote = new ApprovalCoordinator({ approvals: f.approvals, auditEvents: f.auditEvents,
      logger: createSilentLogger(), ttlMs: 60_000 });
    const outcome = f.coordinator.openTurn(f.options).request(action, f.publish);
    await flush();
    const row = [...f.rows.values()][0]!;
    const request = { ...identity, approvalId: row.approvalId, decision: "approve" as const };
    await expect(remote.decide(request)).resolves.toBe("resolved");
    f.hasActor.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(f.coordinator.decide({ ...request, decision: "reject" })).resolves.toBe("conflict");
    expect(f.approvals.resolve).toHaveBeenCalledOnce();
    expect(f.approvals.audit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe("approve");
    f.coordinator.close(); remote.close();
  });

  it("does not read a saved decision when the decision write succeeds or another user asks", async () => {
    vi.useFakeTimers();
    const f = setup();
    const outcome = f.coordinator.openTurn({ ...f.options, durableNative: true }).request(action, f.publish);
    await flush();
    const row = [...f.rows.values()][0]!;
    await expect(f.coordinator.decide({ ...identity, userId: "other-user", approvalId: row.approvalId, decision: "approve" }))
      .resolves.toBe("missing");
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" })).resolves.toBe("resolved");
    await expect(outcome).resolves.toBe("approve");
    expect(f.approvals.getDecided).not.toHaveBeenCalled();
    f.coordinator.close();
  });
});

describe("stored artifact approval presentation", () => {
  function artifact(policy = false): ApprovalRequest {
    const request: ApprovalRequest = { name: "write_artifact", kind: "mcp_tool",
      server: { id: "managed", mode: "managed" }, args: { name: "report.md", content: "private body" } };
    if (policy) request.policyApproval = createPolicyApprovalProof({ ...identity, toolContextId: "ctx-1",
      toolCallId: "call-1", toolName: request.name, serverId: request.server!.id, args: request.args,
      ruleId: "historical-rule", explanation: "Historical review reason." });
    return request;
  }

  it("publishes the returned stored fields rather than recomputing copy", async () => {
    const f = setup();
    const create = f.approvals.create.getMockImplementation()!;
    f.approvals.create.mockImplementation((input) => create({ ...input, title: "Stored title", summary: "Stored summary" }));
    const turn = f.coordinator.openTurn({ ...f.options, projectId: null });
    const wait = turn.request(artifact(), f.publish);
    await flush();
    expect(f.approvals.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save "report.md" to Artifacts' }));
    expect(f.published[0]).toMatchObject({ name: "approval_required", value: { title: "Stored title", summary: "Stored summary" } });
    turn.cancelLocal();
    await expect(wait).resolves.toBe("reject");
    f.coordinator.close();
  });

  it.each(["reuse", "insert winner", "old row"] as const)("preserves stored historical text on %s", async (mode) => {
    const f = setup();
    const request = artifact(true);
    const first = f.coordinator.openTurn({ ...f.options, projectId: null });
    const wait = first.request(request, f.publish);
    await flush();
    const stored = f.rows.get(request.policyApproval!.approvalId)!;
    first.cancelLocal();
    await wait;
    if (mode === "old row") {
      stored.title = "Approve write_artifact"; stored.summary = '{"name":"legacy.md"}';
    }
    const secondRequest = { ...request, policyApproval: { ...request.policyApproval!, explanation: "New rule reason." } };
    if (mode === "insert winner") {
      f.approvals.get.mockResolvedValueOnce(null);
      f.approvals.create.mockRejectedValueOnce(new Error("duplicate approval"));
    }
    const second = f.coordinator.openTurn({ ...f.options, projectId: null, identity: { ...identity, turnId: "turn-2" } });
    const reused = second.request(secondRequest, f.publish);
    await flush();
    expect(f.published[1]).toMatchObject({ name: "approval_required", value: { title: stored.title, summary: stored.summary } });
    expect(f.published[1]).not.toMatchObject({ value: { summary: expect.stringContaining("New rule reason.") } });
    expect(f.approvals.create).toHaveBeenCalledTimes(mode === "insert winner" ? 2 : 1);
    second.cancelLocal();
    await expect(reused).resolves.toBe("reject");
    f.coordinator.close();
  });

  for (const policy of [false, true]) {
    it.each(["approve", "reject", "remember", "expiry", "Stop"] as const)(
      `keeps %s behavior for a readable ${policy ? "policy" : "native"} artifact request`, async (decision) => {
        vi.useFakeTimers();
        const f = setup();
        const turn = f.coordinator.openTurn({ ...f.options, projectId: null });
        const request = artifact(policy);
        const wait = turn.request(request, f.publish);
        await flush();
        const stored = [...f.rows.values()][0]!;
        expect(stored.title).toBe('Save "report.md" to Artifacts');
        expect(stored.summary).toContain(policy ? "Reason: Historical review reason." : "Reason: This tool requires approval.");
        expect(stored.summary).not.toContain("private body");
        if (decision === "expiry") await vi.advanceTimersByTimeAsync(60_000);
        else if (decision === "Stop") f.controller.abort();
        else await f.coordinator.decide({ ...identity, approvalId: stored.approvalId,
          decision: decision === "reject" ? "reject" : "approve", rememberForTurn: decision === "remember" });
        await expect(wait).resolves.toBe(decision === "Stop" ? "reject" : decision === "remember" ? "approve" : decision === "expiry" ? "expired" : decision);
        if (decision === "remember") {
          await expect(turn.request(artifact(), f.publish)).resolves.toBe("approve");
          expect(f.approvals.create).toHaveBeenCalledOnce();
          expect(f.published).toHaveLength(1);
          const laterPolicy = artifact(true);
          laterPolicy.policyApproval = { ...laterPolicy.policyApproval!, approvalId: "later-policy-call" };
          const later = turn.request(laterPolicy, f.publish);
          await flush();
          expect(f.published).toHaveLength(2);
          turn.cancelLocal();
          await expect(later).resolves.toBe("reject");
        }
        expect(vi.getTimerCount()).toBe(0);
        turn.cancelLocal();
        f.coordinator.close();
      }
    );
  }
});

describe("approval of a proposed tool call", () => {
  it("stores the server ID of the call and names it in the card, from the stored row", async () => {
    const f = setup();
    const turn = f.coordinator.openTurn(f.options);
    const wait = turn.request({ ...action, toolCallId: "card-1" }, f.publish);
    await flush();
    const stored = [...f.rows.values()][0]!;
    expect(stored).toMatchObject({ toolCallId: "card-1", itemId: stored.approvalId, requestPayload: action.args });
    expect(f.published).toEqual([expect.objectContaining({ name: "approval_required",
      value: expect.objectContaining({ approvalId: stored.approvalId, toolCallId: "card-1" }) })]);
    await f.coordinator.decide({ ...identity, approvalId: stored.approvalId, decision: "approve" });
    await expect(wait).resolves.toBe("approve");
    f.coordinator.close();
  });

  it("names no call when the runtime proved none, and a reused row without one stays unlinked", async () => {
    const f = setup();
    const turn = f.coordinator.openTurn(f.options);
    const unlinked = turn.request(action, f.publish);
    await flush();
    expect([...f.rows.values()][0]).not.toHaveProperty("toolCallId");
    expect(f.published[0]!.value).not.toHaveProperty("toolCallId");

    // A Policy Center row saved before the link existed: its event names no call,
    // even when the current request has one, so the event and a read agree.
    const proof = createPolicyApprovalProof({ ...identity, toolContextId: "ctx", toolCallId: "call-1",
      toolName: action.name, serverId: "managed", args: action.args, ruleId: null, explanation: "Review" });
    const first = turn.request({ ...action, policyApproval: proof }, f.publish);
    await flush();
    delete f.rows.get(proof.approvalId)!.toolCallId;
    turn.cancelLocal();
    await Promise.all([unlinked, first]);
    const again = f.coordinator.openTurn({ ...f.options, identity: { ...identity, turnId: "turn-2" } });
    const reused = again.request({ ...action, policyApproval: proof, toolCallId: "card-2" }, f.publish);
    await flush();
    expect(f.published.at(-1)!.value).not.toHaveProperty("toolCallId");
    again.cancelLocal();
    await reused;
    f.coordinator.close();
  });
});

describe("approval of a durable write", () => {
  const args = { name: "units", content: "User prefers metric units." };
  const durableWrite = {
    title: 'Replace memory "units"',
    summary: "Text to save (26 characters):\nUser prefers metric units.",
    bound: { previousContentSha256: "a".repeat(64) }
  };
  function memorySave(extra: Partial<ApprovalRequest> = {}): ApprovalRequest {
    const proof = createPolicyApprovalProof({ ...identity, toolContextId: "ctx-1", toolCallId: "call-1",
      toolName: "memory_save", serverId: "managed", args, ruleId: null, explanation: "Saves data." });
    return { name: "memory_save", kind: "mcp_tool", server: { id: "managed", mode: "managed" }, args,
      policyApproval: proof, durableWrite, ...extra };
  }

  it("shows the card text that the server built and stores the facts beside the approval", async () => {
    const f = setup();
    const request = memorySave();
    const turn = f.coordinator.openTurn(f.options);
    const wait = turn.request(request, f.publish);
    await flush();

    const row = f.rows.get(request.policyApproval!.approvalId)!;
    expect(row).toMatchObject({ title: durableWrite.title, summary: durableWrite.summary });
    expect(row.requestPayload).toMatchObject({
      policyApproval: { toolName: "memory_save" }, bound: durableWrite.bound
    });
    expect(f.published[0]).toMatchObject({ name: "approval_required",
      value: { approvalId: row.approvalId, title: durableWrite.title, summary: durableWrite.summary } });
    turn.cancelLocal();
    await expect(wait).resolves.toBe("reject");
    f.coordinator.close();
  });

  it("does not let the model write the stored facts when the server has none", async () => {
    const f = setup();
    const request = memorySave({ durableWrite: undefined, args: { ...args, bound: { previousContentSha256: null } } });
    const turn = f.coordinator.openTurn(f.options);
    const wait = turn.request(request, f.publish);
    await flush();

    const row = f.rows.get(request.policyApproval!.approvalId)!;
    // JSON drops the unset key, so the model's own `bound` argument does not survive.
    expect(JSON.parse(JSON.stringify(row.requestPayload))).not.toHaveProperty("bound");
    turn.cancelLocal();
    await expect(wait).resolves.toBe("reject");
    f.coordinator.close();
  });

  it("offers no turn option for a save, and keeps it for a native request and another policy request", async () => {
    const f = setup();
    const turn = f.coordinator.openTurn(f.options);
    const save = memorySave();
    const waits = [turn.request(save, f.publish), turn.request(action, f.publish), turn.request(policyAction(), f.publish)];
    await flush();

    const cards = f.published.filter((notice) => notice.name === "approval_required")
      .map((notice) => notice.value as { approvalId: string; allowForTurn?: boolean });
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.allowForTurn).toBe(card.approvalId !== save.policyApproval!.approvalId);
    }
    turn.cancelLocal();
    await Promise.all(waits);
    f.coordinator.close();
  });

  it("does not remember a save for the turn even when a client asks for that", async () => {
    const f = setup();
    const turn = f.coordinator.openTurn(f.options);
    const first = memorySave();
    const wait = turn.request(first, f.publish);
    await flush();
    await f.coordinator.decide({ ...identity, approvalId: first.policyApproval!.approvalId, decision: "approve", rememberForTurn: true });
    await expect(wait).resolves.toBe("approve");

    // A later request of the same kind and name, without a proof, still asks the user.
    const later = turn.request({ name: "memory_save", kind: "mcp_tool", args }, f.publish);
    await flush();
    expect(f.published.filter((notice) => notice.name === "approval_required")).toHaveLength(2);
    turn.cancelLocal();
    await expect(later).resolves.toBe("reject");
    f.coordinator.close();
  });

  it("does not auto-approve a later save because the user allowed an earlier one for the turn", async () => {
    const f = setup();
    const turn = f.coordinator.openTurn(f.options);
    const first = memorySave();
    const wait = turn.request(first, f.publish);
    await flush();
    await expect(f.coordinator.decide({ ...identity, approvalId: first.policyApproval!.approvalId,
      decision: "approve", rememberForTurn: true })).resolves.toBe("resolved");
    await expect(wait).resolves.toBe("approve");

    const second = memorySave({ args: { ...args, content: "A different text." } });
    second.policyApproval = createPolicyApprovalProof({ ...identity, toolContextId: "ctx-1", toolCallId: "call-2",
      toolName: "memory_save", serverId: "managed", args: second.args, ruleId: null, explanation: "Saves data." });
    const secondWait = turn.request(second, f.publish);
    await flush();
    // It is pending: it waits for the user instead of returning an auto-approval.
    expect(f.rows.get(second.policyApproval!.approvalId)?.status).toBe("pending");
    turn.cancelLocal();
    await expect(secondWait).resolves.toBe("reject");
    f.coordinator.close();
  });
});

// Two open turns can wait on the same persisted policy approval. Each wait is its own
// entry: settling one must not remove the other, and every settled wait clears its timers and listener.
describe("overlapping waits on one approval", () => {
  async function twoWaits() {
    vi.useFakeTimers();
    const f = setup();
    const proof = policyAction();
    const signals = [new AbortController(), new AbortController()];
    const removals = signals.map((controller) => vi.spyOn(controller.signal, "removeEventListener"));
    const turns = signals.map((controller, index) => f.coordinator.openTurn({
      ...f.options, signal: controller.signal, identity: { ...identity, turnId: `turn-${index + 1}` }
    }));
    const older = turns[0]!.request(proof, f.publish);
    await flush();
    const newer = turns[1]!.request(proof, f.publish);
    await flush();
    // One row, two cards: the newer turn reuses the persisted request.
    expect(f.approvals.create).toHaveBeenCalledOnce();
    expect(f.published.filter((notice) => notice.name === "approval_required")).toHaveLength(2);
    return { ...f, approvalId: proof.policyApproval.approvalId, signals, removals, turns, older, newer };
  }

  it("settles both waits with one decision", async () => {
    const w = await twoWaits();

    await expect(w.coordinator.decide({ ...identity, approvalId: w.approvalId, decision: "approve" })).resolves.toBe("resolved");

    await expect(Promise.all([w.older, w.newer])).resolves.toEqual(["approve", "approve"]);
    expect(w.rows.get(w.approvalId)?.status).toBe("approved");
    expect(w.removals.map((removal) => removal.mock.calls.filter(([type]) => type === "abort"))).toEqual([
      [["abort", expect.any(Function)]], [["abort", expect.any(Function)]]
    ]);
    expect(vi.getTimerCount()).toBe(0);
    w.coordinator.close();
  });

  it.each(["cancel", "abort"] as const)(
    "keeps the newer wait when the older one ends by %s, and the decision then reaches it", async (end) => {
      const w = await twoWaits();

      if (end === "cancel") w.turns[0]!.cancelLocal();
      else w.signals[0]!.abort();
      await expect(w.older).resolves.toBe("reject");

      await expect(w.coordinator.decide({ ...identity, approvalId: w.approvalId, decision: "reject" })).resolves.toBe("resolved");
      await expect(w.newer).resolves.toBe("reject");
      expect(w.rows.get(w.approvalId)?.status).toBe("rejected");
      expect(vi.getTimerCount()).toBe(0);
      w.coordinator.close();
    });

  it("keeps the older wait when the newer one ends first", async () => {
    const w = await twoWaits();

    w.turns[1]!.cancelLocal();
    await expect(w.newer).resolves.toBe("reject");

    await expect(w.coordinator.decide({ ...identity, approvalId: w.approvalId, decision: "approve" })).resolves.toBe("resolved");
    await expect(w.older).resolves.toBe("approve");
    expect(vi.getTimerCount()).toBe(0);
    w.coordinator.close();
  });

  it("decides only the waits of the actor that is local to each turn", async () => {
    vi.useFakeTimers();
    const f = setup();
    const proof = policyAction();
    const localToFirst = vi.fn(() => true);
    const localToSecond = vi.fn(() => false);
    const first = f.coordinator.openTurn({ ...f.options, hasLocalActor: localToFirst });
    const second = f.coordinator.openTurn({ ...f.options, hasLocalActor: localToSecond,
      identity: { ...identity, turnId: "turn-2" }, signal: new AbortController().signal });
    const firstWait = first.request(proof, f.publish);
    await flush();
    const secondWait = second.request(proof, f.publish);
    await flush();

    await expect(f.coordinator.decide({ ...identity, approvalId: proof.policyApproval.approvalId, decision: "approve" }))
      .resolves.toBe("resolved");
    await expect(firstWait).resolves.toBe("approve");
    // The other wait is not settled by this replica. It reads the stored decision at its next poll.
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(secondWait).resolves.toBe("approve");
    expect(vi.getTimerCount()).toBe(0);
    f.coordinator.close();
  });

  it("expires each wait at its own TTL and clears every timer", async () => {
    const w = await twoWaits();

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(Promise.all([w.older, w.newer])).resolves.toEqual(["expired", "expired"]);
    expect(w.rows.get(w.approvalId)?.status).toBe("expired");
    expect(vi.getTimerCount()).toBe(0);
    w.coordinator.close();
  });

  it("releases both waits on coordinator shutdown", async () => {
    const w = await twoWaits();

    w.coordinator.close();

    await expect(Promise.all([w.older, w.newer])).resolves.toEqual(["reject", "reject"]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(w.coordinator.decide({ ...identity, approvalId: w.approvalId, decision: "approve" })).resolves.toBe("resolved");
  });

  it("keeps the tenant and user checks for every wait", async () => {
    const w = await twoWaits();

    await expect(w.coordinator.decide({ ...identity, userId: "user-2", approvalId: w.approvalId, decision: "approve" }))
      .resolves.toBe("missing");
    await expect(w.coordinator.decide({ ...identity, tenantId: "tenant-2", approvalId: w.approvalId, decision: "approve" }))
      .resolves.toBe("missing");
    expect(w.rows.get(w.approvalId)?.status).toBe("pending");
    w.coordinator.close();
    await Promise.all([w.older, w.newer]);
  });
});
