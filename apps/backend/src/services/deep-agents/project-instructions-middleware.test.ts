import { expect, it, vi } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgentsSessionRuntime } from "./deep-agents-graph.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import type { ProjectInstructionsSnapshot } from "@cogniplane/shared-types";

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessage } = await import("@langchain/core/messages");
  return { ...actual, initChatModel: async () => new FakeStreamingChatModel({ responses: [new AIMessage("Done.")] }) };
});

it("uses fresh user-level project context without storing it in conversation history", async () => {
  const checkpointer = new MemorySaver();
  const runtime = createDeepAgentsSessionRuntime({
    tenantId: "tenant", sessionId: "session", userId: "owner", runtimeId: "runtime",
    resolveProviderKey: async () => "test", systemPrompt: "Organization rule: never disclose credentials.",
    workspacePath: "/workspace", e2b: null, checkpointer, logger: createSilentLogger()
  });
  try {
    const graph = await runtime.getAgentForModel("openai/gpt-5.4");
    const config = { version: "v2" as const, configurable: { thread_id: "session" } };
    const turn = async (projectInstructions: ProjectInstructionsSnapshot | null) => {
      const calls: Array<{ text: string; messages: BaseMessage[] }> = [];
      for await (const event of graph.streamEvents({ messages: [{ role: "user", content: "Draft a proposal." }] },
        { ...config, context: { projectInstructions } })) {
        if (event.event === "on_chat_model_start") calls.push({
          text: JSON.stringify(event.data), messages: (event.data as { input: { messages: BaseMessage[][] } }).input.messages.flat()
        });
      }
      return calls.at(-1)!;
    };
    const first = await turn({ projectId: "p1", revision: 1, instructions: "Write in French." });
    expect(first.text).toContain("Write in French.");
    expect(first.text).toContain("Organization rule: never disclose credentials.");
    const instructions = first.messages.filter((message) =>
      typeof message.content === "string" && message.content.includes("Write in French."));
    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.getType()).toBe("human");
    const second = await turn({ projectId: "p1", revision: 2, instructions: "Use Canadian dollars." });
    expect(second.text).toContain("Use Canadian dollars.");
    expect(second.text).not.toContain("Write in French.");
    const cleared = await turn({ projectId: "p1", revision: 3, instructions: "" });
    expect(cleared.text).not.toContain("Use Canadian dollars.");
    const detached = await turn(null);
    expect(detached.text).not.toContain("Saved project instructions");
    const state = (await checkpointer.getTuple(config))!.checkpoint.channel_values;
    expect(state.messages).toHaveLength(8);
    expect(JSON.stringify(state.messages)).not.toContain("Write in French.");
    expect(JSON.stringify(state.messages)).not.toContain("Use Canadian dollars.");
  } finally { await runtime.dispose(); }
});
