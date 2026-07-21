import { expect, test } from "vitest";

import { FakePool } from "../test-helpers/fake-pool.js";

import { AdminConfigError } from "./admin-config-error.js";
import { McpServerStore } from "./mcp-server-store.js";

test("McpServerStore lists one tenant-preferred row per server ID", async () => {
  const pool = new FakePool().onQuery("FROM admin_mcp_servers", (text) => {
    expect(text).toContain("SELECT DISTINCT ON (server_id)");
    expect(text).toContain("(tenant_id = $2::text) DESC");
    return { rows: [], rowCount: 0 };
  });

  await expect(new McpServerStore(pool.asPool()).listMcpServers("tenant-1")).resolves.toEqual([]);
});

test("McpServerStore rejects tenant servers that reuse a system server ID", async () => {
  const pool = new FakePool().onQuery("FROM admin_mcp_servers", () => ({
    rows: [{ exists: 1 }],
    rowCount: 1
  }));
  const store = new McpServerStore(pool.asPool());

  await expect(
    store.createMcpServer("tenant-1", {
      serverId: "managed-session-context",
      serverName: "Custom context",
      description: null,
      transportKind: "http",
      mode: "managed",
      routePath: "/mcp/custom-context",
      upstreamUrl: null,
      headersAllowlist: [],
      configHash: "hash",
      enabled: true,
      createdBy: "admin"
    })
  ).rejects.toThrow(AdminConfigError);

  expect(pool.queries.some((query) => query.text.includes("INSERT INTO admin_mcp_servers"))).toBe(false);
});
