import { test, expect } from "vitest";

import { AsyncQueue } from "../../lib/async-queue.js";
import type { RuntimeEvent } from "../../runtime-contracts.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { phase4RuntimePolicy } from "../../test-helpers/phase4-runtime-policy.js";
import type { ApprovalStore } from "../auth/approval-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { ToolEventStore } from "../tool-event-store.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { CodexSessionLifecycle } from "./codex-session-lifecycle.js";
import { CodexTurnOrchestrator } from "./codex-turn-orchestrator.js";
import type { JsonRpcNotification } from "./codex-jsonrpc.js";
import type { ActiveTurnState, RuntimeProcessHandle, RuntimeState } from "./runtime-types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// A fake process that records the JSON-RPC requests it receives and whose
// liveness + turn/start behavior can be steered per-test. `turnStartImpl`
// drives the recovery branches: throwing simulates a process that died
// mid-request.
class FakeRuntimeProcess {
  readonly port = 4123;
  readonly pid = 9876;
  readonly requestLog: Array<{ method: string; params: Record<string, unknown> }> = [];
  alive = true;
  terminateCount = 0;
  turnStartImpl: () => Promise<{ turn?: { id: string } }> = async () => ({ turn: { id: "turn-1" } });

  isAlive(): boolean {
    return this.alive;
  }

  async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.requestLog.push({ method, params });
    if (method === "turn/start") {
      return (await this.turnStartImpl()) as T;
    }
    return {} as T;
  }

  terminate(): void {
    this.terminateCount += 1;
    this.alive = false;
  }
}

function makeActiveTurn(overrides: Partial<ActiveTurnState> = {}): ActiveTurnState {
  return {
    queue: new AsyncQueue<RuntimeEvent>(),
    responseId: "resp-1",
    outputItemDone: false,
    watchdogTimer: null,
    runtimePolicyId: "default",
    toolContextId: null,
    assistantMessageId: null,
    model: null,
    effort: null,
    autoApprovedKinds: new Set(),
    ...overrides
  };
}

function makeRuntime(opts: {
  proc: FakeRuntimeProcess;
  runtimeId?: string;
  activeTurn?: ActiveTurnState | null;
}): RuntimeState {
  return {
    tenantId: "t",
    sessionId: "s",
    userId: "u",
    runtimeId: opts.runtimeId ?? "rt",
    provider: "codex",
    workspacePath: "/tmp/ws",
    manifestPath: "/tmp/manifest.json",
    manifest: {} as RuntimeState["manifest"],
    // buildTurnInputs reads enabledMcpServers + id; a real policy keeps it honest.
    runtimePolicy: phase4RuntimePolicy as unknown as RuntimeState["runtimePolicy"],
    process: opts.proc as unknown as RuntimeProcessHandle,
    threadId: "thread",
    activeTurn: opts.activeTurn === undefined ? makeActiveTurn() : opts.activeTurn,
    staleTurnIds: new Set(),
    pendingApprovals: new Map(),
    pendingApprovalTimers: new Map(),
    idleTimer: null,
    healthStatus: "healthy",
    startedAt: "now",
    lastActiveAt: "now",
    terminatedAt: null,
    lifecycleMetadata: {},
    shutdownReason: null,
    finalized: false,
    closed: false
  };
}

type LifecycleCall =
  | { fn: "ensureRuntime"; sessionId: string }
  | { fn: "persistRuntime"; runtimeId: string; status: string }
  | { fn: "scheduleIdleTeardown"; runtimeId: string }
  | { fn: "clearIdleTimer"; runtimeId: string }
  | { fn: "touchRuntime"; runtimeId: string; activity: string };

// A fake lifecycle exposing only the methods the orchestrator touches. The
// `runtimes` Map is the ownerRuntime registry the retry-failure branch
// reconciles against.
function makeLifecycle(opts: {
  ensureRuntimeImpl?: () => Promise<RuntimeState>;
  runtimes?: Map<string, RuntimeState>;
}): { lifecycle: CodexSessionLifecycle; calls: LifecycleCall[] } {
  const calls: LifecycleCall[] = [];
  const runtimes = opts.runtimes ?? new Map<string, RuntimeState>();

  const lifecycle = {
    runtimes,
    async ensureRuntime(_tenantId: string, sessionId: string) {
      calls.push({ fn: "ensureRuntime", sessionId });
      if (!opts.ensureRuntimeImpl) {
        throw new Error("ensureRuntime not configured for this test");
      }
      return opts.ensureRuntimeImpl();
    },
    async persistRuntime(runtime: RuntimeState, status: string) {
      calls.push({ fn: "persistRuntime", runtimeId: runtime.runtimeId, status });
    },
    scheduleIdleTeardown(runtime: RuntimeState) {
      calls.push({ fn: "scheduleIdleTeardown", runtimeId: runtime.runtimeId });
    },
    clearIdleTimer(runtime: RuntimeState) {
      calls.push({ fn: "clearIdleTimer", runtimeId: runtime.runtimeId });
    },
    touchRuntime(runtime: RuntimeState, activity: string) {
      calls.push({ fn: "touchRuntime", runtimeId: runtime.runtimeId, activity });
    }
  } as unknown as CodexSessionLifecycle;

  return { lifecycle, calls };
}

function makeDeps(approvalTtlMs = 60_000) {
  const toolEventCalls: unknown[] = [];
  const deps = {
    logger: createSilentLogger(),
    approvals: {
      async create() {
        return {} as unknown as Awaited<ReturnType<ApprovalStore["create"]>>;
      },
      async expire() {
        return null;
      }
    } as unknown as ApprovalStore,
    auditEvents: {
      async create() {
        return {} as unknown as Awaited<ReturnType<AuditEventStore["create"]>>;
      }
    } as unknown as AuditEventStore,
    toolEvents: {
      async create(input: unknown) {
        toolEventCalls.push(input);
        return {} as unknown as Awaited<ReturnType<ToolEventStore["create"]>>;
      }
    } as unknown as ToolEventStore,
    artifacts: {} as unknown as ArtifactStore,
    storage: {} as unknown as ArtifactStorage,
    approvalTtlMs
  };
  return { deps, toolEventCalls };
}

// Drain an AsyncQueue that has already been ended (the orchestrator ends the
// queue on every terminal frame). Reading after `end()` returns buffered values
// then completes.
async function drain(queue: AsyncQueue<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const v of queue) out.push(v);
  return out;
}

const startFn = async () => {
  throw new Error("startRuntimeFn should be passed through to ensureRuntime, never called directly");
};

// ---------------------------------------------------------------------------
// Branch 1: startTurn — process dies during start, runtime is restarted
// ---------------------------------------------------------------------------

test("startTurn: process dies mid-start, restarts via ensureRuntime and re-points the active turn", async () => {
  const deadProc = new FakeRuntimeProcess();
  // turn/start rejects AND the process reports dead afterward -> restart path.
  deadProc.turnStartImpl = async () => {
    deadProc.alive = false;
    throw new Error("socket hang up");
  };
  const activeTurn = makeActiveTurn();
  const runtime = makeRuntime({ proc: deadProc, runtimeId: "rt-dead", activeTurn });

  const freshProc = new FakeRuntimeProcess();
  const restarted = makeRuntime({ proc: freshProc, runtimeId: "rt-fresh", activeTurn: null });

  const { lifecycle, calls } = makeLifecycle({
    ensureRuntimeImpl: async () => restarted
  });
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  await orchestrator.startTurn(runtime, "hello world");

  // ensureRuntime was invoked to obtain a live runtime for the same session.
  expect(calls.some((c) => c.fn === "ensureRuntime" && c.sessionId === "s")).toBe(true);

  // The active turn was re-pointed onto the restarted runtime and cleared off the dead one.
  expect(restarted.activeTurn).toBe(activeTurn);
  expect(runtime.activeTurn).toBeNull();

  // turn/start was re-issued on the FRESH process (the dead one threw).
  expect(freshProc.requestLog.some((r) => r.method === "turn/start")).toBe(true);

  // The turn was NOT failed — the restart succeeded, so the queue stays open
  // with a response.created frame seeded by executeStartTurnRequest.
  activeTurn.queue.end();
  const events = await drain(activeTurn.queue);
  expect(events.map((e) => e.type)).toContain("response.created");
  expect(events.some((e) => e.type === "response.failed")).toBe(false);
});

// ---------------------------------------------------------------------------
// Branch 2: startTurn — restart succeeds but the retried turn/start ALSO fails
// ---------------------------------------------------------------------------

test("startTurn retry-fails: reconciles ownerRuntime and fails the turn on the registered runtime", async () => {
  const deadProc = new FakeRuntimeProcess();
  deadProc.turnStartImpl = async () => {
    deadProc.alive = false;
    throw new Error("first start failed");
  };
  const activeTurn = makeActiveTurn();
  const runtime = makeRuntime({ proc: deadProc, runtimeId: "rt-dead", activeTurn });

  // Restarted runtime's turn/start also throws -> retryError path.
  const freshProc = new FakeRuntimeProcess();
  freshProc.turnStartImpl = async () => {
    throw new Error("retry start failed");
  };
  const restarted = makeRuntime({ proc: freshProc, runtimeId: "rt-fresh", activeTurn: null });

  // ownerRuntime registry: the session's current runtime is the restarted one,
  // and its activeTurn is the same object -> failActiveTurn targets `restarted`.
  const runtimes = new Map<string, RuntimeState>();
  runtimes.set("s", restarted);

  const { lifecycle, calls } = makeLifecycle({
    ensureRuntimeImpl: async () => restarted,
    runtimes
  });
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  await orchestrator.startTurn(runtime, "hello");

  // Reconciliation targeted the OWNER runtime (rt-fresh) for the terminal
  // error persist + teardown — NOT the dead runtime. (rt-fresh also gets a
  // transient persist("active") from executeStartTurnRequest before the retry
  // throws; we assert specifically on the error-status persist.)
  expect(calls).toContainEqual({ fn: "persistRuntime", runtimeId: "rt-fresh", status: "error" });
  expect(calls).toContainEqual({ fn: "scheduleIdleTeardown", runtimeId: "rt-fresh" });
  expect(calls.some((c) => c.fn === "persistRuntime" && c.runtimeId === "rt-dead" && c.status === "error")).toBe(
    false
  );
  expect(calls.some((c) => c.fn === "scheduleIdleTeardown" && c.runtimeId === "rt-dead")).toBe(false);

  // The turn was failed off the owner runtime.
  expect(restarted.activeTurn).toBeNull();
  const events = await drain(activeTurn.queue);
  expect(events.some((e) => e.type === "response.failed")).toBe(true);
});

test("startTurn retry-fails fallback: owner runtime is not holding this turn, fails the original runtime", async () => {
  const deadProc = new FakeRuntimeProcess();
  deadProc.turnStartImpl = async () => {
    deadProc.alive = false;
    throw new Error("first start failed");
  };
  const activeTurn = makeActiveTurn();
  const runtime = makeRuntime({ proc: deadProc, runtimeId: "rt-dead", activeTurn });

  const freshProc = new FakeRuntimeProcess();
  freshProc.turnStartImpl = async () => {
    throw new Error("retry start failed");
  };
  const restarted = makeRuntime({ proc: freshProc, runtimeId: "rt-fresh", activeTurn: null });

  // No runtime registered for the session (or one whose activeTurn differs) ->
  // fallback branch fails the ORIGINAL runtime.
  const runtimes = new Map<string, RuntimeState>();

  const { lifecycle, calls } = makeLifecycle({
    ensureRuntimeImpl: async () => restarted,
    runtimes
  });
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  await orchestrator.startTurn(runtime, "hello");

  // Fallback targets the original (dead) runtime for the terminal error
  // persist/teardown. (rt-dead also gets a transient persist("active") from the
  // first executeStartTurnRequest; we assert specifically on the error-status
  // persist + on the absence of any error/teardown for rt-fresh.)
  expect(calls).toContainEqual({ fn: "persistRuntime", runtimeId: "rt-dead", status: "error" });
  expect(calls).toContainEqual({ fn: "scheduleIdleTeardown", runtimeId: "rt-dead" });
  expect(calls.some((c) => c.fn === "persistRuntime" && c.runtimeId === "rt-fresh" && c.status === "error")).toBe(
    false
  );
  expect(calls.some((c) => c.fn === "scheduleIdleTeardown" && c.runtimeId === "rt-fresh")).toBe(false);

  // In the fallback branch the original runtime's activeTurn was already moved
  // onto `restarted` during the restart, so failActiveTurn(runtime) targets a
  // null slot — the persist/teardown reconciliation is the observable signal,
  // not a terminal queue frame.
  expect(runtime.activeTurn).toBeNull();
  expect(restarted.activeTurn).toBe(activeTurn);

  // Drain to confirm no terminal frame leaked onto the (open) queue.
  activeTurn.queue.end();
  const events = await drain(activeTurn.queue);
  expect(events.some((e) => e.type === "response.failed")).toBe(false);
});

test("startTurn: turn released while turn/start is in flight — marks the unowned id stale and interrupts it", async () => {
  const proc = new FakeRuntimeProcess();
  const activeTurn = makeActiveTurn({ responseId: null });
  const runtime = makeRuntime({ proc, activeTurn });

  // The consumer abandons the turn (runMessage finally releases the slot)
  // while the turn/start RPC is still awaiting its response.
  proc.turnStartImpl = async () => {
    runtime.activeTurn = null;
    return { turn: { id: "turn-zombie" } };
  };

  const { lifecycle } = makeLifecycle({});
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  await orchestrator.startTurn(runtime, "hello");

  // The unowned process-side turn is registered stale and interrupted.
  expect(runtime.staleTurnIds.has("turn-zombie")).toBe(true);
  const interrupts = proc.requestLog.filter((r) => r.method === "turn/interrupt");
  expect(interrupts).toEqual([
    { method: "turn/interrupt", params: { threadId: "thread", turnId: "turn-zombie" } }
  ]);

  // No response.created leaked onto the released turn's queue.
  activeTurn.queue.end();
  const events = await drain(activeTurn.queue);
  expect(events).toEqual([]);
});

// ---------------------------------------------------------------------------
// Branch 3: interruptActiveTurn
// ---------------------------------------------------------------------------

test("interruptActiveTurn: emits a terminal interrupted completion, ends queue, nulls turn, leaves process alive", async () => {
  const proc = new FakeRuntimeProcess();
  const activeTurn = makeActiveTurn({ responseId: "resp-7", outputItemDone: false });
  const runtime = makeRuntime({ proc, activeTurn });

  const { lifecycle } = makeLifecycle({});
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  orchestrator.interruptActiveTurn(runtime);

  // Active turn slot released; runtime marked healthy (re-usable warm session).
  expect(runtime.activeTurn).toBeNull();
  expect(runtime.healthStatus).toBe("healthy");

  // Process is left alive — interruption keeps the session warm.
  expect(proc.terminateCount).toBe(0);
  expect(proc.isAlive()).toBe(true);

  // Queue was ended; drain yields synthetic output_item.done then the terminal
  // interrupted completion.
  const events = await drain(activeTurn.queue);
  expect(events.map((e) => e.type)).toEqual([
    "response.output_item.done",
    "response.completed"
  ]);
  const completed = events.find((e) => e.type === "response.completed") as Extract<
    RuntimeEvent,
    { type: "response.completed" }
  >;
  expect(completed.interrupted).toBe(true);
  expect(completed.responseId).toBe("resp-7");
});

test("interruptActiveTurn: skips synthetic output_item.done when the turn already emitted it", async () => {
  const proc = new FakeRuntimeProcess();
  const activeTurn = makeActiveTurn({ outputItemDone: true });
  const runtime = makeRuntime({ proc, activeTurn });

  const { lifecycle } = makeLifecycle({});
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  orchestrator.interruptActiveTurn(runtime);

  const events = await drain(activeTurn.queue);
  expect(events.map((e) => e.type)).toEqual(["response.completed"]);
  const completed = events[0] as Extract<RuntimeEvent, { type: "response.completed" }>;
  expect(completed.interrupted).toBe(true);
});

test("interruptActiveTurn: no-op when there is no active turn", () => {
  const proc = new FakeRuntimeProcess();
  const runtime = makeRuntime({ proc, activeTurn: null });

  const { lifecycle } = makeLifecycle({});
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  // Does not throw and does not touch the process.
  orchestrator.interruptActiveTurn(runtime);
  expect(proc.terminateCount).toBe(0);
  expect(runtime.activeTurn).toBeNull();
});

// ---------------------------------------------------------------------------
// Branch 4: handleNotification runtime-error retrying vs terminal
// ---------------------------------------------------------------------------

// The orchestrator binds handleNotification through process.onNotification; the
// `error` notification maps to kind:"runtime-error". `willRetry` controls the
// retrying flag in the mapper, which is the only observable input to the branch.
function bindAndEmit(
  orchestrator: CodexTurnOrchestrator,
  runtime: RuntimeState,
  proc: FakeRuntimeProcess,
  notification: JsonRpcNotification
): void {
  // bindProcessHandlers registers the onNotification listener that dispatches
  // into handleNotification. We re-create that wiring by registering through
  // the public binder, then invoke the recorded listener.
  const listeners: Array<(n: JsonRpcNotification) => void> = [];
  (proc as unknown as { onNotification: (l: (n: JsonRpcNotification) => void) => void }).onNotification = (
    l
  ) => {
    listeners.push(l);
  };
  // No-op the other handler registrations bindProcessHandlers performs.
  const procAny = proc as unknown as Record<string, unknown>;
  procAny.onExit = () => {};
  procAny.onRequest = () => {};
  procAny.onClose = () => {};

  orchestrator.bindProcessHandlers(runtime);
  for (const l of listeners) l(notification);
}

test("handleNotification runtime-error (retrying:false): emits an error notice AND fails the turn", async () => {
  const proc = new FakeRuntimeProcess();
  const activeTurn = makeActiveTurn({ responseId: "resp-err" });
  const runtime = makeRuntime({ proc, activeTurn });

  const { lifecycle, calls } = makeLifecycle({});
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  // A v2 `error` notification without willRetry maps to runtime-error with
  // retrying:false, which drives the terminal-error branch.
  bindAndEmit(orchestrator, runtime, proc, {
    method: "error",
    params: { error: { message: "the model crashed" } }
  });

  // Turn was failed (terminal path): slot released, status error.
  expect(runtime.activeTurn).toBeNull();
  expect(runtime.healthStatus).toBe("error");

  // Terminal-error branch persisted error + scheduled teardown.
  expect(calls).toContainEqual({ fn: "persistRuntime", runtimeId: "rt", status: "error" });
  expect(calls.some((c) => c.fn === "scheduleIdleTeardown")).toBe(true);

  // The queue carries a level:"error" runtime_notice followed by response.failed.
  const events = await drain(activeTurn.queue);
  const notice = events.find((e) => e.type === "framework:runtime_notice") as Extract<
    RuntimeEvent,
    { type: "framework:runtime_notice" }
  >;
  expect(notice).toBeDefined();
  expect(notice.level).toBe("error");
  expect(notice.message).toBe("the model crashed");
  expect(events.some((e) => e.type === "response.failed")).toBe(true);
});

// ---------------------------------------------------------------------------
// Branch 5: handleNotification turn-id scoping
// ---------------------------------------------------------------------------

test("handleNotification: interrupted turn's notifications are dropped before the next turn's id is assigned", async () => {
  const proc = new FakeRuntimeProcess();
  const turnA = makeActiveTurn({ responseId: "turn-A" });
  const runtime = makeRuntime({ proc, activeTurn: turnA });

  const { lifecycle } = makeLifecycle({});
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  // Stop button: terminal frame synthesized without waiting for the runtime's
  // own turn/completed — turn-A becomes a zombie that may keep emitting.
  orchestrator.interruptActiveTurn(runtime);
  expect(runtime.staleTurnIds.has("turn-A")).toBe(true);

  // Next turn starts; turn/start has not returned yet (responseId still null).
  const turnB = makeActiveTurn({ responseId: null });
  runtime.activeTurn = turnB;

  // Zombie delta must NOT land in turn B's queue.
  bindAndEmit(orchestrator, runtime, proc, {
    method: "item/agentMessage/delta",
    params: { delta: "zombie text", turnId: "turn-A", threadId: "thread", itemId: "item-1" }
  });

  // Zombie turn/completed must NOT terminate turn B; it retires the stale entry.
  bindAndEmit(orchestrator, runtime, proc, {
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-A", status: "completed", items: [] } }
  });
  expect(runtime.activeTurn).toBe(turnB);
  expect(runtime.staleTurnIds.has("turn-A")).toBe(false);

  // Once turn B's id is assigned, its own notifications flow normally.
  turnB.responseId = "turn-B";
  bindAndEmit(orchestrator, runtime, proc, {
    method: "item/agentMessage/delta",
    params: { delta: "real text", turnId: "turn-B", threadId: "thread", itemId: "item-2" }
  });

  turnB.queue.end();
  const events = await drain(turnB.queue);
  expect(events).toEqual([
    { type: "response.output_text.delta", responseId: "turn-B", delta: "real text" }
  ]);
});

test("handleNotification: drops notifications whose turnId mismatches the active turn", async () => {
  const proc = new FakeRuntimeProcess();
  const turnB = makeActiveTurn({ responseId: "turn-B" });
  const runtime = makeRuntime({ proc, activeTurn: turnB });

  const { lifecycle, calls } = makeLifecycle({});
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  // A stray delta from an unknown old turn (not on the stale list) is dropped.
  bindAndEmit(orchestrator, runtime, proc, {
    method: "item/agentMessage/delta",
    params: { delta: "stray", turnId: "turn-A", threadId: "thread", itemId: "item-1" }
  });

  // An old turn/completed must not terminate the active turn.
  bindAndEmit(orchestrator, runtime, proc, {
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-A", status: "completed", items: [] } }
  });
  expect(runtime.activeTurn).toBe(turnB);
  expect(calls.some((c) => c.fn === "persistRuntime" || c.fn === "scheduleIdleTeardown")).toBe(false);

  // Notifications without a turn id are not turn-scoped and still pass through.
  bindAndEmit(orchestrator, runtime, proc, {
    method: "mcpServer/startupStatus/updated",
    params: { name: "github", status: "ready" }
  });

  // The active turn's own notifications are delivered.
  bindAndEmit(orchestrator, runtime, proc, {
    method: "item/agentMessage/delta",
    params: { delta: "mine", turnId: "turn-B", threadId: "thread", itemId: "item-2" }
  });

  turnB.queue.end();
  const events = await drain(turnB.queue);
  expect(events).toEqual([
    { type: "framework:mcp_server_status", serverName: "github", status: "ready", error: undefined },
    { type: "response.output_text.delta", responseId: "turn-B", delta: "mine" }
  ]);
});

test("handleNotification: the active turn's own turn/completed still completes it and marks it stale", async () => {
  const proc = new FakeRuntimeProcess();
  const turnA = makeActiveTurn({ responseId: "turn-A" });
  const runtime = makeRuntime({ proc, activeTurn: turnA });

  const { lifecycle } = makeLifecycle({});
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  bindAndEmit(orchestrator, runtime, proc, {
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn-A", status: "completed", items: [] } }
  });

  expect(runtime.activeTurn).toBeNull();
  // Any post-completion straggler for turn-A (item/completed flushed late) is
  // now identifiable as stale.
  expect(runtime.staleTurnIds.has("turn-A")).toBe(true);
  const events = await drain(turnA.queue);
  expect(events.map((e) => e.type)).toEqual(["response.output_item.done", "response.completed"]);
});

test("handleNotification runtime-error (retrying:true): emits a warning notice and does NOT fail the turn", async () => {
  const proc = new FakeRuntimeProcess();
  const activeTurn = makeActiveTurn({ responseId: "resp-warn" });
  const runtime = makeRuntime({ proc, activeTurn });

  const { lifecycle, calls } = makeLifecycle({});
  const { deps } = makeDeps();
  const orchestrator = new CodexTurnOrchestrator(deps, lifecycle, startFn);

  // `error` with willRetry:true maps to runtime-error with retrying:true.
  bindAndEmit(orchestrator, runtime, proc, {
    method: "error",
    params: { error: { message: "transient reconnect" }, willRetry: true }
  });

  // The turn is NOT failed — it stays active for the retry.
  expect(runtime.activeTurn).toBe(activeTurn);

  // No error persistence / teardown on the retrying path.
  expect(calls.some((c) => c.fn === "persistRuntime")).toBe(false);
  expect(calls.some((c) => c.fn === "scheduleIdleTeardown")).toBe(false);

  // A single warning runtime_notice is queued; the queue stays open (no terminal frame).
  expect(activeTurn.queue.push({ type: "response.created", responseId: "probe" })).toBe(true);
  activeTurn.queue.end();
  const events = await drain(activeTurn.queue);
  const notice = events.find((e) => e.type === "framework:runtime_notice") as Extract<
    RuntimeEvent,
    { type: "framework:runtime_notice" }
  >;
  expect(notice).toBeDefined();
  expect(notice.level).toBe("warning");
  expect(notice.title).toBe("Runtime reconnecting");
  expect(events.some((e) => e.type === "response.failed")).toBe(false);
});
