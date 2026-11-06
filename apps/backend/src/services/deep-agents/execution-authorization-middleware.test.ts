import { ModelSpendingCallback } from "./model-spending-callback.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { createDeepAgentsSessionRuntime } from "./deep-agents-graph.js";
import { toolContextLivenessMiddleware } from "./execution-authorization-middleware.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";

const control = vi.hoisted(() => ({
  allowed: true, modelCalls: 0, revokeAfterModel: false, delegate: false, answerAfter: Infinity,
  /** Model call `call` waits for `release` after it calls `reached`. */
  hold: undefined as { call: number; reached: () => void; release: Promise<void> } | undefined
}));
vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessage, AIMessageChunk } = await import("@langchain/core/messages");
  const { ChatGenerationChunk } = await import("@langchain/core/outputs");
  class RevokingModel extends FakeStreamingChatModel {
    override bindTools() { return this.withConfig({}); }
    override async _generate() {
      control.modelCalls++;
      if (control.hold?.call === control.modelCalls) {
        control.hold.reached();
        await control.hold.release;
      }
      const delegate = control.delegate && control.modelCalls === 1;
      // An answer ends the turn, so a test whose guard did not stop it fails at once.
      if (control.modelCalls > control.answerAfter) return { generations: [{ text: "Done.", message: new AIMessage("Done.") }] };
      const message = new AIMessage({ content: "", usage_metadata: { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000 }, tool_calls: [delegate
        ? { name: "task", id: "delegate-1", args: { subagent_type: "general-purpose", description: "Write a file" } }
        : { name: "write_file", id: "write-1", args: { file_path: "/protected.txt", content: "secret" } }]
      });
      if (control.revokeAfterModel && !delegate) control.allowed = false;
      return { generations: [{ text: "", message }] };
    }
    override async *_streamResponseChunks() {
      const { generations } = await this._generate();
      const message = generations[0]!.message;
      yield new ChatGenerationChunk({ text: "", message: new AIMessageChunk({
        content: message.content, tool_calls: message.tool_calls, usage_metadata: message.usage_metadata
      }) });
    }
  }
  return { ...actual, initChatModel: async () => new RevokingModel({}) };
});

beforeEach(() => {
  control.allowed = true;
  control.modelCalls = 0;
  control.revokeAfterModel = false;
  control.delegate = false;
  control.answerAfter = Infinity;
  control.hold = undefined;
});

function setup(spending?: ModelSpendingCallback, requireLiveToolContext?: () => Promise<void>) {
  const checkpointer = new MemorySaver();
  const requireExecution = vi.fn(async () => {
    if (!control.allowed) throw new Error("Execution revoked");
  });
  const runtime = createDeepAgentsSessionRuntime({
    tenantId: "tenant", sessionId: "session", userId: "editor", runtimeId: "runtime",
    resolveProviderKey: async () => "test", systemPrompt: "Complete the requested task.", workspacePath: "/workspace", e2b: null,
    checkpointer, requireExecution, requireLiveToolContext,
    requireSpendingAllowance: spending ? () => spending.assertAllowance() : undefined, logger: createSilentLogger()
  });
  const toolsStarted: string[] = [];
  const callback = BaseCallbackHandler.fromMethods({
    handleToolStart(_tool, _input, _runId, _parentRunId, _tags, _metadata, runName) {
      toolsStarted.push(runName ?? "unknown");
    }
  });
  const config = { configurable: { thread_id: "session" }, callbacks: [callback, ...(spending ? [spending] : [])] };
  const invoke = async (messages: unknown[]) => {
    const graph = await runtime.getAgentForModel("openai/gpt-5.4");
    for await (const _event of graph.streamEvents({ messages }, { ...config, version: "v2" })) {
      // Consume the production stream so all execution and spending guards run.
    }
  };
  return { runtime, checkpointer, requireExecution, invoke, config, toolsStarted };
}

it("rejects a revoked execution before calling the model", async () => {
  const test = setup();
  control.allowed = false;
  try {
    await expect(test.invoke([{ role: "user", content: "Write a file" }])).rejects.toThrow("Execution revoked");
    expect(control.modelCalls).toBe(0);
  } finally { await test.runtime.dispose(); }
});

it("rechecks execution after model output before a native file write", async () => {
  const test = setup();
  control.revokeAfterModel = true;
  try {
    await expect(test.invoke([{ role: "user", content: "Write a file" }])).rejects.toThrow("Execution revoked");
    expect(control.modelCalls).toBe(1);
    expect(test.toolsStarted).not.toContain("write_file");
    const state = await test.checkpointer.getTuple(test.config);
    expect(JSON.stringify(state?.checkpoint.channel_values.files ?? {})).not.toContain("protected.txt");
  } finally { await test.runtime.dispose(); }
});

it("checks delegated work before the subagent can write a file", async () => {
  const test = setup();
  control.revokeAfterModel = true;
  try {
    control.delegate = true;
    await expect(test.invoke([{ role: "user", content: "Delegate writing a file" }])).rejects.toThrow("Execution revoked");
    expect(control.modelCalls).toBe(2);
    expect(test.toolsStarted).toContain("task");
    expect(test.toolsStarted).not.toContain("write_file");
    expect(test.requireExecution.mock.calls.length).toBeGreaterThan(3);
    const state = await test.checkpointer.getTuple(test.config);
    expect(JSON.stringify(state?.checkpoint.channel_values.files ?? {})).not.toContain("protected.txt");
  } finally { await test.runtime.dispose(); }
});

it.each([false, true])("stops native tool dispatch after allowance exhaustion, delegated=%s", async delegate => {
  const spending = new ModelSpendingCallback({
    startCall: async () => {}, completeCall: async () => {}, failCall: async () => {}, finish: async () => {}
  }, { tenantId: "tenant", reservationId: "reply", reservedMicroUsd: delegate ? 20_000 : 1 },
  "gpt-5.4", new AbortController().signal);
  const test = setup(spending);
  control.delegate = delegate;
  try {
    await expect(test.invoke([{ role: "user", content: "Write a file" }])).rejects.toThrow("allowance");
    expect(control.modelCalls).toBe(delegate ? 2 : 1);
    expect(test.toolsStarted).not.toContain("write_file");
    const state = await test.checkpointer.getTuple(test.config);
    expect(JSON.stringify(state?.checkpoint.channel_values.files ?? {})).not.toContain("protected.txt");
  } finally { await spending.finish(); await test.runtime.dispose(); }
});

describe("tool context check before native tools", () => {
  /** A check that throws once `live` is false, as the adapter does for a dead context. */
  function contextCheck() {
    const state = { live: true };
    const requireLiveToolContext = vi.fn(async () => {
      if (!state.live) throw new Error("Tool access ended");
    });
    return { state, requireLiveToolContext };
  }
  /** Holds model call `call` until the test releases it. */
  function holdModelCall(call: number) {
    let reached!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    control.hold = { call, reached, release: new Promise<void>((resolve) => { release = resolve; }) };
    return { waiting, release };
  }

  it("a tool call that the model returns after a revocation does not start", async () => {
    const check = contextCheck();
    const test = setup(undefined, check.requireLiveToolContext);
    control.answerAfter = 3;
    const held = holdModelCall(1);
    try {
      const turn = test.invoke([{ role: "user", content: "Write a file" }]);
      await held.waiting;
      // The security change commits while the model call waits.
      check.state.live = false;
      held.release();

      await expect(turn).rejects.toThrow("Tool access ended");
      expect(control.modelCalls).toBe(1);
      expect(test.toolsStarted).toEqual([]);
      expect(check.requireLiveToolContext).toHaveBeenCalledTimes(1);
      const saved = await test.checkpointer.getTuple(test.config);
      expect(JSON.stringify(saved?.checkpoint.channel_values.files ?? {})).not.toContain("protected.txt");
    } finally { await test.runtime.dispose(); }
  });

  it("a tool call of delegated work that the model returns after a revocation does not start", async () => {
    const check = contextCheck();
    const test = setup(undefined, check.requireLiveToolContext);
    control.delegate = true;
    control.answerAfter = 3;
    // Call 1 delegates; call 2 is the first model call of the delegated agent.
    const held = holdModelCall(2);
    try {
      const turn = test.invoke([{ role: "user", content: "Delegate writing a file" }]);
      await held.waiting;
      check.state.live = false;
      held.release();

      await expect(turn).rejects.toThrow("Tool access ended");
      expect(control.modelCalls).toBe(2);
      // The delegation was checked and started; the delegated write was checked and did not.
      expect(test.toolsStarted).toEqual(["task"]);
      expect(check.requireLiveToolContext).toHaveBeenCalledTimes(2);
    } finally { await test.runtime.dispose(); }
  });

  it("runs after the execution check, so an ended execution keeps its own error", async () => {
    const check = contextCheck();
    const test = setup(undefined, check.requireLiveToolContext);
    control.answerAfter = 3;
    // beforeAgent and the model call pass; the check before the tool does not.
    test.requireExecution.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {});
    control.allowed = false;
    try {
      await expect(test.invoke([{ role: "user", content: "Write a file" }])).rejects.toThrow("Execution revoked");
      expect(control.modelCalls).toBe(1);
      expect(check.requireLiveToolContext).not.toHaveBeenCalled();
      expect(test.toolsStarted).toEqual([]);
    } finally { await test.runtime.dispose(); }
  });

  it("leaves MCP gateway tools to the gateway, which checks the same context", async () => {
    const check = vi.fn(async () => {});
    const middleware = toolContextLivenessMiddleware(check, (name) => name === "github_search");
    const handler = vi.fn(async () => "result");
    const call = (name: string) => middleware.wrapToolCall!({ toolCall: { name, args: {}, id: name } } as never, handler as never);

    await call("github_search");
    expect(check).not.toHaveBeenCalled();
    await call("execute");
    expect(check).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
