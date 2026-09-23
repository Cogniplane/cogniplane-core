import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { decrypt } from "../lib/crypto-utils.js";
import { McpServerStore } from "../services/mcp-server-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

const ENCRYPTION_SECRET = "integration-mcp-auth-secret-at-least-32-characters";

describe.skipIf(!adminDatabaseUrl())("MCP upstream authentication", () => {
  test("migrates a legacy query credential without exposing it to admin reads", async () => {
    const tenant = await seedTenantGraph();
    const db = superuserPool();
    const serverId = `legacy-auth-${randomUUID()}`;

    await db.query(
      `
        INSERT INTO admin_mcp_servers (
          tenant_id, server_id, server_name, description, transport_kind, mode,
          route_path, upstream_url, version, config_hash, enabled, created_by
        ) VALUES ($1, $2, 'Legacy authenticated proxy', NULL, 'http', 'proxy',
                  $3, $4, 1, 'legacy-hash', TRUE, $5)
      `,
      [
        tenant.tenantId,
        serverId,
        `/mcp/${serverId}`,
        "https://vendor.example/mcp?region=ca&api_key=legacy-secret",
        tenant.userId
      ]
    );

    try {
      const store = new McpServerStore(appPool(), ENCRYPTION_SECRET);
      const listed = (await store.listMcpServers(tenant.tenantId)).find(
        (server) => server.serverId === serverId
      );

      expect(listed).toMatchObject({
        upstreamUrl: "https://vendor.example/mcp?region=ca",
        upstreamAuthType: "query",
        upstreamAuthName: "api_key",
        upstreamAuthConfigured: true
      });
      expect(JSON.stringify(listed)).not.toContain("legacy-secret");

      const persisted = await db.query<{
        upstream_url: string;
        upstream_auth_secret_encrypted: string;
      }>(
        `SELECT upstream_url, upstream_auth_secret_encrypted
         FROM admin_mcp_servers
         WHERE tenant_id = $1 AND server_id = $2`,
        [tenant.tenantId, serverId]
      );
      expect(persisted.rows[0]?.upstream_url).toBe("https://vendor.example/mcp?region=ca");
      expect(persisted.rows[0]?.upstream_auth_secret_encrypted).not.toContain("legacy-secret");
      expect(
        decrypt(persisted.rows[0]!.upstream_auth_secret_encrypted, ENCRYPTION_SECRET)
      ).toBe("legacy-secret");

      const runtime = await store.getMcpServer(tenant.tenantId, serverId);
      expect(runtime?.upstreamAuth).toEqual({
        type: "query",
        name: "api_key",
        secret: "legacy-secret"
      });
    } finally {
      await db.query(
        "DELETE FROM admin_mcp_servers WHERE tenant_id = $1 AND server_id = $2",
        [tenant.tenantId, serverId]
      );
    }
  });
});
