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
    "keeps the %s persistence order while a write is blocked", async (source) => {
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
      expect(settled).toBe(source === "native");
      expect(row.status).toBe("pending");
      write.resolve();
      await expect(decision).resolves.toBe("resolved");
      await expect(outcome).resolves.toBe("approve");
      expect(row).toMatchObject({ status: "approved", decision: "approve", rememberForTurn: true });
      expect(f.auditEvents.create).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: identity.tenantId, userId: identity.userId, approvalId: row.approvalId, type: "approval.approved"
      }));
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
    expect(f.auditEvents.create).not.toHaveBeenCalled();
    f.controller.abort();
    await expect(outcome).resolves.toBe("reject");
    f.coordinator.close();
  });

  it.each(["throw", "missing"] as const)("keeps a native local approval when its write returns %s", async (failure) => {
    vi.useFakeTimers();
    const f = setup();
    const outcome = f.coordinator.openTurn(f.options).request(action, f.publish);
    await flush();
    const row = [...f.rows.values()][0]!;
    if (failure === "throw") f.approvals.resolve.mockRejectedValueOnce(new Error("write failed"));
    else f.approvals.resolve.mockResolvedValueOnce(null);
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "approve" })).resolves.toBe("resolved");
    await expect(outcome).resolves.toBe("approve");
    expect(row.status).toBe("pending");
    expect(f.auditEvents.create).not.toHaveBeenCalled();
    f.coordinator.close();
  });

  it.each([false, true])("keeps a stored decision when auditing fails, durable: %s", async (durableNative) => {
    vi.useFakeTimers();
    const f = setup();
    const outcome = f.coordinator.openTurn({ ...f.options, durableNative }).request(action, f.publish);
    await flush();
    const row = [...f.rows.values()][0]!;
    f.auditEvents.create.mockRejectedValueOnce(new Error("audit failed"));
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "reject" })).resolves.toBe("resolved");
    await expect(outcome).resolves.toBe("reject");
    expect(row).toMatchObject({ status: "rejected", decision: "reject" });
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
    await expect(f.coordinator.decide({ ...identity, approvalId: row.approvalId, decision: "reject" })).resolves.toBe("missing");
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
