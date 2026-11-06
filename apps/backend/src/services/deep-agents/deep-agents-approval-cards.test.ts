// Inline approvals: the server ID of a proposed tool call, from the real
// compiled graph with LangChain's HITL middleware, through the AG-UI driver
// and its backend, to the turn transcript and the saved-history converter. The
// models are scripted and the approvals are decided here; the graph, the HITL
// middleware, the tool node, the event tracer and the callbacks are real.

import { EventType, verifyEvents, type BaseEvent } from "@ag-ui/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalsListResponseSchema } from "@cogniplane/shared-types";

import fixture from "../../../../../test-fixtures/agui/pending-approval-history.json" with { type: "json" };
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { toAguiMessages, type HistoryMessage } from "../agui-history.js";
import { TurnTranscript, type TurnTranscriptMessages } from "../turn-transcript.js";

type Call = { id: string; name: string; args: Record<string, unknown> };
type Step = Call[] | string;
const script = vi.hoisted(() => ({ steps: [] as Step[] }));
const wire = vi.hoisted(() => ({ calls: [] as Array<{ name: string; _meta?: Record<string, unknown> }> }));

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessageChunk } = await import("@langchain/core/messages");
  // One model for the main agent and delegated work: each call answers with
  // the next step of the script.
  class ScriptedModel extends FakeStreamingChatModel {
    override bindTools() { return this.withConfig({}); }
    override async *_streamResponseChunks(...args: Parameters<InstanceType<typeof FakeStreamingChatModel>["_streamResponseChunks"]>) {
      const step = script.steps.shift() ?? "Done.";
      this.chunks = [typeof step === "string" ? new AIMessageChunk({ content: step })
        : new AIMessageChunk({ content: "", tool_calls: step })];
      yield* super._streamResponseChunks(...args);
    }
  }
  return { ...actual, initChatModel: () => Promise.resolve(new ScriptedModel({ sleep: 0 })) };
});

vi.mock("@langchain/mcp-adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/mcp-adapters")>();
  // One managed gateway server with one strict tool. The real adapter tools
  // and the client facade run on top of it.
  class FakeMCPAdapter {
    async getClient(serverId: string) {
      return {
        getProtocolEra: () => "legacy",
        listTools: async () => ({ tools: [{ name: "write_artifact", description: "Save a file", inputSchema: {
          type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } }] }),
        callTool: async (params: { name: string; _meta?: Record<string, unknown> }) => {
          wire.calls.push({ name: params.name, _meta: params._meta });
          return { content: [{ type: "text", text: `saved on ${serverId}` }] };
        }
      };
    }
    close() { return Promise.resolve(); }
  }
  return { ...actual, MCPAdapter: FakeMCPAdapter };
});

import { createDeepAgentsSessionRuntime } from "./deep-agents-graph.js";
import { createSessionAGUITurnBackend, type AGUIApprovalDecision } from "./deep-agents-agui-backend.js";
import { DeepAgentsAGUIAgent } from "./deep-agents-agui-agent.js";
import type { DeepAgentsPendingAction, DeepAgentsSessionRuntime } from "./deep-agents-types.js";

const MODEL = "deepagents/claude-sonnet-5";
const NATIVE = { gate: true, autoApproveReadOnly: true, readOnlyToolNames: [] };
const DENIED = "User denied permission.";
const write = (id: string, file: string): Call => ({ id, name: "write_file", args: { file_path: `/${file}`, content: file } });

const runtimes: DeepAgentsSessionRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  script.steps = [];
  wire.calls.length = 0;
});

function nativeRuntime() {
  const runtime = createDeepAgentsSessionRuntime({
    tenantId: "t1", sessionId: "s1", userId: "u1", runtimeId: "r1", resolveProviderKey: async () => "key",
    providerBaseUrls: null, systemPrompt: null, workspacePath: "/w", e2b: null, logger: createSilentLogger(),
    approvals: NATIVE
  });
  runtimes.push(runtime);
  return runtime;
}

function policyRuntime() {
  const context = { toolContextId: "ctx", turnContext: "interactive" as const, enforcementMode: "enforce" as const };
  const runtime = createDeepAgentsSessionRuntime({
    tenantId: "t1", sessionId: "s1", userId: "u1", runtimeId: "r1", resolveProviderKey: async () => "key",
    providerBaseUrls: null, systemPrompt: null, workspacePath: "/w", e2b: null, logger: createSilentLogger(),
    mcpServers: [{ id: "managed", mode: "managed", url: "http://gateway/mcp/managed", authorization: "Bearer t" }],
    // The native gate is off: only Policy Center asks.
    approvals: { gate: false, autoApproveReadOnly: true, readOnlyToolNames: [] },
    toolContextRef: { current: "ctx" }, policyContextRef: { current: context },
    policyService: { evaluate: async () => ({ outcome: "require_approval", gating: true, matchedRuleId: "rule-1",
      matchedRuleName: "Review writes", explanation: "Review writes." }) } as never
  });
  runtimes.push(runtime);
  return runtime;
}

type Asked = { actions: DeepAgentsPendingAction[]; shown: BaseEvent[] };
type Decide = (actions: DeepAgentsPendingAction[]) => AGUIApprovalDecision[] | Promise<AGUIApprovalDecision[]>;

/** One turn through the AG-UI driver. Each approval round records what the browser has at that point. */
async function runTurn(runtime: DeepAgentsSessionRuntime, input: { decide?: Decide; abort?: AbortController; prompt?: string } = {}) {
  const events: BaseEvent[] = [];
  const asked: Asked[] = [];
  const backend = createSessionAGUITurnBackend({
    threadId: "thread-1", runtime, toolContextRef: { current: null }, modelId: MODEL, promptText: input.prompt ?? "Go",
    signal: input.abort?.signal,
    awaitDecisions: async (actions, emit) => {
      asked.push({ actions, shown: [...events] });
      for (const action of actions) {
        emit({ type: EventType.CUSTOM, name: "approval_required", value: { approvalId: `ap-${action.name}`, itemId: "x",
          kind: "file_change", title: action.name, summary: "", ...(action.toolCallId ? { toolCallId: action.toolCallId } : {}) } } as BaseEvent);
      }
      return input.decide ? input.decide(actions) : actions.map(() => ({ type: "approve" as const }));
    }
  });
  const agent = new DeepAgentsAGUIAgent({ backend, toolContextId: null, approvalAbortSignal: input.abort?.signal });
  let error: unknown = null;
  await new Promise<void>((resolve) => {
    agent.run({ threadId: "thread-1", runId: "run-1", state: {}, messages: [] } as never).pipe(verifyEvents()).subscribe({
      next: (event) => events.push(event),
      error: (err: unknown) => { error = err; resolve(); },
      complete: resolve
    });
  });
  return { events, asked, error };
}

type ToolStart = { toolCallId: string; toolCallName: string };
const toolStarts = (events: BaseEvent[]) => events.filter((event) => event.type === EventType.TOOL_CALL_START) as unknown as ToolStart[];
const toolResults = (events: BaseEvent[]) => events.filter((event) => event.type === EventType.TOOL_CALL_RESULT) as unknown as Array<{ toolCallId: string; content: string }>;
const toolStatuses = (events: BaseEvent[]) => events.flatMap((event) =>
  event.type === EventType.CUSTOM && (event as { name?: string }).name === "tool_status" ? [(event as unknown as { value: { toolCallId: string; status: string } }).value] : []);

/** The rows that the turn transcript saves for the turn, as the history converter reads them. */
async function savedTurn(events: BaseEvent[], finalize: boolean): Promise<HistoryMessage[]> {
  const saved = new Map<string, Record<string, unknown>>();
  let content = "";
  let status: HistoryMessage["status"] = "streaming";
  const messages = {
    updateContent: async (_t: string, _m: string, _u: string, outcome: HistoryMessage["status"], text: string) => {
      status = outcome; content = text; return {} as never;
    },
    updateStreamingContent: async () => ({}) as never,
    setRuntimeNotices: async () => undefined,
    upsertToolResult: async (row: Record<string, unknown>) => { saved.set(String(row.toolResultId), row); return row as never; }
  } as unknown as TurnTranscriptMessages;
  const transcript = new TurnTranscript({ messages, tenantId: "t1", sessionId: "s1", userId: "u1", messageId: "a1" });
  for (const event of events) transcript.apply(event, { saveProgress: true });
  await transcript.settleProgress();
  if (finalize) await transcript.finalize();
  return [
    { messageId: "u1", role: "user", status: "completed", content: "Go" },
    { messageId: "a1", role: "assistant", status, content,
      toolResults: [...saved.values()] as unknown as HistoryMessage["toolResults"] }
  ];
}

describe("inline approvals through the real graph (native HITL)", () => {
  it("shows the proposed call before the approval, names it in the approval, and gives the result the same ID", async () => {
    script.steps = [[write("call-1", "a.txt")], "Done."];
    const { events, asked, error } = await runTurn(nativeRuntime());

    expect(error).toBeNull();
    expect(asked).toHaveLength(1);
    const [card] = toolStarts(asked[0]!.shown);
    expect(card).toMatchObject({ toolCallName: "write_file" });
    // A server ID, never the model's.
    expect(card!.toolCallId).not.toBe("call-1");
    expect(asked[0]!.actions).toEqual([expect.objectContaining({ name: "write_file", modelCallId: "call-1", toolCallId: card!.toolCallId })]);
    // The approved call runs in the same card: one start, one result.
    expect(toolStarts(events)).toEqual([card]);
    expect(toolResults(events)).toEqual([expect.objectContaining({ toolCallId: card!.toolCallId })]);
    expect(toolStatuses(events)).toEqual([]);
  });

  it("gives a declined call the model's message as its result; the card stays declined after a reload", async () => {
    script.steps = [[write("call-1", "notes.md")], "Not saved."];
    const { events, asked } = await runTurn(nativeRuntime(), { decide: (actions) => actions.map(() => ({ type: "reject", message: DENIED })) });

    const id = asked[0]!.actions[0]!.toolCallId!;
    expect(toolStarts(events).map((start) => start.toolCallId)).toEqual([id]);
    expect(toolResults(events)).toEqual([expect.objectContaining({ toolCallId: id, content: DENIED })]);
    expect(toolStatuses(events)).toEqual([expect.objectContaining({ toolCallId: id, status: "declined" })]);

    const saved = await savedTurn(events, true);
    const history = toAguiMessages(saved);
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", toolCalls: [expect.objectContaining({ id })] }),
      { id: `${id}:result`, role: "tool", toolCallId: id, content: DENIED, error: "declined" }
    ]));
    // The shared reload fixture records this saved row, with a fixed ID.
    const row = JSON.parse(JSON.stringify(saved[1]!.toolResults![0]).replaceAll(id, "card-1")) as object;
    expect(row).toEqual(expect.objectContaining(fixture.declined.rows[1]!.toolResults![0]));
  });

  it("names each of two same-name calls; an approved call whose sibling is declined settles as not run", async () => {
    script.steps = [[write("call-1", "a.txt"), write("call-2", "b.txt"), { id: "call-3", name: "ls", args: { path: "/" } }], "Done."];
    const { events, asked } = await runTurn(nativeRuntime(), {
      decide: (actions) => actions.map((action) => action.modelCallId === "call-2"
        ? { type: "reject" as const, message: DENIED } : { type: "approve" as const })
    });

    const [first, second] = asked[0]!.actions;
    expect([first!.modelCallId, second!.modelCallId]).toEqual(["call-1", "call-2"]);
    expect(first!.toolCallId).toBeDefined();
    expect(second!.toolCallId).toBeDefined();
    expect(first!.toolCallId).not.toBe(second!.toolCallId);
    // Only the asked calls show before the decision. The ungated `ls` never runs, so it never shows.
    expect(toolStarts(events).map((start) => start.toolCallId)).toEqual([first!.toolCallId, second!.toolCallId]);
    expect(toolResults(events)).toEqual([
      expect.objectContaining({ toolCallId: second!.toolCallId, content: DENIED }),
      expect.objectContaining({ toolCallId: first!.toolCallId,
        content: "This action did not run: another action in the same step was not approved." })
    ]);
    expect(toolStatuses(events).map((status) => status.status)).toEqual(["declined", "declined"]);
  });

  it("gives a repeated model call ID a new card, in later steps and in later turns", async () => {
    const runtime = nativeRuntime();
    script.steps = [[write("call-1", "a.txt")], [write("call-1", "b.txt")], "Done."];
    const first = await runTurn(runtime);
    script.steps = [[write("call-1", "c.txt")], "Done."];
    const second = await runTurn(runtime, { prompt: "Again" });

    const ids = [...first.asked, ...second.asked].map((round) => round.actions[0]!.toolCallId);
    expect([...first.asked, ...second.asked].map((round) => round.actions[0]!.modelCallId)).toEqual(["call-1", "call-1", "call-1"]);
    expect(new Set(ids).size).toBe(3);
    expect([...toolStarts(first.events), ...toolStarts(second.events)].map((start) => start.toolCallId)).toEqual(ids);
    expect([...toolResults(first.events), ...toolResults(second.events)].map((result) => result.toolCallId)).toEqual(ids);
  });

  it("links nothing when one model message repeats a call ID; each run keeps its own card", async () => {
    script.steps = [[write("call-1", "a.txt"), write("call-1", "b.txt")], "Done."];
    const { events, asked } = await runTurn(nativeRuntime());

    expect(asked[0]!.actions.map((action) => action.toolCallId)).toEqual([undefined, undefined]);
    expect(toolStarts(asked[0]!.shown)).toEqual([]);
    const starts = toolStarts(events);
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((start) => start.toolCallId)).size).toBe(2);
  });

  it("keeps approvals inside parallel delegated work unlinked, and shows each delegation once across its resume", async () => {
    script.steps = [
      [{ id: "t1", name: "task", args: { description: "Write a", subagent_type: "general-purpose" } },
        { id: "t2", name: "task", args: { description: "Write b", subagent_type: "general-purpose" } }],
      [write("t1", "a.txt")], [write("t2", "b.txt")], "Wrote.", "Wrote.", "Done."
    ];
    const { events, asked, error } = await runTurn(nativeRuntime());

    expect(error).toBeNull();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.actions).toHaveLength(2);
    for (const action of asked[0]!.actions) {
      expect(action).not.toHaveProperty("toolCallId");
      expect(action).not.toHaveProperty("modelCallId");
    }
    // Delegated calls have no card in the main transcript. Each delegation starts
    // again after the approval inside it, and keeps its one card.
    const starts = toolStarts(events);
    expect(starts.map((start) => start.toolCallName)).toEqual(["task", "task"]);
    expect(toolResults(events).map((result) => result.toolCallId).sort()).toEqual(starts.map((start) => start.toolCallId).sort());
  });

  it("leaves the card unfinished when the turn stops during the approval: nobody declined it", async () => {
    script.steps = [[write("call-1", "a.txt")], "Done."];
    const abort = new AbortController();
    const { events, asked, error } = await runTurn(nativeRuntime(), {
      abort,
      // The coordinator answers a stopped turn's open approvals with a reject.
      decide: (actions) => { abort.abort(); return actions.map(() => ({ type: "reject" as const, message: DENIED })); }
    });

    expect(error).not.toBeNull();
    const id = asked[0]!.actions[0]!.toolCallId!;
    expect(toolStarts(events).map((start) => start.toolCallId)).toEqual([id]);
    expect(toolResults(events)).toEqual([]);
    expect(toolStatuses(events)).toEqual([]);
    // While the history says the turn still runs on another server, the call has no result.
    expect(toAguiMessages(await savedTurn(events, false), { activeTurn: "unavailable" })
      .filter((message) => message.role === "tool")).toEqual([]);
  });

  it("leaves the card unfinished when the approval round fails", async () => {
    script.steps = [[write("call-1", "a.txt")], "Done."];
    const { events, error } = await runTurn(nativeRuntime(), { decide: () => { throw new Error("approval store down"); } });

    expect(error).toBeInstanceOf(Error);
    expect(toolStarts(events)).toHaveLength(1);
    expect(toolResults(events)).toEqual([]);
  });

  it("gives an expired approval's card the expiry message", async () => {
    const expired = "This action was blocked because the approval request expired without an answer.";
    script.steps = [[write("call-1", "a.txt")], "Expired."];
    const { events, asked } = await runTurn(nativeRuntime(), { decide: (actions) => actions.map(() => ({ type: "reject", message: expired })) });

    const id = asked[0]!.actions[0]!.toolCallId!;
    expect(toolResults(events)).toEqual([expect.objectContaining({ toolCallId: id, content: expired })]);
    expect(toolStatuses(events)).toEqual([expect.objectContaining({ toolCallId: id, status: "declined" })]);
  });

  it("saves the shown call while the turn waits, as the shared reload fixture records it", async () => {
    script.steps = [[write("call-1", "notes.md")], "Done."];
    let paused: HistoryMessage[] | null = null;
    let shownId = "";
    await runTurn(nativeRuntime(), {
      decide: async (actions) => {
        shownId = actions[0]!.toolCallId!;
        return actions.map(() => ({ type: "approve" as const }));
      }
    }).then(async ({ asked }) => { paused = await savedTurn(asked[0]!.shown, false); });

    // The fixture uses a fixed ID where the server mints one.
    const rows = JSON.parse(JSON.stringify(paused).replaceAll(shownId, "card-1")) as HistoryMessage[];
    expect(rows[1]!.toolResults).toEqual([expect.objectContaining(fixture.pending.rows[1]!.toolResults![0])]);
    expect(toAguiMessages(fixture.pending.rows as HistoryMessage[], { activeTurn: "unavailable" })).toEqual(fixture.pending.unavailable);
    expect(toAguiMessages(fixture.declined.rows as HistoryMessage[])).toEqual(fixture.declined.none);
    // The approval read that the browser gets with the history names the same card.
    expect(ApprovalsListResponseSchema.parse({ approvals: fixture.pending.approvals }).approvals[0]!.toolCallId).toBe("card-1");
  });
});

describe("inline approvals through the real graph (Policy Center)", () => {
  it("names the card of a Policy Center approval, and the gateway call carries the approved proof", async () => {
    script.steps = [[{ id: "call-1", name: "write_artifact", args: { name: "report.md" } }], "Done."];
    const { events, asked, error } = await runTurn(policyRuntime());

    expect(error).toBeNull();
    const [action] = asked[0]!.actions;
    expect(action).toMatchObject({ name: "write_artifact", modelCallId: "call-1",
      policyApproval: expect.objectContaining({ toolCallId: "call-1" }) });
    expect(toolStarts(asked[0]!.shown)).toEqual([{ type: EventType.TOOL_CALL_START, toolCallId: action!.toolCallId, toolCallName: "write_artifact" }]);
    expect(wire.calls).toEqual([expect.objectContaining({ name: "write_artifact",
      _meta: { "cogniplane.ai/invocation": { toolContextId: "ctx", policyApprovalId: action!.policyApproval!.approvalId } } })]);
    expect(toolResults(events)).toEqual([expect.objectContaining({ toolCallId: action!.toolCallId, content: "saved on managed" })]);
    // The proof never reaches the card's arguments.
    expect(JSON.stringify(events)).not.toContain(action!.policyApproval!.approvalId);
  });
});
