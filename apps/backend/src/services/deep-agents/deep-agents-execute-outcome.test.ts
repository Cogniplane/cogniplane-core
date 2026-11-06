// Outcome of the `execute` tool, from the real compiled graph. The SDK `execute`
// tool turns the structured result of the sandbox into text and returns it as a
// successful message, so a failed command used to show as done. The E2B
// SDK is faked at its boundary (`commands.run`) and the model is scripted. The
// graph, the SDK tools, the E2B backend, the event tracer, the AG-UI driver, the
// turn transcript and the history converter are real.

import { EventType, verifyEvents, type BaseEvent } from "@ag-ui/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { toAguiMessages, type HistoryMessage } from "../agui-history.js";
import { resolveSandboxNetworkPolicy } from "../runtime/sandbox-network-policy.js";
import type { E2bCommandResult, E2bSandboxLike, loadE2bSandboxClass } from "../runtime/e2b-sandbox.js";
import { TurnTranscript, type TurnTranscriptMessages } from "../turn-transcript.js";
import { interruptedResult } from "./agui-events.js";

type Call = { id: string; name: string; args: Record<string, unknown> };
type Step = Call[] | string;
const script = vi.hoisted(() => ({ steps: [] as Step[] }));
const control = vi.hoisted(() => ({ sandbox: null as E2bSandboxLike | null }));

vi.mock("../runtime/e2b-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/e2b-sandbox.js")>();
  return { ...actual, loadE2bSandboxClass: (async () => ({
    create: async () => control.sandbox!,
    connect: async () => { throw new Error("Unexpected sandbox reconnect"); },
    getInfo: async () => ({ network: { denyOut: ["0.0.0.0/0"], allowPublicTraffic: false } })
  })) satisfies typeof loadE2bSandboxClass };
});

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessageChunk } = await import("@langchain/core/messages");
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

import { createDeepAgentsSessionRuntime } from "./deep-agents-graph.js";
import { createSessionAGUITurnBackend } from "./deep-agents-agui-backend.js";
import { DeepAgentsAGUIAgent } from "./deep-agents-agui-agent.js";
import type { DeepAgentsSessionRuntime } from "./deep-agents-types.js";

const MODEL = "deepagents/claude-sonnet-5";
const execute = (id: string, command: string): Call => ({ id, name: "execute", args: { command } });
const FAIL_19 = "printf 'EXPECTED-FAILURE-19\\n'; exit 19";

/** The E2B SDK throws this for a command that exits non-zero. It carries the whole result. */
class CommandExitError extends Error implements E2bCommandResult {
  constructor(readonly exitCode: number, readonly stdout: string, readonly stderr = "") {
    super("Command exited with code " + exitCode);
  }
}

const runtimes: DeepAgentsSessionRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  script.steps = [];
});

type RunCommand = (command: string) => Promise<{ stdout: string; stderr: string; exitCode?: number }>;

/** `run` gets the commands of the model. The backend's own `mkdir -p` of the workspace, at creation, always succeeds. */
function setup(run: RunCommand) {
  control.sandbox = {
    sandboxId: "sandbox",
    files: { write: async () => {}, read: async () => new Uint8Array(), getInfo: async () => ({ size: 0 }) },
    commands: { run: (async (command: string) => command.startsWith("mkdir -p ")
      ? { stdout: "", stderr: "", exitCode: 0 } : run(command)) as E2bSandboxLike["commands"]["run"] },
    setTimeout: async () => {}, kill: async () => {}
  };
  const runtime = createDeepAgentsSessionRuntime({
    tenantId: "t1", sessionId: "s1", userId: "u1", runtimeId: "r1", resolveProviderKey: async () => "key",
    providerBaseUrls: null, systemPrompt: null, workspacePath: "/home/user/workspace/s1", logger: createSilentLogger(),
    e2b: { apiKey: "test", templateId: "test", sandboxTimeoutMs: 60_000, executeTimeoutMs: 1000,
      resolveNetworkPolicy: async () => resolveSandboxNetworkPolicy([]),
      networkConfirmTimeoutMs: 1000, networkRequestTimeoutMs: 1000 }
  });
  runtimes.push(runtime);
  return runtime;
}

/** One turn through the AG-UI driver. The sandbox turn is open for as long as the turn runs, as in the adapter. */
async function runTurn(runtime: DeepAgentsSessionRuntime, abort = new AbortController(), onEvent?: (event: BaseEvent) => void) {
  const events: BaseEvent[] = [];
  const backend = createSessionAGUITurnBackend({
    threadId: "thread-1", runtime, toolContextRef: { current: null }, modelId: MODEL, promptText: "Go", signal: abort.signal,
    awaitDecisions: async () => []
  });
  const agent = new DeepAgentsAGUIAgent({ backend, toolContextId: null, approvalAbortSignal: abort.signal });
  const endSandboxTurn = runtime.beginSandboxTurn!(abort.signal);
  let error: unknown = null;
  try {
    await new Promise<void>((resolve) => {
      agent.run({ threadId: "thread-1", runId: "run-1", state: {}, messages: [] } as never).pipe(verifyEvents()).subscribe({
        next: (event) => { events.push(event); onEvent?.(event); },
        error: (err: unknown) => { error = err; resolve(); },
        complete: resolve
      });
    });
  } finally { endSandboxTurn(); }
  return { events, error };
}

type Start = { toolCallId: string; toolCallName: string };
type Result = { toolCallId: string; content: string };
type Status = { toolCallId: string; toolName: string; status: string };
const starts = (events: BaseEvent[]) => events.filter((event) => event.type === EventType.TOOL_CALL_START) as unknown as Start[];
const results = (events: BaseEvent[]) => events.filter((event) => event.type === EventType.TOOL_CALL_RESULT) as unknown as Result[];
const statuses = (events: BaseEvent[]) => events.flatMap((event) => event.type === EventType.CUSTOM && (event as { name?: string }).name === "tool_status"
  ? [(event as unknown as { value: Status }).value] : []);

async function releaseAfterResult(runtime: DeepAgentsSessionRuntime, firstOutput: string, release: () => void) {
  const abort = new AbortController();
  // A missing result must fail the test and release the held command.
  const deadline = setTimeout(() => { abort.abort(); release(); }, 4_000);
  try {
    const result = await runTurn(runtime, abort, (event) => {
      if (event.type === EventType.TOOL_CALL_RESULT && (event as unknown as Result).content.startsWith(firstOutput)) release();
    });
    expect(abort.signal.aborted).toBe(false);
    expect(result.error).toBeNull();
    return result;
  } finally {
    clearTimeout(deadline);
    release();
  }
}
/** The command of each card: the arguments that the card shows. */
const commandsOf = (events: BaseEvent[]) => new Map(events.flatMap((event) => {
  if (event.type !== EventType.TOOL_CALL_ARGS) return [];
  const { toolCallId, delta } = event as unknown as { toolCallId: string; delta: string };
  return [[toolCallId, (JSON.parse(delta) as { command?: string }).command] as const];
}));

type Saved = { status: HistoryMessage["status"]; rows: Array<Record<string, unknown>>; writes: string[] };

/** What the turn transcript saves for the turn, in the order it saves it. */
async function save(events: BaseEvent[], terminal?: BaseEvent): Promise<Saved> {
  const rows = new Map<string, Record<string, unknown>>();
  const writes: string[] = [];
  let status: HistoryMessage["status"] = "streaming";
  const messages = {
    updateContent: async (_t: string, _m: string, _u: string, outcome: HistoryMessage["status"]) => { status = outcome; return {} as never; },
    updateStreamingContent: async () => ({}) as never,
    setRuntimeNotices: async () => undefined,
    upsertToolResult: async (row: Record<string, unknown>) => { writes.push(String(row.status)); rows.set(String(row.toolResultId), row); return row as never; }
  } as unknown as TurnTranscriptMessages;
  const transcript = new TurnTranscript({ messages, tenantId: "t1", sessionId: "s1", userId: "u1", messageId: "a1" });
  for (const event of terminal ? [...events, terminal] : events) transcript.apply(event, { saveProgress: true });
  await transcript.settleProgress();
  await transcript.finalize();
  return { status, rows: [...rows.values()], writes };
}

const history = (saved: Saved): HistoryMessage[] => [
  { messageId: "u1", role: "user", status: "completed", content: "Go" },
  { messageId: "a1", role: "assistant", status: saved.status, content: "", toolResults: saved.rows as unknown as HistoryMessage["toolResults"] }
];
const toolMessages = (saved: Saved) => toAguiMessages(history(saved)).filter((message) => message.role === "tool");

describe("a failed command through the real graph", () => {
  it("fails the card with the exit code of the sandbox, keeps the output whole, and still fails after a reload", async () => {
    script.steps = [[execute("call-1", FAIL_19)], "It failed."];
    const { events, error } = await runTurn(setup(async () => { throw new CommandExitError(19, "EXPECTED-FAILURE-19\n"); }));

    expect(error).toBeNull();
    const [card] = starts(events);
    expect(starts(events)).toHaveLength(1);
    // The SDK text is the output, without a change, and the result is one message.
    expect(results(events)).toEqual([expect.objectContaining({ toolCallId: card!.toolCallId,
      content: "EXPECTED-FAILURE-19\n\n[Command failed with exit code 19]" })]);
    expect(statuses(events)).toEqual([{ toolCallId: card!.toolCallId, toolName: "execute", status: "failed", durationMs: expect.any(Number) }]);

    const saved = await save(events);
    expect(saved.rows).toEqual([expect.objectContaining({ toolResultId: card!.toolCallId, status: "failed" })]);
    expect(toolMessages(saved)).toEqual([expect.objectContaining({ toolCallId: card!.toolCallId, error: "failed",
      content: "EXPECTED-FAILURE-19\n\n[Command failed with exit code 19]" })]);
  });

  it("fails a command that timed out and one that lost its sandbox: both are structured results", async () => {
    script.steps = [[execute("call-1", "sleep 60"), execute("call-2", "make")], "Done."];
    const { events } = await runTurn(setup(async (command) => {
      if (command === "sleep 60") throw new Error("command timeout reached");
      throw Object.assign(new Error("sandbox not found"), { name: "SandboxNotFoundError" });
    }));

    const ids = new Map([...commandsOf(events)].map(([id, command]) => [command, id]));
    expect(statuses(events).map((status) => status.toolCallId).sort()).toEqual([ids.get("sleep 60")!, ids.get("make")!].sort());
    expect(results(events).find((result) => result.toolCallId === ids.get("sleep 60"))?.content).toContain("[Command failed with exit code 124]");
    expect(results(events).find((result) => result.toolCallId === ids.get("make"))?.content).toContain("[Command failed with exit code 1]");
  });

  it("keeps a command that exits 0 done, also when its own output looks like a failure", async () => {
    const lookalike = "[Command failed with exit code 3]\nError: everything is fine";
    script.steps = [[execute("call-1", `echo '${lookalike}'`)], "Done."];
    const { events } = await runTurn(setup(async () => ({ stdout: lookalike, stderr: "", exitCode: 0 })));

    expect(results(events)).toEqual([expect.objectContaining({ content: `${lookalike}\n[Command succeeded with exit code 0]` })]);
    expect(statuses(events)).toEqual([]);
    expect((await save(events)).rows).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("does not call a command failed when the sandbox gave no exit code", async () => {
    script.steps = [[execute("call-1", "true")], "Done."];
    const { events } = await runTurn(setup(async () => ({ stdout: "ok", stderr: "" })));

    expect(results(events)).toEqual([expect.objectContaining({ content: "ok" })]);
    expect(statuses(events)).toEqual([]);
  });

  it("does not fail a file tool whose own command exits non-zero as a normal result", async () => {
    // `grep` with no match runs a command that exits 1. The SDK tool reports "No matches", not a failure.
    script.steps = [[{ id: "call-1", name: "grep", args: { pattern: "needle" } }], "Done."];
    const { events } = await runTurn(setup(async () => { throw new CommandExitError(1, ""); }));

    expect(starts(events).map((start) => start.toolCallName)).toEqual(["grep"]);
    expect(results(events)).toEqual([expect.objectContaining({ content: "No matches found for pattern 'needle'" })]);
    expect(statuses(events)).toEqual([]);
  });

  it("gives each of two parallel commands its own outcome when they end in the other order", async () => {
    script.steps = [[execute("call-1", "slow-ok"), execute("call-2", "fast-fail")], "Done."];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const { events } = await releaseAfterResult(setup(async (command) => {
      if (command === "fast-fail") throw new CommandExitError(3, "failed first");
      await slowGate;
      return { stdout: "finished last", stderr: "", exitCode: 0 };
    }), "failed first", releaseSlow);

    const ids = new Map([...commandsOf(events)].map(([id, command]) => [command, id]));
    expect(starts(events).map((start) => start.toolCallName)).toEqual(["execute", "execute"]);
    expect(new Set(starts(events).map((start) => start.toolCallId)).size).toBe(2);
    expect(results(events).map((result) => result.toolCallId)).toEqual([ids.get("fast-fail"), ids.get("slow-ok")]);
    expect(results(events).map((result) => result.content.split("\n")[0])).toEqual(["failed first", "finished last"]);
    expect(statuses(events)).toEqual([expect.objectContaining({ toolCallId: ids.get("fast-fail"), status: "failed" })]);
  });

  it("gives a repeated command and a repeated model call ID a card and an outcome of their own, in later steps", async () => {
    script.steps = [[execute("call-1", "make test")], [execute("call-1", "make test")], "Done."];
    let run = 0;
    const { events } = await runTurn(setup(async () => {
      if (run++ === 0) throw new CommandExitError(2, "first run");
      return { stdout: "second run", stderr: "", exitCode: 0 };
    }));

    const [first, second] = starts(events);
    expect(first!.toolCallId).not.toBe(second!.toolCallId);
    expect(statuses(events)).toEqual([expect.objectContaining({ toolCallId: first!.toolCallId, status: "failed" })]);
    expect(results(events).map((result) => [result.toolCallId, result.content.split("\n")[0]]))
      .toEqual([[first!.toolCallId, "first run"], [second!.toolCallId, "second run"]]);
  });

  it("ties each outcome to its own run when two parallel calls repeat both the command and the call ID", async () => {
    script.steps = [[execute("call-1", "make test"), execute("call-1", "make test")], "Done."];
    let run = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const { events } = await releaseAfterResult(setup(async () => {
      // The run that starts first ends last, and it is the one that exits 0.
      const tag = run++;
      if (tag === 0) { await firstGate; return { stdout: "run 0", stderr: "", exitCode: 0 }; }
      throw new CommandExitError(5, "run 1");
    }), "run 1", releaseFirst);

    expect(starts(events)).toHaveLength(2);
    const [first, second] = starts(events);
    expect(first!.toolCallId).not.toBe(second!.toolCallId);
    expect(results(events).map((result) => result.toolCallId)).toEqual([second!.toolCallId, first!.toolCallId]);
    expect(results(events).map((result) => result.content.split("\n")[0])).toEqual(["run 1", "run 0"]);
    const failed = new Set(statuses(events).map((status) => status.toolCallId));
    expect(failed.size).toBe(1);
    // The text of a card and its status come from one run: the failure belongs to the card whose text says exit code 5.
    for (const result of results(events)) {
      expect(failed.has(result.toolCallId)).toBe(result.content.includes("exit code 5"));
    }
    expect(results(events).filter((result) => result.content.includes("exit code 5"))).toHaveLength(1);
  });
});

describe("a stopped command through the real graph", () => {
  /** Stops the turn while the command runs. The command ends only when the test lets it. */
  async function stopDuringCommand() {
    script.steps = [[execute("call-1", "sleep 20")], "Done."];
    const abort = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const runtime = setup(() => new Promise((resolve) => {
      started();
      release = () => resolve({ stdout: "", stderr: "", exitCode: 0 });
    }));
    const turn = runTurn(runtime, abort);
    await running;
    abort.abort();
    const { events, error } = await turn;
    release();
    return { events, error };
  }

  it("leaves the card unfinished on the wire: no result and no failure", async () => {
    const { events, error } = await stopDuringCommand();

    expect(error).not.toBeNull();
    expect(starts(events).map((start) => start.toolCallName)).toEqual(["execute"]);
    expect(results(events)).toEqual([]);
    expect(statuses(events)).toEqual([]);
  });

  it("saves the unfinished call as in_progress after a stop, so history shows it as interrupted", async () => {
    const { events } = await stopDuringCommand();
    const [card] = starts(events);

    const saved = await save(events, { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1", result: interruptedResult() } as BaseEvent);
    expect(saved.status).toBe("interrupted");
    expect(saved.rows).toEqual([expect.objectContaining({ toolResultId: card!.toolCallId, status: "in_progress" })]);
    expect(saved.writes).not.toContain("failed");
    expect(toolMessages(saved)).toEqual([expect.objectContaining({ toolCallId: card!.toolCallId, error: "interrupted" })]);
  });

  it("still fails the unfinished call when the turn ends with an error", async () => {
    const { events } = await stopDuringCommand();

    const saved = await save(events, { type: EventType.RUN_ERROR, message: "The assistant run failed." } as BaseEvent);
    expect(saved.status).toBe("error");
    expect(saved.rows).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(toolMessages(saved)).toEqual([expect.objectContaining({ error: "failed" })]);
  });
});
