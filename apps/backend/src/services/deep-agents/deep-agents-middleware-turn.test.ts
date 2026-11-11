import { afterEach, describe, expect, it, vi } from "vitest";
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { createDeepAgentsSessionRuntime } from "./deep-agents-graph.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { resolveSandboxNetworkPolicy } from "../runtime/sandbox-network-policy.js";
import type { E2bSandboxLike, loadE2bSandboxClass } from "../runtime/e2b-sandbox.js";

const control = vi.hoisted(() => ({
  mode: "history" as "history" | "tool",
  toolCalls: [] as string[],
  sandbox: null as E2bSandboxLike | null,
  tool: null as null | (() => Promise<string>)
}));

vi.mock("../runtime/e2b-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/e2b-sandbox.js")>();
  return { ...actual, loadE2bSandboxClass: (async () => ({
    create: async () => control.sandbox!,
    connect: async () => { throw new Error("Unexpected sandbox reconnect"); },
    getInfo: async () => ({ network: { denyOut: ["0.0.0.0/0"], allowPublicTraffic: false } }),
    kill: async () => { throw new Error("Unexpected sandbox kill by id"); }
  })) satisfies typeof loadE2bSandboxClass };
});

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  class MiddlewareModel extends FakeStreamingChatModel {
    override bindTools() { return this.withConfig({}); }
    override async _generate(messages: BaseMessage[]) {
      const toolCall = messages.at(-1)?.text === "Delegate report reading."
        ? { name: "task", id: "delegate-1", args: { subagent_type: "general-purpose", description: "Read the report." } }
        : { name: "large_result", id: "result-1", args: {} };
      if (control.mode === "tool" && !ToolMessage.isInstance(messages.at(-1))) control.toolCalls.push(toolCall.name);
      const message = control.mode === "tool" && !ToolMessage.isInstance(messages.at(-1))
        ? new AIMessage({ content: "", tool_calls: [toolCall] })
        : new AIMessage("Done.");
      return { generations: [{ text: "", message }] };
    }
    override async *_streamResponseChunks(messages: BaseMessage[]) {
      const { message } = (await this._generate(messages)).generations[0]!;
      yield new ChatGenerationChunk({ text: "", message: new AIMessageChunk({
        content: message.content, tool_calls: message.tool_calls
      }) });
    }
  }
  return { ...actual, initChatModel: async () => new MiddlewareModel({}) };
});

vi.mock("@langchain/mcp-adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/mcp-adapters")>();
  class MCPAdapter {
    async getClient() {
      return {
        getProtocolEra: () => "legacy",
        listTools: async () => ({ tools: [{ name: "large_result", description: "Read a report",
          inputSchema: { type: "object", properties: {} } }] }),
        callTool: async () => ({ content: [{ type: "text", text: await control.tool!() }] })
      };
    }
    async close() {}
  }
  return { ...actual, MCPAdapter };
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function historyMessages() {
  // Exceed the installed middleware's default threshold without a provider model.
  return Array.from({ length: 12 }, (_, i) => i % 2 === 0
    ? new HumanMessage(`Question ${i}. ${"a".repeat(100_000)}`)
    : new AIMessage(`Answer ${i}. ${"b".repeat(100_000)}`));
}

const workspace = "/home/user/workspace/session";
const runtimes: ReturnType<typeof createDeepAgentsSessionRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.restoreAllMocks();
});

function setup(mode: typeof control.mode) {
  control.mode = mode;
  control.toolCalls.length = 0;
  const files = new Map<string, Uint8Array>();
  const write = vi.fn(async (entries: Array<{ path: string; data: string | ArrayBuffer }>) => {
    for (const { path, data } of entries) files.set(path,
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
  });
  const read = vi.fn(async (path: string) => {
    const data = files.get(path);
    if (!data) throw new Error("file not found");
    return new Blob([new Uint8Array(data)]).stream();
  });
  control.sandbox = {
    sandboxId: "sandbox", files: { write, read, getInfo: async () => ({ size: 0 }) },
    commands: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
    setTimeout: async () => {}, kill: async () => {}
  };
  const runtime = createDeepAgentsSessionRuntime({
    tenantId: "tenant", sessionId: "session", userId: "user", runtimeId: "runtime",
    resolveProviderKey: async () => "test", systemPrompt: null, workspacePath: workspace,
    e2b: { apiKey: "test", templateId: "test", sandboxTimeoutMs: 60_000, executeTimeoutMs: 1000,
      resolveNetworkPolicy: async () => resolveSandboxNetworkPolicy([]),
      networkConfirmTimeoutMs: 1000, networkRequestTimeoutMs: 1000 },
    mcpServers: mode === "tool" ? [{ id: "reports", mode: "proxy", url: "http://gateway/mcp/reports", authorization: "Bearer test" }] : [],
    logger: createSilentLogger()
  });
  runtimes.push(runtime);
  const run = async (input: unknown) => {
    const graph = await runtime.getAgentForModel("openai/gpt-5.4");
    for await (const _event of graph.streamEvents(input,
      { version: "v2", configurable: { thread_id: "session" } })) {
      // Consume the real graph, including its native middleware.
    }
  };
  return { runtime, files, write, read, run };
}

describe("middleware sandbox turn ownership", () => {
  it.each(["cancel", "complete", "replace"])("does not append old history after %s", async (ending) => {
    const t = setup("history");
    let history = "";
    const waiting = gate();
    const reached = gate();
    t.read.mockImplementationOnce(async (path) => {
      history = path;
      const old = new TextEncoder().encode("Old history.\n");
      t.files.set(path, old);
      reached.release();
      await waiting.promise;
      return new Blob([old]).stream();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancel = new AbortController();
    const end = t.runtime.beginSandboxTurn!(cancel.signal);
    const stale = t.run({ messages: historyMessages() }).catch((error: unknown) => error);
    try {
      await Promise.race([reached.promise, stale.then((error) => { throw new Error(`History read was not reached: ${String(error)}`); })]);
      expect(history).toMatch(new RegExp(`^${workspace}/conversation_history/.*\\.md$`));
      if (ending === "cancel") cancel.abort();
      if (ending === "complete") end();
      t.runtime.beginSandboxTurn!();
      await t.runtime.writeFileBytes!(history, "Next turn's history.");
    } finally { waiting.release(); }
    await stale;
    expect(new TextDecoder().decode(t.files.get(history)).slice(0, 40)).toBe("Next turn's history.");
    expect(t.write).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it("appends history while its turn is live", async () => {
    const t = setup("history");
    t.read.mockImplementationOnce(async () => new Blob(["Old history.\n"]).stream());
    const end = t.runtime.beginSandboxTurn!();
    await t.run({ messages: historyMessages() });
    end();
    expect(t.write).toHaveBeenCalledTimes(1);
    const [history, content] = [...t.files.entries()][0]!;
    expect(history).toContain("/conversation_history/");
    expect(new TextDecoder().decode(content).slice(0, 128)).toMatch(/^Old history\.\n## Summarized at /);
  });

  it.each([
    ["cancel", false], ["complete", false], ["replace", false],
    ["cancel", true], ["complete", true], ["replace", true]
  ] as const)("does not save a late large tool result after %s, delegated %s", async (ending, delegated) => {
    const t = setup("tool");
    const waiting = gate();
    const reached = gate();
    control.tool = async () => {
      reached.release();
      await waiting.promise;
      return "stale result".repeat(10_000);
    };
    const cancel = new AbortController();
    const end = t.runtime.beginSandboxTurn!(cancel.signal);
    const stale = t.run({ messages: [new HumanMessage(delegated ? "Delegate report reading." : "Read the report.")] })
      .catch((error: unknown) => error);
    const resultPath = `${workspace}/large_tool_results/result-1.txt`;
    try {
      await Promise.race([reached.promise, stale.then((error) => { throw new Error(`Tool call was not reached: ${String(error)}`); })]);
      if (delegated) expect(control.toolCalls).toContain("task");
      if (ending === "cancel") cancel.abort();
      if (ending === "complete") end();
      t.runtime.beginSandboxTurn!();
      await t.runtime.writeFileBytes!(resultPath, "Next turn's report.");
    } finally { waiting.release(); }
    await stale;
    expect(new TextDecoder().decode(t.files.get(resultPath)).slice(0, 40)).toBe("Next turn's report.");
    expect(t.write).toHaveBeenCalledTimes(1);
  });

  it("saves large results in live turns while reusing the compiled graph", async () => {
    const t = setup("tool");
    control.tool = async () => "live result".repeat(10_000);
    const graph = await t.runtime.getAgentForModel("openai/gpt-5.4");
    const resultPath = `${workspace}/large_tool_results/result-1.txt`;
    for (let i = 0; i < 2; i++) {
      const end = t.runtime.beginSandboxTurn!();
      await t.run({ messages: [new HumanMessage(`Read report ${i}.`)] });
      end();
      expect(await t.runtime.getAgentForModel("openai/gpt-5.4")).toBe(graph);
      expect(t.files.get(resultPath)?.byteLength).toBe(110_000);
    }
    expect(t.write).toHaveBeenCalledTimes(2);
  });
});
