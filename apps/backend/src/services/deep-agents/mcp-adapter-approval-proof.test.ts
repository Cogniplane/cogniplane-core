// The runtime's MCP client with the installed @langchain/mcp-adapters, over real
// HTTP. A small legacy JSON-RPC server records each request as it arrives, so
// the tests read what went on the wire, not what a hook returned.

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MCP_INVOCATION_META_KEY, type McpInvocationMetadata } from "../mcp/invocation-metadata.js";
import { GatewayMcpClient, type GatewayMcpCall } from "./gateway-mcp-client.js";

// A managed tool schema. It is strict, and it requires the legacy `toolContextId` field.
const managedSchema = {
  type: "object",
  properties: { toolContextId: { type: "string" }, name: { type: "string" } },
  required: ["toolContextId", "name"],
  additionalProperties: false
};
// A proxy tool schema from a third-party server. It is strict, and it has no `toolContextId`.
const proxySchema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false
};

type WireRequest = { url: string; headers: IncomingHttpHeaders; body: { method?: string; id?: unknown; params?: Record<string, unknown> } };

async function startLegacyServer(options: { onToolsList?: () => boolean } = {}) {
  const requests: WireRequest[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 204 : 405).end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw) as WireRequest["body"];
      requests.push({ url: request.url ?? "", headers: request.headers, body });
      const reply = (result: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      };
      switch (body.method) {
        case "initialize":
          return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } });
        case "notifications/initialized":
          return void response.writeHead(202).end();
        case "tools/list":
          if (options.onToolsList?.() === false) return;
          return reply({ tools: [
            { name: "write_artifact", inputSchema: managedSchema },
            { name: "search", inputSchema: proxySchema, annotations: { readOnlyHint: true } }
          ] });
        case "tools/call": {
          // Answer later calls first, so parallel calls finish out of order.
          const delay = Number(String((body.params?.arguments as { name?: string; query?: string } | undefined)?.query ?? "0").slice(-1)) || 0;
          return void setTimeout(() => reply({ content: [{ type: "text", text: "ok" }] }), 8 - delay);
        }
        default:
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unsupported" } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/managed`;
  return {
    url,
    requests,
    calls: () => requests.filter((request) => request.body.method === "tools/call"),
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connect(resolveInvocation: (call: GatewayMcpCall) => McpInvocationMetadata | undefined) {
  const server = await startLegacyServer();
  const logger = { warn: vi.fn() };
  const client = new GatewayMcpClient({
    servers: [{ id: "managed", url: server.url, authorization: "Bearer rt_session_token" }],
    resolveInvocation, logger, sessionId: "session-1"
  });
  cleanups.push(() => client.close(), () => server.close());
  const [toolset] = await client.loadTools();
  const tool = (name: string) => toolset!.tools.find((candidate) => candidate.name === name)!;
  return { server, logger, client, tool };
}

describe("trusted invocation metadata through the real MCP adapter", () => {
  it("stops discovery when closed and opens no server after the close", async () => {
    const blocked = await startLegacyServer({ onToolsList: () => false });
    const healthy = await startLegacyServer();
    const client = new GatewayMcpClient({
      servers: [
        { id: "blocked", url: blocked.url, authorization: "Bearer rt_1" },
        { id: "healthy", url: healthy.url, authorization: "Bearer rt_1" }
      ],
      resolveInvocation: () => undefined, logger: { warn: vi.fn() }, sessionId: "session-1"
    });
    cleanups.push(() => client.close(), () => blocked.close(), () => healthy.close());
    const loading = client.loadTools();
    // The servers load in parallel: both are asked for their tools before the blocked one answers.
    await vi.waitFor(() => {
      expect(blocked.requests.some((request) => request.body.method === "tools/list")).toBe(true);
      expect(healthy.requests.some((request) => request.body.method === "tools/list")).toBe(true);
    });
    // Count connections, not requests: discovery lists the tools twice (in getClient
    // and in loadMcpTools), so a list sent before the close can arrive after it.
    const connections = (server: typeof healthy) =>
      server.requests.filter((request) => request.body.method === "initialize").length;

    await client.close();

    // The tools of the healthy server are discarded with the rest of the load.
    expect(await loading).toEqual([]);
    expect(await client.loadTools()).toEqual([]);
    // A closed client opens no new connection.
    expect(connections(healthy)).toBe(1);
    expect(connections(blocked)).toBe(1);
  });

  it("refuses tools retained from a closed client before resolving their context", async () => {
    const resolveInvocation = vi.fn(() => ({ toolContextId: "ctx_current" }));
    const { client, server, tool } = await connect(resolveInvocation);

    await client.close();

    await expect(tool("search").invoke({ type: "tool_call", id: "call-1", name: "search", args: { query: "roadmap" } }))
      .rejects.toThrow(/client is closed/i);
    expect(resolveInvocation).not.toHaveBeenCalled();
    expect(server.calls()).toEqual([]);
  });

  it("sends the turn context and approval proof outside the arguments of a strict managed schema", async () => {
    const resolveInvocation = vi.fn(() => ({ toolContextId: "ctx_trusted", policyApprovalId: "polapr_trusted" }));
    const { server, tool } = await connect(resolveInvocation);
    // The schema requires `toolContextId`, so the model writes one of its own.
    const modelArgs = { name: "report.md", toolContextId: "model-context" };

    await tool("write_artifact").invoke({ type: "tool_call", id: "call-1", name: "write_artifact", args: modelArgs });

    const [call] = server.calls();
    expect(call!.body.params).toEqual({ name: "write_artifact", arguments: modelArgs,
      _meta: { [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_trusted", policyApprovalId: "polapr_trusted" } } });
    // The hook still binds the proof to the graph's tool-call identity and the exact arguments.
    expect(resolveInvocation).toHaveBeenCalledWith({ name: "write_artifact", serverId: "managed", args: modelArgs, toolCallId: "call-1" });
    // The token goes in a header only, never in the URL.
    expect(call!.headers.authorization).toBe("Bearer rt_session_token");
    expect(call!.url).toBe("/mcp/managed");
  });

  it("calls a strict proxy schema that has no toolContextId field", async () => {
    const { server, tool } = await connect(() => ({ toolContextId: "ctx_trusted" }));

    await tool("search").invoke({ type: "tool_call", id: "call-1", name: "search", args: { query: "roadmap" } });

    expect(server.calls().map((call) => call.body.params)).toEqual([{ name: "search", arguments: { query: "roadmap" },
      _meta: { [MCP_INVOCATION_META_KEY]: { toolContextId: "ctx_trusted" } } }]);
  });

  it("shows the model the server's own schemas", async () => {
    const { tool } = await connect(() => undefined);
    expect(tool("write_artifact").schema).toEqual(managedSchema);
    expect(tool("search").schema).toEqual(proxySchema);
  });

  it("sends no trusted entry when the backend has no values for the call", async () => {
    const { server, tool } = await connect(() => undefined);
    await tool("search").invoke({ type: "tool_call", id: "call-1", name: "search", args: { query: "roadmap" } });
    expect(server.calls()[0]!.body.params).toEqual({ name: "search", arguments: { query: "roadmap" } });
  });

  it("keeps parallel calls with different proofs and contexts apart on one connection", async () => {
    // The values differ per call ID: some calls have a proof from an earlier context, some only the current context.
    const resolveInvocation = vi.fn(({ toolCallId }: GatewayMcpCall) => {
      const n = Number(toolCallId!.slice("call-".length));
      return n % 2 ? { toolContextId: `ctx_earlier_${n}`, policyApprovalId: `polapr_${n}` } : { toolContextId: "ctx_current" };
    });
    const { server, tool } = await connect(resolveInvocation);

    await Promise.all(Array.from({ length: 8 }, (_, n) => n % 3
      ? tool("search").invoke({ type: "tool_call", id: `call-${n}`, name: "search", args: { query: `q${n}` } })
      : tool("write_artifact").invoke({ type: "tool_call", id: `call-${n}`, name: "write_artifact",
        args: { name: `q${n}`, toolContextId: "model-context" } })));

    const calls = server.calls();
    expect(calls).toHaveLength(8);
    for (const call of calls) {
      const args = call.body.params!.arguments as { name?: string; query?: string };
      const n = Number((args.query ?? args.name)!.slice(1));
      expect(call.body.params!._meta).toEqual({ [MCP_INVOCATION_META_KEY]: n % 2
        ? { toolContextId: `ctx_earlier_${n}`, policyApprovalId: `polapr_${n}` }
        : { toolContextId: "ctx_current" } });
    }
    // The session has one MCP connection, not one per call.
    expect(server.requests.filter((request) => request.body.method === "initialize")).toHaveLength(1);
  });

  it("does not send approval metadata that the model put in a strict schema's arguments", async () => {
    const { server, tool } = await connect(() => ({ toolContextId: "ctx_trusted" }));

    await expect(tool("search").invoke({ type: "tool_call", id: "call-1", name: "search",
      args: { query: "roadmap", policyApprovalId: "polapr_forged", toolContextId: "ctx_forged" } })).rejects.toThrow();
    expect(server.calls()).toEqual([]);
  });

  it("skips a server that does not answer and loads the others", async () => {
    const healthy = await startLegacyServer();
    const down = await startLegacyServer();
    await down.close();
    const logger = { warn: vi.fn() };
    const client = new GatewayMcpClient({
      servers: [{ id: "down", url: down.url, authorization: "Bearer rt_1" }, { id: "healthy", url: healthy.url, authorization: "Bearer rt_1" }],
      resolveInvocation: () => undefined, logger, sessionId: "session-1"
    });
    cleanups.push(() => client.close(), () => healthy.close());

    const loaded = await client.loadTools();

    expect(loaded.map((toolset) => [toolset.serverId, toolset.tools.map((tool) => tool.name)]))
      .toEqual([["healthy", ["write_artifact", "search"]]]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ serverName: "down", sessionId: "session-1" }),
      "Deep Agents MCP server connection failed; its tools are skipped");
  });
});
