import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import { McpServerStore } from "../services/mcp-server-store.js";
import { TenantSettingsStore } from "../services/tenant-settings-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

const deferredSql = new URL("../../db/deferred/retire-inert-settings-columns.sql", import.meta.url);
const exampleSql = new URL("../../db/migrations/012_remove_unconfigured_echo_example.sql", import.meta.url);

describe.skipIf(!adminDatabaseUrl())("settings schema retirement", () => {
  test("current stores write successfully after the deferred column drop", async () => {
    const tenant = await seedTenantGraph();
    const db = superuserPool();
    await db.query(await readFile(deferredSql, "utf8"));
    try {
      const settings = new TenantSettingsStore(appPool());
      await settings.upsert(tenant.tenantId, { developerInstructions: "First" });
      const updated = await settings.upsert(tenant.tenantId, { developerInstructions: "Second" });
      expect(updated.developerInstructions).toBe("Second");

      const servers = new McpServerStore(appPool());
      const input = {
        serverId: "retirement-example", serverName: "Example", description: null,
        transportKind: "http" as const, mode: "proxy" as const,
        routePath: "/mcp/retirement-example", upstreamUrl: "https://example.com/mcp",
        configHash: "first", enabled: false, createdBy: tenant.userId
      };
      await servers.createMcpServer(tenant.tenantId, input);
      const server = await servers.updateMcpServer(tenant.tenantId, {
        ...input, serverName: "Renamed", configHash: "second"
      });
      expect(server?.serverName).toBe("Renamed");
    } finally {
      // Other files share this throwaway database, so restore compatibility.
      await db.query(`
        ALTER TABLE admin_mcp_servers ADD COLUMN IF NOT EXISTS headers_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS allow_user_token_forwarding boolean NOT NULL DEFAULT true;
      `);
    }
  });

  test("example cleanup preserves configured and tenant-owned resources", async () => {
    const tenant = await seedTenantGraph();
    const db = superuserPool();
    const cleanup = await readFile(exampleSql, "utf8");
    const insertExample = async (tenantId: string, upstreamUrl: string | null) => {
      await db.query(`
        INSERT INTO admin_mcp_servers (
          tenant_id, server_id, server_name, description, transport_kind, mode,
          route_path, upstream_url, headers_allowlist, version, config_hash, enabled, created_by
        ) VALUES (
          $1, 'trusted-echo', 'Trusted echo',
          'Forward validated framework context to a trusted upstream MCP server.',
          'http', 'proxy', '/mcp/trusted-echo', $2,
          '["X-Framework-User-Id","X-Framework-Session-Id","X-Framework-Runtime-Id"]'::jsonb,
          1, md5('trusted-echo:v1'), FALSE, 'system'
        )`, [tenantId, upstreamUrl]);
    };
    const exists = async (tenantId: string) => {
      const result = await db.query("SELECT 1 FROM admin_mcp_servers WHERE tenant_id = $1 AND server_id = 'trusted-echo'", [tenantId]);
      return result.rows.length > 0;
    };

    await insertExample("system", null);
    await insertExample(tenant.tenantId, null);
    await db.query(cleanup);
    expect(await exists("system")).toBe(false);
    expect(await exists(tenant.tenantId)).toBe(true);

    await insertExample("system", "https://example.com/configured");
    await db.query(cleanup);
    expect(await exists("system")).toBe(true);
    await db.query("DELETE FROM admin_mcp_servers WHERE server_id = 'trusted-echo' AND tenant_id = ANY($1)", [["system", tenant.tenantId]]);
  });
});
