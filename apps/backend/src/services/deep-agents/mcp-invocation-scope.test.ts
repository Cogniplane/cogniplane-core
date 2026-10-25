// These tests use the installed @langchain/mcp-adapters. `loadMcpTools` builds
// the tools over the scope's client facade, and a fake SDK client records what
// would go on the wire.

import { loadMcpTools } from "@langchain/mcp-adapters";
import { describe, expect, it, vi } from "vitest";

import { MCP_INVOCATION_META_KEY } from "../mcp/invocation-metadata.js";
import { McpInvocationScope, type McpToolClient } from "./mcp-invocation-scope.js";

const strictSchema = {
  type: "object",
  properties: { n: { type: "integer" } },
  required: ["n"],
  additionalProperties: false
};

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeClient() {
  const wire: Array<{ arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }> = [];
  const fork = vi.fn();
  const client = {
    getProtocolEra: () => "legacy" as const,
    listTools: async () => ({ tools: [{ name: "count", inputSchema: strictSchema }] }),
    callTool: vi.fn(async (params: { arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }) => {
      // Later calls answer first, so the executions overlap in another order.
      await tick(5 - Number(params.arguments?.n ?? 0) % 5);
      wire.push({ arguments: params.arguments, _meta: params._meta });
      return { content: [{ type: "text", text: "done" }] };
    }),
    fork
  };
  return { client: client as unknown as McpToolClient, callTool: client.callTool, fork, wire };
}

describe("McpInvocationScope", () => {
  it("gives each parallel execution its own trusted values over one client", async () => {
    const scope = new McpInvocationScope();
    const { client, wire } = fakeClient();
    const [tool] = await loadMcpTools("managed", scope.client(client), {
      beforeToolCall: async (request) => {
        const n = (request.args as { n: number }).n;
        // The hook awaits before it writes, so the executions interleave here too.
        await tick(n % 3);
        scope.attach({ toolContextId: `ctx_${n}`, ...(n % 2 ? { policyApprovalId: `polapr_${n}` } : {}) });
      }
    });
    scope.bind(tool!);

    await Promise.all(Array.from({ length: 12 }, (_, n) =>
      tool!.invoke({ type: "tool_call", id: `call-${n}`, name: "count", args: { n } })));

    expect(wire).toHaveLength(12);
    for (const request of wire) {
      const n = request.arguments!.n as number;
      expect(request.arguments).toEqual({ n });
      expect(request._meta).toEqual({ [MCP_INVOCATION_META_KEY]: {
        toolContextId: `ctx_${n}`, ...(n % 2 ? { policyApprovalId: `polapr_${n}` } : {}) } });
    }
  });

  it("keeps the tool object and the server's schema", async () => {
    const scope = new McpInvocationScope();
    const [tool] = await loadMcpTools("managed", scope.client(fakeClient().client));
    expect(scope.bind(tool!)).toBe(tool);
    expect(tool!.schema).toEqual(strictSchema);
  });

  it("sends no trusted entry when the hook has no values", async () => {
    const scope = new McpInvocationScope();
    const { client, wire } = fakeClient();
    const [tool] = await loadMcpTools("managed", scope.client(client), { beforeToolCall: () => scope.attach(undefined) });
    await scope.bind(tool!).invoke({ type: "tool_call", id: "call-1", name: "count", args: { n: 1 } });
    expect(wire).toEqual([{ arguments: { n: 1 }, _meta: undefined }]);
  });

  it("has no fork, so per-call headers cannot open another connection", async () => {
    const scope = new McpInvocationScope();
    const { client, callTool, fork } = fakeClient();
    const facade = scope.client(client);
    expect("fork" in facade).toBe(false);
    const [tool] = await loadMcpTools("managed", facade, { beforeToolCall: () => ({ headers: { "X-Approval": "polapr_1" } }) });

    await expect(scope.bind(tool!).invoke({ type: "tool_call", id: "call-1", name: "count", args: { n: 1 } }))
      .rejects.toThrow(/does not support header changes/);
    expect(fork).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("refuses a call outside a bound execution instead of sending it without its context", async () => {
    const scope = new McpInvocationScope();
    const { client, callTool } = fakeClient();
    const [unbound] = await loadMcpTools("managed", scope.client(client), { beforeToolCall: () => scope.attach({ toolContextId: "ctx_1" }) });

    await expect(unbound!.invoke({ type: "tool_call", id: "call-1", name: "count", args: { n: 1 } }))
      .rejects.toThrow(/no invocation scope/);
    await expect(scope.client(client).callTool({ name: "count", arguments: { n: 1 } }))
      .rejects.toThrow(/no invocation scope/);
    expect(callTool).not.toHaveBeenCalled();
  });
});
