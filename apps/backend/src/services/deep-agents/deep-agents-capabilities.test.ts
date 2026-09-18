import { expect, it, vi } from "vitest";
import { CurrentSkillsCheckpointer } from "./current-skills-checkpointer.js";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgentsSessionRuntime } from "./deep-agents-graph.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import type { SkillsLibraryFiles } from "./deep-agents-skills-library.js";

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessage } = await import("@langchain/core/messages");
  return { ...actual, initChatModel: async () => new FakeStreamingChatModel({ responses: [new AIMessage("Done.")] }) };
});

function library(name: string): SkillsLibraryFiles {
  return { [`/${name}/SKILL.md`]: { content: `---\nname: ${name}\ndescription: ${name} instructions\n---\nBody.`, mimeType: "text/markdown", created_at: "2026-09-13T00:00:00Z", modified_at: "2026-09-13T00:00:00Z" } };
}

it("replaces checkpointed skill metadata across selection changes and restart, retaining messages", async () => {
  const checkpointer = new MemorySaver();
  const init = { tenantId: "tenant", sessionId: "session", userId: "user", runtimeId: "runtime",
    resolveProviderKey: async () => "test", systemPrompt: null, workspacePath: "/workspace", e2b: null,
    checkpointer, logger: createSilentLogger() };
  let runtime = createDeepAgentsSessionRuntime({ ...init, skillsLibraryFiles: library("alpha") });
  const config = { configurable: { thread_id: "session" }, version: "v2" as const };
  const modelInputs: string[] = [];
  const turn = async (prompt: string) => {
    const graph = await runtime.getAgentForModel("openai/gpt-5.4");
    for await (const event of graph.streamEvents({ messages: [{ role: "user", content: prompt }],
      ...(prompt === "First turn" ? { files: { "/notes.txt": { content: "Keep these notes", mimeType: "text/plain", created_at: "2026-09-13T00:00:00Z", modified_at: "2026-09-13T00:00:00Z" } } } : {})
    }, config)) {
      if (event.event === "on_chat_model_start") modelInputs.push(JSON.stringify(event.data));
    }
    return (await checkpointer.getTuple(config))!.checkpoint.channel_values;
  };
  let state = await turn("First turn");
  expect(state.skillsMetadata).toEqual([expect.objectContaining({ name: "alpha" })]);
  expect(modelInputs.at(-1)).toContain("alpha instructions");
  const currentSaver = new CurrentSkillsCheckpointer(checkpointer);
  expect((await currentSaver.getTuple(config))!.checkpoint.channel_values.skillsMetadata).toBeUndefined();
  let historyCount = 0;
  for await (const tuple of currentSaver.list(config)) {
    expect(tuple.checkpoint.channel_values.skillsMetadata).toBeUndefined();
    expect(tuple.pendingWrites?.some(([, channel]) => channel === "skillsMetadata")).not.toBe(true);
    historyCount++;
  }
  expect(historyCount).toBeGreaterThan(0);
  await runtime.refreshCapabilities({ skillsLibraryFiles: library("beta"), mcpServers: [] });
  state = await turn("Second turn");
  expect(state.skillsMetadata).toEqual([expect.objectContaining({ name: "beta" })]);
  expect(state.messages).toHaveLength(4);
  expect(modelInputs.at(-1)).toContain("beta instructions");
  expect(modelInputs.at(-1)).not.toContain("alpha instructions");
  await runtime.dispose();
  runtime = createDeepAgentsSessionRuntime({ ...init, skillsLibraryFiles: {} });
  state = await turn("Third turn");
  expect(state.skillsMetadata).toEqual([]);
  expect(state.messages).toHaveLength(6);
  expect(modelInputs.at(-1)).not.toContain("beta instructions");
  expect(modelInputs.at(-1)).not.toContain("alpha instructions");
  expect(state.files).toMatchObject({ "/notes.txt": { content: "Keep these notes" } });
  await runtime.dispose();
});
