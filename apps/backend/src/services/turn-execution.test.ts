import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RuntimeSessionRef } from "../runtime-contracts.js";
import type { ToolExecutionContextStore } from "./auth/tool-execution-context-store.js";
import { SessionExecutionError, type SessionExecution } from "./session-execution-store.js";
import { bindTurnToolContext, TurnExecutionLease } from "./turn-execution.js";

const ACTOR = { tenantId: "tenant-1", sessionId: "session-1", userId: "user-1" };
const SETTINGS = { leaseMs: 1_000, heartbeatMs: 100, caps: { perUser: 2, perTenant: 5 } };

function harness() {
  const order: string[] = [];
  const execution = {
    ...ACTOR, executionId: "exec-1", projectId: null, expiresAt: new Date(Date.now() + SETTINGS.leaseMs).toISOString()
  } as SessionExecution;
  const executions = {
    acquire: vi.fn(async () => execution),
    heartbeat: vi.fn(async () => true),
    release: vi.fn(async () => { order.push("release"); }),
    stoppedBySecurityChange: vi.fn(async () => false)
  };
  const onReleaseError = vi.fn();
  const acquire = (turnContext?: "scheduled") => TurnExecutionLease.acquire({
    executions, actor: ACTOR, settings: SETTINGS, onReleaseError, ...(turnContext ? { turnContext } : {})
  });
  return { order, execution, executions, onReleaseError, acquire };
}

describe("TurnExecutionLease", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test("takes the lease with the caps, and names the turn context only for a scheduled turn", async () => {
    const h = harness();
    expect((await h.acquire()).execution).toBe(h.execution);
    expect(h.executions.acquire).toHaveBeenLastCalledWith(ACTOR, 1_000, SETTINGS.caps);
    await h.acquire("scheduled");
    expect(h.executions.acquire).toHaveBeenLastCalledWith(ACTOR, 1_000, SETTINGS.caps, "scheduled");
  });

  test("a refused admission is passed on, and no lease exists", async () => {
    const h = harness();
    h.executions.acquire.mockRejectedValueOnce(new SessionExecutionError("running_turn_limit", 429));
    await expect(h.acquire()).rejects.toMatchObject({ code: "running_turn_limit" });
    expect(h.executions.release).not.toHaveBeenCalled();
  });

  test("renews the lease only after startHeartbeat, and stops at release", async () => {
    const h = harness();
    const lease = await h.acquire();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.executions.heartbeat).not.toHaveBeenCalled();

    lease.startHeartbeat({ onLost: async () => {}, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(250);
    expect(h.executions.heartbeat).toHaveBeenCalledWith(h.execution, 1_000);
    const renewals = h.executions.heartbeat.mock.calls.length;
    expect(renewals).toBeGreaterThan(0);

    await lease.release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.executions.heartbeat).toHaveBeenCalledTimes(renewals);
    expect(lease.lost).toBe(false);
  });

  test("a lost lease is marked before onLost runs once, and setup then stops", async () => {
    const h = harness();
    const lease = await h.acquire();
    const seen: boolean[] = [];
    const onLost = vi.fn(async () => { seen.push(lease.lost); });
    lease.startHeartbeat({ onLost, onError: vi.fn() });
    expect(() => lease.assertHeld()).not.toThrow();

    h.executions.heartbeat.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([true]);
    expect(() => lease.assertHeld()).toThrow(SessionExecutionError);
    // The lease is not released by its loss: the caller decides when.
    expect(h.executions.release).not.toHaveBeenCalled();
  });

  test("a lease that is not renewed in time is lost at its expiry", async () => {
    const h = harness();
    const lease = await h.acquire();
    const onLost = vi.fn(async () => {});
    const onError = vi.fn();
    lease.startHeartbeat({ onLost, onError });
    h.executions.heartbeat.mockRejectedValue(new Error("database unavailable"));

    await vi.advanceTimersByTimeAsync(SETTINGS.leaseMs + 200);

    expect(onError).toHaveBeenCalled();
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(lease.lost).toBe(true);
  });

  test("a rejection of onLost goes to onError", async () => {
    const h = harness();
    const lease = await h.acquire();
    const onError = vi.fn();
    const failure = new Error("abort failed");
    lease.startHeartbeat({ onLost: async () => { throw failure; }, onError });
    h.executions.heartbeat.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  test("stopRuntime aborts the turn of this execution, with the reason of a security change", async () => {
    const h = harness();
    const lease = await h.acquire();
    const abortSession = vi.fn(async () => {});
    await lease.stopRuntime({ abortSession });
    expect(abortSession).toHaveBeenLastCalledWith({ ...ACTOR, executionId: "exec-1" });

    h.executions.stoppedBySecurityChange.mockResolvedValueOnce(true);
    await lease.stopRuntime({ abortSession });
    expect(abortSession).toHaveBeenLastCalledWith({ ...ACTOR, executionId: "exec-1", reason: "security_change" });
  });

  test("release runs once, also when callers race, and a failure is reported, not thrown", async () => {
    const h = harness();
    const lease = await h.acquire();
    const failure = new Error("Connection terminated unexpectedly");
    h.executions.release.mockRejectedValueOnce(failure);

    await expect(Promise.all([lease.release(), lease.release()])).resolves.toEqual([undefined, undefined]);
    await lease.release();

    expect(h.executions.release).toHaveBeenCalledTimes(1);
    expect(h.executions.release).toHaveBeenCalledWith(h.execution);
    expect(h.onReleaseError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  test("stopHeartbeat keeps the lease, and no heartbeat starts after a release", async () => {
    const h = harness();
    const kept = await h.acquire();
    kept.startHeartbeat({ onLost: async () => {}, onError: vi.fn() });
    kept.stopHeartbeat();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.executions.heartbeat).not.toHaveBeenCalled();
    expect(h.executions.release).not.toHaveBeenCalled();

    const released = await h.acquire();
    await released.release();
    const onLost = vi.fn(async () => {});
    released.startHeartbeat({ onLost, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(SETTINGS.leaseMs * 2);
    expect(h.executions.heartbeat).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
  });
});

describe("bindTurnToolContext", () => {
  const runtimePolicy = { id: "policy-1" } as RuntimeSessionRef["runtimePolicy"];
  const fakeCreate = () => vi.fn<ToolExecutionContextStore["create"]>(async () => ({ toolContextId: "ctx-1" }) as never);
  const base = {
    ...ACTOR, messageId: "msg-1", ownerSecurityVersion: 7, ttlMs: 60_000,
    runtimeSession: { runtimeId: "rt-1", runtimePolicy }
  };

  test("binds the turn to its runtime, policy snapshot, execution and owner version", async () => {
    const create = fakeCreate();
    await bindTurnToolContext({ create }, {
      ...base,
      runtimeSession: {
        ...base.runtimeSession,
        mcpServerSources: [{ id: "srv", hash: "h" }],
        integrationAccounts: { github: "acct" }
      },
      execution: { executionId: "exec-1" },
      turnContext: "scheduled"
    });
    expect(create).toHaveBeenCalledExactlyOnceWith({
      ...ACTOR,
      runtimeId: "rt-1",
      runtimePolicyId: "policy-1",
      messageId: "msg-1",
      metadata: {
        executionId: "exec-1",
        runtimePolicy,
        mcpServerSources: [{ id: "srv", hash: "h" }],
        integrationAccounts: { github: "acct" },
        turnContext: "scheduled"
      },
      ownerSecurityVersion: 7,
      ttlMs: 60_000
    });
  });

  test("the caller's metadata cannot replace the bound fields", async () => {
    const create = fakeCreate();
    await bindTurnToolContext({ create }, {
      ...base,
      ownerSecurityVersion: null,
      turnContext: "interactive",
      metadata: { selectedArtifactIds: ["a"], runtimePolicy: { id: "other" }, turnContext: "scheduled" }
    });
    expect(create.mock.calls[0]![0]).toMatchObject({
      ownerSecurityVersion: null,
      metadata: { selectedArtifactIds: ["a"], runtimePolicy, turnContext: "interactive" }
    });
    expect(create.mock.calls[0]![0].metadata).not.toHaveProperty("executionId");
  });
});
