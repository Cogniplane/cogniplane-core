// A Policy Center approval for a proxy tool through the real Deep Agents graph,
// the real MCP client, the real MCP gateway over HTTP and a fake upstream MCP
// server. Only the model and the stores are fakes. The upstream tool has a strict
// schema with no `toolContextId`, so any transport value in the arguments would
// fail it. The tests read the requests that the gateway received and the
// requests that the upstream received.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";

import type { PolicyRule } from "@cogniplane/shared-types";

import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";
import { createProxyMcpUpstream } from "../test-helpers/mcp-route-test-support.js";
import {
  createTestApp,
  createTestToolContext,
  TEST_RUNTIME_TOKEN_SECRET
} from "../test-helpers/routes-test-support.js";
import { testRuntimePolicy } from "../test-helpers/test-runtime-policy.js";
import { createDeepAgentsSessionRuntime } from "../services/deep-agents/deep-agents-graph.js";
import { generateRuntimeToken } from "../services/auth/runtime-token.js";
import { MCP_INVOCATION_META_KEY } from "../services/mcp/invocation-metadata.js";
import { POLICY_APPROVAL_REQUEST_METHOD, type PolicyApprovalProof } from "../services/policy/policy-approval-proof.js";
import { PolicyService } from "../services/policy/policy-service.js";
import type { PolicyDecisionStore } from "../services/policy/policy-decision-store.js";
import type { PolicyRuleStore } from "../services/policy/policy-rule-store.js";
import type { AuditEventStore } from "../services/audit-event-store.js";

type ToolCall = { id: string; name: string; args: Record<string, unknown> };

const modelState = vi.hoisted(() => ({
  toolCalls: [] as ToolCall[],
  emitted: false
}));

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessage, AIMessageChunk } = await import("@langchain/core/messages");
  class ToolCallingModel extends FakeStreamingChatModel {
    override bindTools() { return this.withConfig({}); }
    override async *_streamResponseChunks(...args: Parameters<InstanceType<typeof FakeStreamingChatModel>["_streamResponseChunks"]>) {
      this.chunks = modelState.toolCalls.length > 0 && !modelState.emitted
        ? [new AIMessageChunk({ content: "", tool_calls: modelState.toolCalls })]
        : [];
      modelState.emitted = true;
      yield* super._streamResponseChunks(...args);
    }
  }
  return {
    ...actual,
    initChatModel: async () => new ToolCallingModel({ sleep: 0, responses: [new AIMessage("Done.")], chunks: [] })
  };
});

// A third-party tool. It is strict, and it has no `toolContextId` field.
const SEARCH_TOOL = {
  name: "search_docs",
  description: "Search the documents.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  annotations: { readOnlyHint: false }
};

const REVIEW_RULE = {
  ruleId: "pol_review_search", tenantId: "test-tenant", name: "Review searches", description: null, priority: 1,
  enabled: true, effect: "require_approval", conditions: { toolNames: ["search_docs"] }, reason: "Review this search.",
  createdBy: null, createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z"
} as PolicyRule;

type GatewayRequest = { authorization?: string; body: { method?: string; params?: Record<string, unknown> } };

/**
 * Forwards HTTP requests to `target` and records each JSON-RPC body on the way:
 * what the runtime's MCP client put on the wire for the gateway.
 */
async function startRecordingForwarder(target: string) {
  const requests: GatewayRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => void (async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (request.method === "POST") {
        requests.push({ authorization: request.headers.authorization, body: JSON.parse(raw) as GatewayRequest["body"] });
      }
      const headers = Object.fromEntries(Object.entries(request.headers)
        .filter(([name]) => !["host", "connection", "content-length"].includes(name))
        .map(([name, value]) => [name, String(value)]));
      const forwarded = await fetch(`${target}${request.url}`, {
        method: request.method, headers, ...(request.method === "POST" ? { body: raw } : {})
      });
      const body = await forwarded.text();
      response.writeHead(forwarded.status, { "content-type": forwarded.headers.get("content-type") ?? "application/json" });
      response.end(body);
    })());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  modelState.toolCalls = [];
  modelState.emitted = false;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup() {
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream({
    respond: (body) => body.method === "tools/list"
      ? { jsonrpc: "2.0", id: body.id ?? null, result: { tools: [SEARCH_TOOL] } }
      : { jsonrpc: "2.0", id: body.id ?? null, result: { content: [{ type: "text", text: "found" }], isError: false } }
  });
  cleanups.push(() => upstream.close());
  const policyService = new PolicyService({
    rules: { async list() { return [REVIEW_RULE]; } } as unknown as PolicyRuleStore,
    decisions: { async record() { return { decisionId: "pdc_1" }; }, async list() { return []; } } as unknown as PolicyDecisionStore,
    auditEvents: new InMemoryAuditEventStore() as unknown as AuditEventStore,
    ruleCacheTtlMs: 0
  });
  const { app, toolContexts, approvals } = await createTestApp({ proxyUpstreamUrl: `${upstreamUrl}/`, policyService });
  cleanups.push(() => app.close());
  const forwarder = await startRecordingForwarder(await app.listen({ host: "127.0.0.1", port: 0 }));
  cleanups.push(() => forwarder.close());
  const { url, requests: gatewayRequests } = forwarder;

  const sessionId = "proxy-e2e-session";
  const runtimeId = "runtime-proxy-e2e-session";
  const runtimePolicy = { ...testRuntimePolicy, policyEnforcementMode: "enforce" as const,
    enabledMcpServers: [...testRuntimePolicy.enabledMcpServers, "test-proxy"] };
  const context = await createTestToolContext(toolContexts, { sessionId, userId: "test-user", runtimeId,
    metadata: { runtimePolicy, turnContext: "interactive" } });
  const token = generateRuntimeToken(
    { sid: sessionId, tid: "test-tenant", uid: "test-user", rid: runtimeId }, TEST_RUNTIME_TOKEN_SECRET);
  const runtime = createDeepAgentsSessionRuntime({
    tenantId: "test-tenant", sessionId, userId: "test-user", runtimeId,
    resolveProviderKey: async () => "sk-test", systemPrompt: null, workspacePath: "/workspace", e2b: null,
    logger: createSilentLogger(), checkpointer: new MemorySaver(),
    mcpServers: [{ id: "test-proxy", mode: "proxy", url: `${url}/mcp/test-proxy`, authorization: `Bearer ${token}` }],
    approvals: { gate: false, autoApproveReadOnly: true, readOnlyToolNames: [] },
    policyService,
    toolContextRef: { current: context.toolContextId },
    policyContextRef: { current: { toolContextId: context.toolContextId, turnContext: "interactive", enforcementMode: "enforce" } }
  });
  cleanups.push(() => runtime.dispose());

  async function run(input: unknown) {
    const graph = await runtime.getAgentForModel("deepagents/claude-sonnet-5");
    for await (const _event of graph.streamEvents(input, { version: "v2", configurable: { thread_id: sessionId } })) {
      // The requests on both sides of the gateway are what the tests read.
    }
  }

  // What the approval route leaves in the approvals table once the user decided.
  function decide(proof: PolicyApprovalProof, status: "approved" | "expired" = "approved") {
    const now = new Date().toISOString();
    approvals.rows.set(proof.approvalId, {
      approvalId: proof.approvalId, tenantId: "test-tenant", sessionId, userId: "test-user", runtimeId,
      turnId: "turn-1", itemId: proof.approvalId, requestMethod: POLICY_APPROVAL_REQUEST_METHOD, requestId: proof.approvalId,
      kind: "mcp_tool", title: "Approve search_docs", summary: "", status, decision: status === "approved" ? "approve" : null,
      requestPayload: { policyApproval: proof }, createdAt: now, updatedAt: now, resolvedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
  }

  const gatewayCalls = () => gatewayRequests.filter((request) => request.body.method === "tools/call");
  const upstreamCalls = () => upstreamRequests.filter((request) => request.body.method === "tools/call");
  const initializations = () => gatewayRequests.filter((request) => request.body.method === "initialize");
  return { app, runtime, run, decide, approvals, context, sessionId, gatewayCalls, upstreamCalls, initializations };
}

async function approveTurn(env: Awaited<ReturnType<typeof setup>>, toolCalls: ToolCall[]) {
  modelState.toolCalls = toolCalls;
  modelState.emitted = false;
  await env.run({ messages: [{ role: "user", content: "Search the documents" }] });
  const pending = await env.runtime.getPendingActions(env.sessionId);
  for (const action of pending) env.decide(action.policyApproval!);
  await env.run(env.runtime.buildResumeInput(pending, pending.map(() => ({ type: "approve" as const }))));
  return pending;
}

it("forwards approved parallel calls with their own proofs, and the upstream gets only the arguments", async () => {
  const env = await setup();
  const calls = [
    { id: "call-1", name: "search_docs", args: { query: "roadmap" } },
    { id: "call-2", name: "search_docs", args: { query: "budget" } }
  ];

  const pending = await approveTurn(env, calls);

  // One prompt per call, each with its own proof bound to the call's arguments.
  expect(pending.map((action) => [action.args, action.policyApproval?.toolCallId])).toEqual([
    [{ query: "roadmap" }, "call-1"], [{ query: "budget" }, "call-2"]
  ]);
  const proofFor = (query: string) => pending.find((action) => action.args.query === query)!.policyApproval!;
  expect(proofFor("roadmap").approvalId).not.toBe(proofFor("budget").approvalId);

  // The gateway received the model's arguments as they were, and each call's own proof in `_meta`.
  expect(env.gatewayCalls()).toHaveLength(2);
  for (const call of env.gatewayCalls()) {
    const query = (call.body.params!.arguments as { query: string }).query;
    expect(call.body.params).toEqual({ name: "search_docs", arguments: { query }, _meta: { [MCP_INVOCATION_META_KEY]: {
      toolContextId: env.context.toolContextId, policyApprovalId: proofFor(query).approvalId } } });
  }
  expect(env.approvals.consumed).toEqual(new Set([proofFor("roadmap").approvalId, proofFor("budget").approvalId]));

  // The upstream received each call once, with no transport value in the arguments or in `_meta`.
  expect(env.upstreamCalls().map((request) => request.body.params)).toEqual(expect.arrayContaining([
    { name: "search_docs", arguments: { query: "roadmap" } },
    { name: "search_docs", arguments: { query: "budget" } }
  ]));
  expect(env.upstreamCalls()).toHaveLength(2);
  for (const request of env.upstreamCalls()) {
    expect(request.rawBody).not.toContain(MCP_INVOCATION_META_KEY);
    expect(request.rawBody).not.toContain("polapr_");
    expect(request.rawBody).not.toContain(env.context.toolContextId);
  }
});

it("keeps one MCP connection for the session across turns", async () => {
  const env = await setup();

  await approveTurn(env, [{ id: "call-1", name: "search_docs", args: { query: "roadmap" } }]);
  await approveTurn(env, [{ id: "call-2", name: "search_docs", args: { query: "budget" } }]);

  expect(env.upstreamCalls()).toHaveLength(2);
  expect(env.initializations()).toHaveLength(1);
});

it("refuses a replay of the exact request that the runtime sent", async () => {
  const env = await setup();
  await approveTurn(env, [{ id: "call-1", name: "search_docs", args: { query: "roadmap" } }]);
  const [sent] = env.gatewayCalls();

  const replay = await env.app.inject({ method: "POST", url: "/mcp/test-proxy",
    headers: { authorization: sent!.authorization! }, payload: sent!.body });

  expect(replay.json().error).toMatchObject({ code: -32004, message: expect.stringMatching(/already used/i) });
  expect(env.upstreamCalls()).toHaveLength(1);
});

it("does not forward a call whose approval expired", async () => {
  const env = await setup();
  modelState.toolCalls = [{ id: "call-1", name: "search_docs", args: { query: "roadmap" } }];
  await env.run({ messages: [{ role: "user", content: "Search the documents" }] });
  const pending = await env.runtime.getPendingActions(env.sessionId);
  env.decide(pending[0]!.policyApproval!, "expired");

  // A JSON-RPC error from the gateway reaches the graph as a thrown tool exception and ends the turn.
  const failure = await env.run(env.runtime.buildResumeInput(pending, [{ type: "approve" }])).then(() => null, (error: unknown) => error);
  expect(String(failure)).toMatch(/Approval request expired/);
  expect(String(failure)).not.toMatch(/polapr_|ctx_/);

  expect(env.gatewayCalls()).toHaveLength(1);
  expect(env.approvals.consumed.size).toBe(0);
  expect(env.upstreamCalls()).toEqual([]);
});
