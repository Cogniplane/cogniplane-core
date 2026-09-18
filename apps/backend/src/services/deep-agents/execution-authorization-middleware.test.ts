import { beforeEach, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { createDeepAgentsSessionRuntime } from "./deep-agents-graph.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";

const control = vi.hoisted(() => ({ allowed: true, modelCalls: 0, revokeAfterModel: false, delegate: false }));
vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessage } = await import("@langchain/core/messages");
  class RevokingModel extends FakeStreamingChatModel {
    override bindTools() { return this.withConfig({}); }
    override async _generate() {
      control.modelCalls++;
      const delegate = control.delegate && control.modelCalls === 1;
      const message = new AIMessage({ content: "", tool_calls: [delegate
        ? { name: "task", id: "delegate-1", args: { subagent_type: "general-purpose", description: "Write a file" } }
        : { name: "write_file", id: "write-1", args: { file_path: "/protected.txt", content: "secret" } }]
      });
      if (control.revokeAfterModel && !delegate) control.allowed = false;
      return { generations: [{ text: "", message }] };
    }
  }
  return { ...actual, initChatModel: async () => new RevokingModel({}) };
});

beforeEach(() => {
  control.allowed = true;
  control.modelCalls = 0;
  control.revokeAfterModel = false;
  control.delegate = false;
});

function setup() {
  const checkpointer = new MemorySaver();
  const requireExecution = vi.fn(async () => {
    if (!control.allowed) throw new Error("Execution revoked");
  });
  const runtime = createDeepAgentsSessionRuntime({
    tenantId: "tenant", sessionId: "session", userId: "editor", runtimeId: "runtime",
    resolveProviderKey: async () => "test", systemPrompt: "Complete the requested task.", workspacePath: "/workspace", e2b: null,
    checkpointer, requireExecution, logger: createSilentLogger()
  });
  const toolsStarted: string[] = [];
  const callback: Pick<BaseCallbackHandler, "handleToolStart"> = {
    handleToolStart(_tool, _input, _runId, _parentRunId, _tags, _metadata, runName) {
      toolsStarted.push(runName ?? "unknown");
    }
  };
  const config = { configurable: { thread_id: "session" }, callbacks: [callback] };
  const invoke = async (messages: unknown[]) => {
    const graph = await runtime.getAgentForModel("openai/gpt-5.4") as unknown as {
      invoke(input: unknown, config: unknown): Promise<unknown>;
    };
    return graph.invoke({ messages }, config);
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
