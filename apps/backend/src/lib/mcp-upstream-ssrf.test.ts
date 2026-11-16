import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { describe, expect, test, vi } from "vitest";
import type { fetch as undiciFetch } from "undici";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import { forwardRpc } from "./mcp-upstream-client.js";
import { mcpUpstreamUrlSchemaForPolicy, ssrfSafeAgent } from "./url-validation.js";
import { proxyUpstreamLimits } from "../services/mcp/proxy-forward.js";
import { createTestConfig } from "../test-helpers/test-config.js";

const payload = { jsonrpc: "2.0" as const, id: 1, method: "tools/list" };

describe("MCP upstream address policy", () => {
  test.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.2.3", "169.254.169.254",
    "100.64.0.1", "192.0.2.1", "224.0.0.1", "0.0.0.0", "localhost", "localhost.",
    "[::1]", "[fc00::1]", "[fe80::1]", "[fec0::1]", "[ff02::1]", "[100::1]",
    "[::ffff:127.0.0.1]", "0x7f000001", "2130706433"
  ])("refuses %s at admission and before a request", async (host) => {
    const url = `http://${host}/mcp`;
    expect(mcpUpstreamUrlSchemaForPolicy().safeParse(url).success).toBe(false);
    expect(mcpUpstreamUrlSchemaForPolicy(true).safeParse(url).success).toBe(true);
    const request = vi.fn();
    const response = await forwardRpc(url, payload, {}, request as never);
    expect(response.error?.message).toBe("Upstream MCP destination is not permitted.");
    expect(request).not.toHaveBeenCalled();
  });

  test("passes the safe dispatcher on every same-origin redirect", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/next" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })));
    const response = await forwardRpc("https://public.example/mcp", payload, {}, request as never);
    expect(response.result).toEqual({ tools: [] });
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, init] of request.mock.calls) expect(init.dispatcher).toBe(ssrfSafeAgent);
  });

  test.each([
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "fc00::1", family: 6 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]
  ])("refuses private DNS answers before the HTTP request", async (...records) => {
    let requests = 0;
    const server = createServer((_request, reply) => {
      requests += 1;
      reply.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { reached: true } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      const url = `http://rebind.example:${address.port}/mcp`;
      expect(mcpUpstreamUrlSchemaForPolicy().safeParse(url).success).toBe(true);
      vi.mocked(lookup).mockResolvedValue(records as never);
      const response = await forwardRpc(url, payload, {});
      expect(response.error?.message).toBe("Upstream MCP request failed.");
      expect(lookup).toHaveBeenCalledWith("rebind.example", { all: true, verbatim: true });
      expect(requests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("passes the operator opt-in to forwarding limits", async () => {
    const request = vi.fn(async (_url: unknown, _init: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })));
    const limits = proxyUpstreamLimits(createTestConfig({ MCP_UPSTREAM_ALLOW_PRIVATE_ADDRESSES: true }), undefined);
    const response = await forwardRpc("http://localhost/mcp", payload, {}, request as never, limits);
    expect(response.result).toEqual({ tools: [] });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("dispatcher");
    expect(proxyUpstreamLimits(createTestConfig(), undefined).allowPrivateAddresses).toBe(false);
  });

  test("refuses Node's global fetch in public-only mode", async () => {
    const response = await forwardRpc("http://public.example/mcp", payload, {}, globalThis.fetch as unknown as typeof undiciFetch);
    expect(response.error?.message).toBe("Upstream MCP request failed.");
  });
});
