// Track B AG-UI spike/slice-1 — proves the four handoff invariants hold when an
// @ag-ui/client AbstractAgent subclass drives the REAL mapper pipeline
// (streamEvents v2 to AG-UI) through the
// AGUITurnBackend seam. No infra: a fake backend stands in for the live adapter.

import { EventSchemas, EventType, type BaseEvent } from "@ag-ui/client";
import { firstValueFrom, toArray } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import { DeepAgentsAGUIAgent } from "./deep-agents-agui-agent.js";
import type { AGUIApprovalDecision, AGUITurnBackend } from "./deep-agents-agui-backend.js";
import type { DeepAgentsPendingAction } from "./deep-agents-types.js";

type Raw = Record<string, unknown>;

// v2 streamEvents envelope factories for the fake graph.
const modelText = (text: string): Raw => ({
  event: "on_chat_model_stream",
  data: { chunk: { content: text } }
});
const modelEnd = (): Raw => ({ event: "on_chat_model_end", data: {} });
const toolStart = (name: string, input: unknown, run_id = "tool-run-1"): Raw => ({
  event: "on_tool_start",
  name,
  run_id,
  data: { input }
});
const toolEnd = (name: string, output: unknown, run_id = "tool-run-1"): Raw => ({
  event: "on_tool_end",
  name,
  run_id,
  data: { output }
});

class FakeBackend implements AGUITurnBackend {
  readonly threadId = "thread-1";
  readonly mcpToolNames = new Set<string>();
  readonly mcpToolServers = new Map<string, string>();
  private toolCtx: string | null = null;
  toolContextSeenAtDispatch: string | null | undefined = undefined;
  streamCalls = 0;
  buildResumeCalls = 0;

  constructor(
    private readonly passes: Raw[][],
    private readonly pending: DeepAgentsPendingAction[][] = []
  ) {}

  setToolContext(id: string | null): void {
    this.toolCtx = id;
  }
  buildInitialInput(): unknown {
    return { messages: [{ role: "user", content: "hi" }] };
  }
  async *streamTurn(_input: unknown): AsyncIterable<Raw> {
    const events = this.passes[this.streamCalls] ?? [];
    this.streamCalls += 1;
    for (const ev of events) {
      if (ev.event === "on_tool_start") this.toolContextSeenAtDispatch = this.toolCtx;
      yield ev;
    }
  }
  async getPendingActions(): Promise<DeepAgentsPendingAction[]> {
    return this.pending[this.streamCalls - 1] ?? [];
  }
  async awaitDecisions(
    actions: DeepAgentsPendingAction[],
    emit: (event: BaseEvent) => void
  ): Promise<AGUIApprovalDecision[]> {
    // The backend owns approval emission now (it holds the real approvalId); the
    // driver just delegates. Emit an approval prompt per interrupt, then decide.
    for (const action of actions) {
      emit({
        type: EventType.CUSTOM,
        name: "approval_required",
        value: { interruptId: action.interruptId, toolName: action.name, args: action.args }
      } as BaseEvent);
    }
    return actions.map(() => ({ type: "approve" as const }));
  }
  buildResumeInput(_a: DeepAgentsPendingAction[], _d: AGUIApprovalDecision[]): unknown {
    this.buildResumeCalls += 1;
    return { resume: true };
  }
}

async function collectEvents(agent: DeepAgentsAGUIAgent): Promise<BaseEvent[]> {
  const events = await firstValueFrom(
    agent
      .run({ threadId: "thread-1", runId: "run-1", state: {}, messages: [] } as never)
      .pipe(toArray())
  );
  // Every emitted event must satisfy AG-UI's own schema (what the real
  // runAgent() path enforces via verifyEvents).
  for (const event of events) {
    const result = EventSchemas.safeParse(event);
    expect(result.success, `invalid AG-UI event ${String((event as { type?: string }).type)}`).toBe(
      true
    );
  }
  return events;
}
const types = (events: BaseEvent[]) => events.map((e) => e.type);

describe("DeepAgentsAGUIAgent (Track B)", () => {
  it("emits a well-formed AG-UI stream for a text+tool turn", async () => {
    const backend = new FakeBackend([
      [
        modelText("Hello "),
        modelText("world"),
        modelEnd(),
        toolStart("search", { q: "x" }),
        toolEnd("search", "found")
      ]
    ]);
    const agent = new DeepAgentsAGUIAgent({ backend, toolContextId: "ctx-abc" });
    const events = await collectEvents(agent);

    expect(types(events)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED
    ]);
  });

  // Invariant 1 — toolContextId survives to tool-dispatch time.
  it("injects toolContextId onto the shared ref before the graph dispatches a tool", async () => {
    const backend = new FakeBackend([[toolStart("search", { q: "x" }), toolEnd("search", "ok")]]);
    const agent = new DeepAgentsAGUIAgent({ backend, toolContextId: "ctx-xyz" });
    await collectEvents(agent);
    expect(backend.toolContextSeenAtDispatch).toBe("ctx-xyz");
  });

  // Invariant 4 — write_todos becomes a STATE_DELTA (native state sync), not a
  // tool card.
  it("maps write_todos to a STATE_DELTA on /plan and not a tool card", async () => {
    const todos = [
      { content: "step one", status: "completed" },
      { content: "step two", status: "in_progress" }
    ];
    const backend = new FakeBackend([[toolStart("write_todos", { todos })]]);
    const agent = new DeepAgentsAGUIAgent({ backend, toolContextId: null });
    const events = await collectEvents(agent);

    const stateDelta = events.find((e) => e.type === EventType.STATE_DELTA) as
      | (BaseEvent & { delta: Array<{ op: string; path: string; value: unknown }> })
      | undefined;
    expect(stateDelta).toBeDefined();
    expect(stateDelta?.delta[0]?.path).toBe("/plan");
    expect(String(stateDelta?.delta[0]?.value)).toContain("step one");
    expect(types(events)).not.toContain(EventType.TOOL_CALL_START);
  });

  // Invariant 3 — native HITL interrupt surfaced + resumed via buildResumeInput.
  it("surfaces a native HITL interrupt and resumes via buildResumeInput", async () => {
    const backend = new FakeBackend(
      [[modelText("thinking")], [modelText("done"), modelEnd()]],
      [[{ interruptId: "int-1", name: "delete_file", args: { path: "/x" } }], []]
    );
    const agent = new DeepAgentsAGUIAgent({ backend, toolContextId: "ctx-1" });
    const events = await collectEvents(agent);

    const approval = events.find(
      (e) => e.type === EventType.CUSTOM && (e as { name?: string }).name === "approval_required"
    ) as (BaseEvent & { value: { interruptId: string; toolName: string } }) | undefined;
    expect(approval?.value.interruptId).toBe("int-1");
    expect(approval?.value.toolName).toBe("delete_file");
    expect(backend.streamCalls).toBe(2); // resumed
    expect(backend.buildResumeCalls).toBe(1);
    expect(types(events)).toContain(EventType.RUN_FINISHED);
  });

  it("runs the approval-round keepalive once per round, before each resume", async () => {
    // The approval loop is unbounded, but the tool-context TTL and the
    // active-turn staleness window each budget for ONE approval. Without a
    // keepalive per round, a turn parked on several approvals loses its MCP
    // tools and is stale-evicted while still running. Ordering matters: the
    // extension has to land BEFORE the resume, or the resumed pass can dispatch
    // a tool call against an already-expired context.
    const backend = new FakeBackend(
      [[modelText("one")], [modelText("two")], [modelText("done"), modelEnd()]],
      [
        [{ interruptId: "int-1", name: "delete_file", args: { path: "/x" } }],
        [{ interruptId: "int-2", name: "write_artifact", args: { path: "/y" } }],
        []
      ]
    );
    const order: string[] = [];
    const agent = new DeepAgentsAGUIAgent({
      backend,
      toolContextId: "ctx-1",
      onApprovalRound: async () => {
        order.push(`keepalive:${backend.buildResumeCalls}`);
      }
    });

    await collectEvents(agent);

    // Two approval rounds, so two keepalives — and each one ran while the
    // resume count still showed the rounds completed so far.
    expect(order).toEqual(["keepalive:0", "keepalive:1"]);
    expect(backend.buildResumeCalls).toBe(2);
    expect(backend.streamCalls).toBe(3);
  });

  it("does not run the keepalive on a turn with no approvals", async () => {
    // A turn that never pauses must not touch the TTL: extending on every turn
    // would make the context TTL meaningless for abandoned rows.
    const backend = new FakeBackend([[modelText("hi"), modelEnd()]]);
    let calls = 0;
    const agent = new DeepAgentsAGUIAgent({
      backend,
      toolContextId: "ctx-1",
      onApprovalRound: async () => {
        calls += 1;
      }
    });

    await collectEvents(agent);

    expect(calls).toBe(0);
  });

  it("does not run the keepalive when approval resolution aborts the turn", async () => {
    const backend = new FakeBackend(
      [[modelText("one")], [modelText("done"), modelEnd()]],
      [[{ interruptId: "int-1", name: "delete_file", args: {} }], []]
    );
    const abortController = new AbortController();
    const originalAwaitDecisions = backend.awaitDecisions.bind(backend);
    vi.spyOn(backend, "awaitDecisions").mockImplementation(async (actions, emit) => {
      const decisions = await originalAwaitDecisions(actions, emit);
      abortController.abort();
      return decisions;
    });
    let calls = 0;
    const agent = new DeepAgentsAGUIAgent({
      backend,
      toolContextId: "ctx-1",
      approvalAbortSignal: abortController.signal,
      onApprovalRound: async () => {
        calls += 1;
      }
    });

    await collectEvents(agent);

    expect(calls).toBe(0);
    expect(backend.buildResumeCalls).toBe(1);
  });

  it("completes the turn when no keepalive is wired", async () => {
    // The callback is optional (unit tests, minimal wiring). Its absence must
    // degrade the TTL guarantee, not break the turn.
    const backend = new FakeBackend(
      [[modelText("one")], [modelText("done"), modelEnd()]],
      [[{ interruptId: "int-1", name: "delete_file", args: {} }], []]
    );
    const agent = new DeepAgentsAGUIAgent({ backend, toolContextId: "ctx-1" });

    const events = await collectEvents(agent);

    expect(types(events)).toContain(EventType.RUN_FINISHED);
    expect(backend.buildResumeCalls).toBe(1);
  });

  // Invariant 2 (structural) — the driver reaches the graph ONLY through the
  // tenant-scoped backend seam; one stream pass, no side channel.
  it("drives the turn exclusively through the tenant-scoped backend seam", async () => {
    const backend = new FakeBackend([[modelText("hi"), modelEnd()]]);
    const agent = new DeepAgentsAGUIAgent({ backend, toolContextId: null });
    await collectEvents(agent);
    expect(backend.streamCalls).toBe(1);
  });

  it("flushes an open TEXT message before surfacing a mid-turn error (no dangling card)", async () => {
    // A mid-text abort/failure throws out of streamTurn while a TEXT_MESSAGE is
    // still open. The catch block must flush (TEXT_MESSAGE_END) before
    // subscriber.error — otherwise the UI card hangs open forever.
    const backend: AGUITurnBackend = {
      threadId: "thread-1",
      mcpToolNames: new Set<string>(),
      mcpToolServers: new Map<string, string>(),
      setToolContext() {},
      buildInitialInput: () => ({ messages: [] }),
      async *streamTurn() {
        yield modelText("partial") as Raw;
        throw new Error("provider aborted mid-text");
      },
      async getPendingActions() {
        return [];
      },
      async awaitDecisions() {
        return [];
      },
      buildResumeInput: () => ({})
    };
    const agent = new DeepAgentsAGUIAgent({ backend, toolContextId: null });

    const seen: BaseEvent[] = [];
    const error = await new Promise<unknown>((resolve) => {
      agent.run({ threadId: "thread-1", runId: "run-1", state: {}, messages: [] } as never).subscribe({
        next: (e) => seen.push(e),
        error: (err) => resolve(err),
        complete: () => resolve(null)
      });
    });

    expect((error as Error).message).toBe("provider aborted mid-text");
    // The open TEXT message was flushed (END) before the terminal error, and no
    // RUN_FINISHED was emitted for the failed turn.
    expect(types(seen)).toContain(EventType.TEXT_MESSAGE_END);
    expect(types(seen)).not.toContain(EventType.RUN_FINISHED);
    // The END for the text message is the last event before the error surfaces.
    expect(types(seen).at(-1)).toBe(EventType.TEXT_MESSAGE_END);
  });

  it("halts the backend turn on unsubscribe — the loop returns before pending-action collection", async () => {
    // The teardown sets cancelled=true; the `if (cancelled) return` inside the
    // stream loop must then STOP driving the backend. Observable effect: the loop
    // returns on the first raw event instead of finishing the pass, so
    // getPendingActions (which the loop calls only after a full pass) is never
    // reached — and the terminal RUN_FINISHED never reaches the torn-down
    // subscriber. The stream defers its first raw event to a macrotask so the
    // deferred unsubscribe wins the race.
    let pendingActionsChecked = false;
    const backend: AGUITurnBackend = {
      threadId: "thread-1",
      mcpToolNames: new Set<string>(),
      mcpToolServers: new Map<string, string>(),
      setToolContext() {},
      buildInitialInput: () => ({ messages: [] }),
      async *streamTurn() {
        await new Promise((r) => setTimeout(r, 0));
        yield modelText("late") as Raw;
        yield modelEnd() as Raw;
      },
      async getPendingActions() {
        pendingActionsChecked = true;
        return [];
      },
      async awaitDecisions() {
        return [];
      },
      buildResumeInput: () => ({})
    };
    const agent = new DeepAgentsAGUIAgent({ backend, toolContextId: null });

    const seen: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      // RUN_STARTED is emitted synchronously during subscribe(), before the
      // returned subscription is assigned — defer teardown to a microtask (still
      // ahead of the stream's macrotask-delayed first raw event).
      const sub = agent
        .run({ threadId: "thread-1", runId: "run-1", state: {}, messages: [] } as never)
        .subscribe({
          next: (e) => {
            seen.push(e);
            queueMicrotask(() => sub.unsubscribe());
          }
        });
      // Let the backend's delayed stream run to completion (were the guard gone).
      setTimeout(resolve, 20);
    });

    // Only RUN_STARTED reached the subscriber; the loop returned on `cancelled`
    // before the pass finished, so pending-action collection and RUN_FINISHED
    // never happened.
    expect(types(seen)).toEqual([EventType.RUN_STARTED]);
    expect(types(seen)).not.toContain(EventType.RUN_FINISHED);
    expect(pendingActionsChecked).toBe(false);
  });
});
