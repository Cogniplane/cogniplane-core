// The tool context check must come before every request to the model
// provider, also the summaries that the deepagents summarization middleware
// asks from the model directly (a long history, and the emergency summary
// after a context overflow), for the root agent and for delegated agents.
// Real adapter and real deepagents graph; only the model is fake. The fake
// model records each provider call, and the tool context store records each
// check, in the same log.

import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it, vi } from "vitest";

import type { ToolContextLiveness } from "../auth/tool-execution-context-store.js";
import { createInMemoryApprovalStore } from "../../test-helpers/in-memory-approval-store.js";
import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { createTestConfig } from "../../test-helpers/test-config.js";
import { testRuntimePolicy } from "../../test-helpers/test-runtime-policy.js";
import { DeepAgentsRuntimeAdapter } from "./deep-agents-runtime-adapter.js";

type Step = { name: string; overflow?: true; text?: string; toolCall?: { name: string; args: Record<string, unknown> } };

const model = vi.hoisted(() => ({
  /** Provider calls and tool context checks, in order. */
  log: [] as string[],
  /** The agent calls to answer, in order. A summary call takes no step. */
  steps: [] as Step[]
}));

/** The model profile: summaries start at 85% of it (deepagents PROFILE_TRIGGER). */
const MAX_INPUT_TOKENS = 200_000;
/** About 200 000 tokens: more than the trigger. */
const LONG = "a".repeat(800_000);
/** About 100 000 tokens: less than the trigger, more than the 10% that a summary keeps. */
const MEDIUM = "b".repeat(400_000);

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessage, AIMessageChunk } = await import("@langchain/core/messages");
  const { ChatGenerationChunk } = await import("@langchain/core/outputs");
  const { ContextOverflowError } = await import("@langchain/core/errors");
  type Messages = Parameters<InstanceType<typeof FakeStreamingChatModel>["_generate"]>[0];
  class SummarizingModel extends FakeStreamingChatModel {
    override get profile() { return { maxInputTokens: MAX_INPUT_TOKENS }; }
    override bindTools() { return this.withConfig({}); }
    respond(messages: Messages) {
      const first = messages[0]?.content;
      if (messages.length === 1 && typeof first === "string" && first.startsWith("You are a conversation summarizer")) {
        model.log.push("provider: summary");
        return new AIMessage("Summary of the earlier conversation.");
      }
      const step = model.steps.shift() ?? { name: "answer", text: "Done." };
      model.log.push(`provider: ${step.name}`);
      if (step.overflow) throw new ContextOverflowError();
      return new AIMessage({
        content: step.text ?? "",
        tool_calls: step.toolCall ? [{ ...step.toolCall, id: `${step.name}-call` }] : []
      });
    }
    override async _generate(messages: Messages) {
      const message = this.respond(messages);
      return { generations: [{ text: String(message.content), message }] };
    }
    override async *_streamResponseChunks(...[messages, , runManager]: Parameters<InstanceType<typeof FakeStreamingChatModel>["_streamResponseChunks"]>) {
      const message = this.respond(messages);
      const text = String(message.content);
      const chunk = new ChatGenerationChunk({ text, message: new AIMessageChunk({ content: text, tool_calls: message.tool_calls }) });
      yield chunk;
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk });
    }
  }
  return { ...actual, initChatModel: async () => new SummarizingModel({}) };
});

const tenantId = "tenant-1";
const sessionId = "session-1";
const userId = "user-1";

/**
 * The adapter with the real graph. Each context is live until `endContext`
 * makes it dead from one of its checks on (the first check of a turn is 1).
 */
function setup() {
  const checks = new Map<string, number>();
  const dead = new Map<string, { from: number; state: ToolContextLiveness }>();
  const toolContexts = {
    extend: vi.fn(async () => null),
    liveness: vi.fn(async (_tenantId: string, toolContextId: string): Promise<ToolContextLiveness> => {
      const count = (checks.get(toolContextId) ?? 0) + 1;
      checks.set(toolContextId, count);
      model.log.push("check");
      const end = dead.get(toolContextId);
      return end && count >= end.from ? end.state : "live";
    })
  };
  const adapter = new DeepAgentsRuntimeAdapter(
    createTestConfig(),
    {
      compileRuntimeConfig: async () => ({
        runtimePolicy: testRuntimePolicy, skills: [], mcpServers: [], hash: "liveness", sources: {
          runtimePolicy: { id: "test", version: 1, hash: "test" }, skills: [], mcpServers: []
        }
      }),
      getRuntimePolicy: async () => testRuntimePolicy
    } as never,
    createSilentLogger(),
    {
      approvals: createInMemoryApprovalStore() as never,
      auditEvents: { create: async () => {} } as never,
      executions: { isCurrent: async () => true, bindRuntime: async () => {} },
      sessions: {
        async getReadable() {
          return { sessionId, userId, sessionName: "Test", status: "active" as const, projectId: null,
            createdAt: "2026-01-01", updatedAt: "2026-01-01", transcriptFormat: "current" as const };
        }
      },
      tenantMembers: { isUserBetaTester: async () => false },
      toolContexts
    },
    { hasKey: async () => true, resolveKey: async () => "test-key", platformProviders: new Set() }
  );
  const turn = async (toolContextId: string, prompt: string) => {
    const session = await adapter.createSession({ tenantId, sessionId, userId });
    const events: BaseEvent[] = [];
    for await (const event of adapter.runMessageAGUI(session, { prompt, toolContextId })) events.push(event);
    return events;
  };
  return {
    adapter, toolContexts, turn,
    endContext(toolContextId: string, from: number, state: ToolContextLiveness = "security_change") {
      dead.set(toolContextId, { from, state });
    }
  };
}

function reset(steps: Step[]) {
  model.log.length = 0;
  model.steps = steps;
}

const stoppedBy = (reason: string) => expect.objectContaining({
  type: EventType.RUN_FINISHED, result: { interrupted: true, reason }
});

/** The root agent delegates; the delegated agent updates its todos, then makes the `later` calls. */
function delegatedSteps(firstText: string, later: Step[]): Step[] {
  return [
    { name: "root delegates", toolCall: { name: "task", args: { subagent_type: "general-purpose", description: "Do the delegated work." } } },
    { name: "delegated step 1", text: firstText, toolCall: { name: "write_todos", args: { todos: [{ content: "Finish", status: "in_progress" }] } } },
    ...later,
    { name: "root answers", text: "Done." }
  ];
}

describe("tool context check before each provider call, summaries included", () => {
  it("root agent, long history: the summary call is checked first and is not sent for a dead context", async () => {
    const live = setup();
    try {
      reset([{ name: "turn 1 answer", text: LONG }]);
      await live.turn("ctx-1", "Write a long report.");
      reset([{ name: "turn 2 answer", text: "Short answer." }]);
      await live.turn("ctx-2", "Continue.");
      // The summary is a provider call of its own, before the agent call.
      expect(model.log).toEqual(["check", "provider: summary", "check", "provider: turn 2 answer"]);
    } finally { await live.adapter.close(); }

    const revoked = setup();
    try {
      reset([{ name: "turn 1 answer", text: LONG }]);
      await revoked.turn("ctx-1", "Write a long report.");
      revoked.endContext("ctx-2", 1);
      reset([{ name: "turn 2 answer", text: "Short answer." }]);
      const events = await revoked.turn("ctx-2", "Continue.");
      expect(model.log).toEqual(["check"]);
      expect(events.at(-1)).toEqual(stoppedBy("security_change"));
    } finally { await revoked.adapter.close(); }
  });

  it("root agent, context overflow: the emergency summary is checked first and is not sent for a dead context", async () => {
    const live = setup();
    try {
      reset([{ name: "turn 1 answer", text: MEDIUM }]);
      await live.turn("ctx-1", "Write a report.");
      reset([{ name: "overflow", overflow: true }, { name: "turn 2 answer", text: "Short answer." }]);
      await live.turn("ctx-2", "Continue.");
      expect(model.log).toEqual([
        "check", "provider: overflow", "check", "provider: summary", "check", "provider: turn 2 answer"
      ]);
    } finally { await live.adapter.close(); }

    const revoked = setup();
    try {
      reset([{ name: "turn 1 answer", text: MEDIUM }]);
      await revoked.turn("ctx-1", "Write a report.");
      // The security change commits while the call that overflows runs.
      revoked.endContext("ctx-2", 2);
      reset([{ name: "overflow", overflow: true }, { name: "turn 2 answer", text: "Short answer." }]);
      const events = await revoked.turn("ctx-2", "Continue.");
      expect(model.log).toEqual(["check", "provider: overflow", "check"]);
      expect(events.at(-1)).toEqual(stoppedBy("security_change"));
    } finally { await revoked.adapter.close(); }
  });

  it("delegated agent, long history: the summary call is checked first and is not sent for a dead context", async () => {
    const steps = () => delegatedSteps(LONG, [{ name: "delegated step 2", text: "Delegated answer." }]);
    const live = setup();
    try {
      reset(steps());
      await live.turn("ctx-1", "Delegate the work.");
      expect(model.log).toEqual([
        "check", "provider: root delegates", "check",
        "check", "provider: delegated step 1", "check",
        "check", "provider: summary", "check", "provider: delegated step 2",
        "check", "provider: root answers"
      ]);
    } finally { await live.adapter.close(); }

    const revoked = setup();
    try {
      revoked.endContext("ctx-1", 5);
      reset(steps());
      const events = await revoked.turn("ctx-1", "Delegate the work.");
      expect(model.log).toEqual([
        "check", "provider: root delegates", "check",
        "check", "provider: delegated step 1", "check",
        "check"
      ]);
      expect(events.at(-1)).toEqual(stoppedBy("security_change"));
    } finally { await revoked.adapter.close(); }
  });

  it("delegated agent, context overflow: the emergency summary is checked first and is not sent for a dead context", async () => {
    const steps = () => delegatedSteps(MEDIUM, [
      { name: "delegated overflow", overflow: true },
      { name: "delegated step 2", text: "Delegated answer." }
    ]);
    const live = setup();
    try {
      reset(steps());
      await live.turn("ctx-1", "Delegate the work.");
      expect(model.log).toEqual([
        "check", "provider: root delegates", "check",
        "check", "provider: delegated step 1", "check",
        "check", "provider: delegated overflow", "check", "provider: summary", "check", "provider: delegated step 2",
        "check", "provider: root answers"
      ]);
    } finally { await live.adapter.close(); }

    const revoked = setup();
    try {
      revoked.endContext("ctx-1", 6, "ended");
      reset(steps());
      const events = await revoked.turn("ctx-1", "Delegate the work.");
      expect(model.log).toEqual([
        "check", "provider: root delegates", "check",
        "check", "provider: delegated step 1", "check",
        "check", "provider: delegated overflow", "check"
      ]);
      expect(events.at(-1)).toEqual(stoppedBy("tool_context_ended"));
    } finally { await revoked.adapter.close(); }
  });
});
