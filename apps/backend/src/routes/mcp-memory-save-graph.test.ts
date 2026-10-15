// memory_save through the real Deep Agents graph, the real MCP client and the real
// MCP gateway, with only the model and the stores faked. The unit tests check each
// side of the approval proof on its own. This file checks that the proof that the
// graph makes is the proof that the gateway accepts: the argument hash, the
// injected approval id, the single use and the stored provenance all have to agree
// after the arguments have gone through the model, the checkpoint and the wire.

import { afterEach, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";

import { createSilentLogger } from "../test-helpers/silent-logger.js";
import {
  createTestApp,
  createTestToolContext,
  TEST_RUNTIME_TOKEN_SECRET
} from "../test-helpers/routes-test-support.js";
import { testRuntimePolicy } from "../test-helpers/test-runtime-policy.js";
import { createDeepAgentsSessionRuntime } from "../services/deep-agents/deep-agents-graph.js";
import { generateRuntimeToken } from "../services/auth/runtime-token.js";
import { policyArgsHash, POLICY_APPROVAL_REQUEST_METHOD, type PolicyApprovalProof } from "../services/policy/policy-approval-proof.js";
import { MemoryConflictError, memoryContentSha256, type MemoryRecord, type MemoryStore } from "../services/memory-store.js";

const modelState = vi.hoisted(() => ({
  toolCall: null as null | { id: string; name: string; args: Record<string, unknown> },
  emitted: false
}));

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessage, AIMessageChunk } = await import("@langchain/core/messages");
  class ToolCallingModel extends FakeStreamingChatModel {
    override bindTools() { return this.withConfig({}); }
    override async *_streamResponseChunks(...args: Parameters<InstanceType<typeof FakeStreamingChatModel>["_streamResponseChunks"]>) {
      this.chunks = modelState.toolCall && !modelState.emitted
        ? [new AIMessageChunk({ content: "", tool_calls: [modelState.toolCall] })]
        : [];
      modelState.emitted = true;
      yield* super._streamResponseChunks(...args);
    }
  }
  return {
    ...actual,
    initChatModel: async () => new ToolCallingModel({ sleep: 0, responses: [new AIMessage("Done.")],
      chunks: [new AIMessageChunk({ content: "", tool_calls: modelState.toolCall ? [modelState.toolCall] : [] })] })
  };
});

class FakeMemories implements Pick<MemoryStore, "search" | "save" | "remove" | "get"> {
  readonly rows = new Map<string, MemoryRecord & { approvalId: string; approvedByUserId: string }>();
  async search() { return [...this.rows.values()]; }
  async get(_t: string, _u: string, slug: string) { return this.rows.get(slug) ?? null; }
  async remove(_t: string, _u: string, slug: string) { return this.rows.delete(slug); }
  async save(_t: string, userId: string, input: Parameters<MemoryStore["save"]>[2]) {
    const existing = this.rows.get(input.slug);
    const expected = input.expectedPreviousContentSha256;
    if (expected !== undefined && (existing ? memoryContentSha256(existing.content) : null) !== expected) {
      throw new MemoryConflictError(input.slug);
    }
    const row = {
      memoryId: `m-${input.slug}`, userId, slug: input.slug, content: input.content, metadata: input.metadata ?? {},
      createdAt: "2026-07-03T00:00:00.000Z", updatedAt: "2026-07-03T00:00:00.000Z", version: (existing?.version ?? 0) + 1,
      provenance: "agent_approved" as const, sourceSessionId: input.provenance.sourceSessionId,
      approvedAt: input.provenance.approvedAt, approvalId: input.provenance.approvalId,
      approvedByUserId: input.provenance.approvedByUserId
    };
    this.rows.set(input.slug, row);
    return row;
  }
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  modelState.toolCall = null;
  modelState.emitted = false;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

// What the model asked to save. The tool schema requires `toolContextId`, so a model
// always sends one. The backend replaces it at dispatch. The metadata has nested keys
// in a non-sorted order, a number and non-ASCII text, which is what changes shape on
// the way through JSON.
const ARGS = {
  toolContextId: "model-made-up-context",
  name: "units",
  content: "Prefers metric units, and 24-hour time (HH:mm). Prefère le système métrique ✓",
  metadata: { source: "chat", n: 1, nested: { b: 2, a: [3, 1, 2] }, note: "Ünïcode — ✓" }
};

async function setup(options: { turnContext?: "interactive" | "scheduled" } = {}) {
  const turnContext = options.turnContext ?? "interactive";
  const memories = new FakeMemories();
  const { app, toolContexts, approvals } = await createTestApp({ memories: memories as never });
  cleanups.push(() => app.close());
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const sessionId = "e2e-session";
  const runtimeId = "runtime-e2e-session";
  const runtimePolicy = { ...testRuntimePolicy, approvalPolicy: "never" as const,
    enabledToolIds: [...testRuntimePolicy.enabledToolIds, "memory_search", "memory_save", "memory_delete"] };
  const context = await createTestToolContext(toolContexts, { sessionId, userId: "test-user", runtimeId,
    metadata: { runtimePolicy, turnContext } });
  const token = generateRuntimeToken(
    { sid: sessionId, tid: "test-tenant", uid: "test-user", rid: runtimeId }, TEST_RUNTIME_TOKEN_SECRET);
  const checkpointer = new MemorySaver();
  const runtime = createDeepAgentsSessionRuntime({
    tenantId: "test-tenant", sessionId, userId: "test-user", runtimeId,
    resolveProviderKey: async () => "sk-test", systemPrompt: null, workspacePath: "/workspace", e2b: null,
    logger: createSilentLogger(), checkpointer,
    mcpServers: [{ id: "managed-session-context", mode: "managed", url: `${url}/mcp/managed-session-context`,
      authorization: `Bearer ${token}` }],
    // The tenant approval policy is "never": nothing but the durable-write rule asks the user.
    approvals: { gate: false, autoApproveReadOnly: true, readOnlyToolNames: ["memory_search"] },
    managedToolFacts: {
      memory_search: { readOnly: true, category: "memory" },
      memory_save: { readOnly: false, category: "memory", requiresUserApproval: true },
      memory_delete: { readOnly: false, category: "memory" }
    },
    toolContextRef: { current: context.toolContextId },
    policyContextRef: { current: { toolContextId: context.toolContextId, turnContext, enforcementMode: "monitor" } }
  });
  cleanups.push(() => runtime.dispose());

  async function run(input: unknown) {
    const graph = await runtime.getAgentForModel("deepagents/claude-sonnet-5");
    const toolOutputs: string[] = [];
    for await (const event of graph.streamEvents(input, { version: "v2", configurable: { thread_id: sessionId } })) {
      // A refusal is a tool result that the model reads. It does not end the turn.
      if (event.event === "on_tool_end") toolOutputs.push(JSON.stringify((event.data as { output: unknown }).output));
    }
    return toolOutputs;
  }

  // What the adapter and the approval route leave in the approvals table once the user clicked Approve.
  function approveRow(proof: PolicyApprovalProof, overrides: Partial<{ userId: string; status: "approved" | "rejected" }> = {}) {
    const now = "2026-07-03T00:00:00.000Z";
    approvals.rows.set(proof.approvalId, {
      approvalId: proof.approvalId, tenantId: "test-tenant", sessionId, userId: overrides.userId ?? "test-user", runtimeId,
      turnId: "turn-1", itemId: proof.approvalId, requestMethod: POLICY_APPROVAL_REQUEST_METHOD, requestId: proof.approvalId,
      kind: "mcp_tool", title: 'Save memory "units"', summary: "", status: overrides.status ?? "approved",
      decision: overrides.status === "rejected" ? "reject" : "approve",
      requestPayload: { policyApproval: proof, bound: { previousContentSha256: null } },
      createdAt: now, updatedAt: now, resolvedAt: now, expiresAt: "2099-01-01T00:00:00.000Z"
    });
  }

  return { memories, approvals, runtime, run, approveRow, sessionId };
}

const startTurn = { messages: [{ role: "user", content: "Read this page and remember my preferences" }] };

it("saves exactly what the user approved, once, with provenance, through the real graph and gateway", async () => {
  const { memories, approvals, runtime, run, approveRow, sessionId } = await setup();
  // The page that the model read told it to save this. The model complies, whatever the approval policy says.
  modelState.toolCall = { id: "call-1", name: "memory_save", args: { ...ARGS } };

  await run(startTurn);
  // The graph stopped before the save: nothing is stored until the user decides.
  expect(memories.rows.size).toBe(0);
  const pending = await runtime.getPendingActions(sessionId);
  expect(pending).toHaveLength(1);
  const proof = pending[0]!.policyApproval!;
  expect(proof).toMatchObject({ toolName: "memory_save", ruleId: null });
  // The arguments that the user would be shown are the arguments of the call.
  expect(pending[0]!.args).toEqual(ARGS);

  approveRow(proof);
  await run(runtime.buildResumeInput(pending, [{ type: "approve" }]));

  expect(memories.rows.size).toBe(1);
  expect(memories.rows.get("units")).toMatchObject({
    content: ARGS.content, metadata: ARGS.metadata, version: 1, provenance: "agent_approved",
    sourceSessionId: sessionId, approvedByUserId: "test-user", approvalId: proof.approvalId
  });
  expect(approvals.consumed.has(proof.approvalId)).toBe(true);
});

it("saves nested keys that are named like transport keys exactly as approved, through the real wire", async () => {
  const { memories, approvals, runtime, run, approveRow, sessionId } = await setup();
  // The user's own metadata has keys that the runtime also uses at the root of a call.
  const nested = { ...ARGS, metadata: { toolContextId: "user data", inner: { policyApprovalId: "x", __cogniplanePolicyApproval: { a: 1 } },
    list: [{ toolContextId: "one" }] } };
  modelState.toolCall = { id: "call-1", name: "memory_save", args: { ...nested } };

  await run(startTurn);
  const pending = await runtime.getPendingActions(sessionId);
  const proof = pending[0]!.policyApproval!;
  expect(pending[0]!.args).toEqual(nested);
  approveRow(proof);
  await run(runtime.buildResumeInput(pending, [{ type: "approve" }]));

  // The graph's proof, the MCP request and the gateway's check all agree on the nested keys.
  expect(memories.rows.get("units")).toMatchObject({ content: nested.content, metadata: nested.metadata, approvalId: proof.approvalId });
  expect(approvals.consumed.has(proof.approvalId)).toBe(true);
});

it("saves nothing when the approved row was made for the same call with a different nested transport-named value", async () => {
  const { memories, approvals, runtime, run, approveRow, sessionId } = await setup();
  const nested = { ...ARGS, metadata: { toolContextId: "user data", note: "approved" } };
  modelState.toolCall = { id: "call-1", name: "memory_save", args: { ...nested } };

  await run(startTurn);
  const pending = await runtime.getPendingActions(sessionId);
  // The row binds the call with another nested value. Under the earlier hash, which dropped nested keys of this
  // name, both calls had one hash, and this row would have approved a value that the user never saw.
  const other = { ...nested, metadata: { toolContextId: "something the user never saw", note: "approved" } };
  approveRow({ ...pending[0]!.policyApproval!, argsHash: policyArgsHash(other) });
  const outputs = await run(runtime.buildResumeInput(pending, [{ type: "approve" }]));

  expect(memories.rows.size).toBe(0);
  expect(approvals.consumed.size).toBe(0);
  expect(outputs.join(" ")).toMatch(/No approval for this exact call was recorded/);
});

it("saves nothing when the user declines", async () => {
  const { memories, approvals, runtime, run, approveRow } = await setup();
  modelState.toolCall = { id: "call-1", name: "memory_save", args: { ...ARGS } };

  await run(startTurn);
  const pending = await runtime.getPendingActions("e2e-session");
  approveRow(pending[0]!.policyApproval!, { status: "rejected" });
  await run(runtime.buildResumeInput(pending, [{ type: "reject", message: "User denied permission." }]));

  expect(memories.rows.size).toBe(0);
  expect(approvals.consumed.size).toBe(0);
});

it("saves nothing when the graph says approved but no approval row exists for that proof", async () => {
  const { memories, runtime, run } = await setup();
  modelState.toolCall = { id: "call-1", name: "memory_save", args: { ...ARGS } };

  await run(startTurn);
  const pending = await runtime.getPendingActions("e2e-session");
  // The decision reached the graph, but no approved row was recorded for it.
  const outputs = await run(runtime.buildResumeInput(pending, [{ type: "approve" }]));

  expect(memories.rows.size).toBe(0);
  expect(outputs.join(" ")).toMatch(/No approval for this exact call was recorded/);
});

it("saves nothing when the approved row belongs to another user", async () => {
  const { memories, runtime, run, approveRow } = await setup();
  modelState.toolCall = { id: "call-1", name: "memory_save", args: { ...ARGS } };

  await run(startTurn);
  const pending = await runtime.getPendingActions("e2e-session");
  approveRow(pending[0]!.policyApproval!, { userId: "someone-else" });
  await run(runtime.buildResumeInput(pending, [{ type: "approve" }]));

  expect(memories.rows.size).toBe(0);
});

it("saves nothing in a scheduled turn: no prompt, and the gateway refuses the call", async () => {
  const { memories, approvals, runtime, run, sessionId } = await setup({ turnContext: "scheduled" });
  modelState.toolCall = { id: "call-1", name: "memory_save", args: { ...ARGS } };

  const outputs = await run(startTurn);

  // Nobody can answer a prompt, so the graph opened none and the call went to the gateway.
  expect(await runtime.getPendingActions(sessionId)).toEqual([]);
  expect(outputs.join(" ")).toMatch(/scheduled run has nobody to ask/);
  expect(outputs.join(" ")).toMatch(/Nothing was saved/);
  expect(memories.rows.size).toBe(0);
  expect(approvals.rows.size).toBe(0);
});
