import { expect, it, vi } from "vitest";
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
      const calls: string[] = [];
      for await (const event of graph.streamEvents({ messages: [{ role: "user", content: "Draft a proposal." }] },
        { ...config, context: { projectInstructions } })) {
        if (event.event === "on_chat_model_start") calls.push(JSON.stringify(event.data));
      }
      return calls.at(-1)!;
    };
    const first = await turn({ projectId: "p1", revision: 1, instructions: "Write in French." });
    expect(first).toContain("Write in French.");
    expect(first).toContain("Organization rule: never disclose credentials.");
    // LangChain serializes the inserted instruction as a HumanMessage.
    expect(first).toMatch(/HumanMessage/);
    const second = await turn({ projectId: "p1", revision: 2, instructions: "Use Canadian dollars." });
    expect(second).toContain("Use Canadian dollars.");
    expect(second).not.toContain("Write in French.");
    const cleared = await turn({ projectId: "p1", revision: 3, instructions: "" });
    expect(cleared).not.toContain("Use Canadian dollars.");
    const detached = await turn(null);
    expect(detached).not.toContain("Saved project instructions");
    const state = (await checkpointer.getTuple(config))!.checkpoint.channel_values;
    expect(state.messages).toHaveLength(8);
    expect(JSON.stringify(state.messages)).not.toContain("Write in French.");
    expect(JSON.stringify(state.messages)).not.toContain("Use Canadian dollars.");
  } finally { await runtime.dispose(); }
});
