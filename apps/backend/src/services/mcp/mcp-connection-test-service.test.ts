import { expect, test, vi } from "vitest";
import type { AdminMcpServerRecord } from "../admin-config-records.js";
import { rpcFailure, rpcOk, type McpRpcResponse } from "../../lib/mcp-upstream-client.js";
import {
  McpConnectionTestConflictError,
  McpConnectionTestService
} from "./mcp-connection-test-service.js";

const hash = "a".repeat(64);
const server: AdminMcpServerRecord = {
  serverId: "docs", ownerTenantId: "tenant", serverName: "Docs", description: null,
  transportKind: "http", mode: "proxy", routePath: "/mcp/docs",
  upstreamUrl: "https://vendor.example/mcp", upstreamAuthType: "none",
  upstreamAuthName: null, upstreamAuthConfigured: false, credentialScope: "organization",
  credentialBindingId: "binding", version: 2, configHash: hash, enabled: true,
  isPublished: true, createdBy: "admin", createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
const tool = { name: "search", inputSchema: { type: "object" } };

function makeService(options: {
  saved?: AdminMcpServerRecord;
  runtime?: AdminMcpServerRecord;
  responses?: McpRpcResponse[];
  diagnostics?: Array<{ kind: "http"; status: number } | { kind: "transport" }>;
} = {}) {
  const saved = options.saved ?? server;
  const runtime = options.runtime ?? saved;
  const forward = vi.fn(async (_url, request, _headers, _fetch, limits) => {
    const diagnostic = options.diagnostics?.shift();
    if (diagnostic) limits.onDiagnostic?.(diagnostic);
    return options.responses?.shift() ?? rpcOk(request.id, { tools: [tool] });
  });
  const servers = {
    getAdminMcpServer: vi.fn(async () => saved),
    getMcpServer: vi.fn(async () => ({ ...runtime, upstreamAuth: null }))
  };
  const credentials = {
    getStatus: vi.fn(async () => ({ credentialVersion: 0 })),
    getRuntimeCredential: vi.fn(async () => null)
  };
  const service = new McpConnectionTestService({
    db: {} as never, servers: servers as never, credentials: credentials as never,
    timeoutMs: 8_000,
    forward: forward as never
  });
  Object.defineProperty(service, "persist", {
    value: async (...args: unknown[]) => args[5]
  });
  return { service, forward, servers, credentials };
}

test("rejects a changed runtime destination before forwarding credentials", async () => {
  const { service, forward } = makeService({ runtime: { ...server, upstreamUrl: "https://other.example/mcp", configHash: "b".repeat(64) } });
  await expect(service.test("tenant", "admin", "docs", {
    expectedVersion: 2, expectedConfigHash: hash
  })).rejects.toBeInstanceOf(McpConnectionTestConflictError);
  expect(forward).not.toHaveBeenCalled();
});

test("rejects a stale expected hash even when the version matches", async () => {
  const { service, forward } = makeService();
  await expect(service.test("tenant", "admin", "docs", {
    expectedVersion: 2, expectedConfigHash: "b".repeat(64)
  })).rejects.toBeInstanceOf(McpConnectionTestConflictError);
  expect(forward).not.toHaveBeenCalled();
});

test("only lists tools, follows bounded pages, and does not expose names", async () => {
  const { service, forward } = makeService({ responses: [
    rpcOk("admin-connection-test:0", { tools: [tool], nextCursor: "next" }),
    rpcOk("admin-connection-test:1", { tools: [{ name: "other", inputSchema: { type: "object" } }] })
  ] });
  const result = await service.test("tenant", "admin", "docs", {
    expectedVersion: 2, expectedConfigHash: hash
  });
  expect(result).toMatchObject({ reachability: "reachable", authentication: "not_required",
    toolDiscovery: "succeeded", toolCount: 2, configHash: hash });
  expect(JSON.stringify(result)).not.toContain("search");
  expect(forward.mock.calls.map(call => call[1].method)).toEqual(["tools/list", "tools/list"]);
});

test("reports HTTP authentication rejection without calling it a bad credential", async () => {
  const { service } = makeService({ responses: [rpcFailure("admin-connection-test:0", -32000, "secret provider error")],
    diagnostics: [{ kind: "http", status: 401 }] });
  const result = await service.test("tenant", "admin", "docs", {
    expectedVersion: 2, expectedConfigHash: hash
  });
  expect(result).toMatchObject({ reachability: "reachable", authentication: "indeterminate",
    toolDiscovery: "failed" });
  expect(result.message).toContain("test identity");
  expect(JSON.stringify(result)).not.toContain("secret provider error");
});

test("rejects malformed tool metadata and reports no tool count for managed servers", async () => {
  const proxy = makeService({ responses: [rpcOk("admin-connection-test:0", { tools: [{ name: "bad" }] })] });
  const invalid = await proxy.service.test("tenant", "admin", "docs", {
    expectedVersion: 2, expectedConfigHash: hash
  });
  expect(invalid).toMatchObject({ toolDiscovery: "failed", toolCount: null });

  const managed = makeService({ saved: { ...server, mode: "managed" } });
  const result = await managed.service.test("tenant", "admin", "docs", {
    expectedVersion: 2, expectedConfigHash: hash
  });
  expect(result).toMatchObject({ reachability: "unknown", authentication: "indeterminate",
    toolDiscovery: "succeeded", toolCount: null });
  expect(result.message).toContain("Local managed tools");
  expect(managed.forward).not.toHaveBeenCalled();
});
