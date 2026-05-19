import { type Pool, withTenantScope } from "../lib/db.js";

import type { AdminMcpServerRecord } from "./admin-config-records.js";
import { mapMcpServer } from "./admin-config-store-mappers.js";

export class McpServerStore {
  constructor(private readonly db: Pool) {}

  async listMcpServers(tenantId: string, includeDisabled = true, isBetaTester = true): Promise<AdminMcpServerRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM admin_mcp_servers
          WHERE ($1::boolean = TRUE OR enabled = TRUE)
            AND ($3::boolean = TRUE OR is_published = TRUE)
            AND tenant_id IN ($2::text, 'system')
          ORDER BY server_name ASC, updated_at DESC
        `,
        [includeDisabled, tenantId, isBetaTester]
      );

      return result.rows.map((row) => mapMcpServer(row));
    });
  }

  async getMcpServer(tenantId: string, serverId: string): Promise<AdminMcpServerRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM admin_mcp_servers
          WHERE server_id = $1
            AND tenant_id IN ($2::text, 'system')
          LIMIT 1
        `,
        [serverId, tenantId]
      );

      return result.rows[0] ? mapMcpServer(result.rows[0]) : null;
    });
  }

  async createMcpServer(tenantId: string, input: {
    serverId: string;
    serverName: string;
    description: string | null;
    transportKind: "http";
    mode: "managed" | "proxy";
    routePath: string;
    upstreamUrl: string | null;
    headersAllowlist: string[];
    configHash: string;
    enabled: boolean;
    createdBy: string;
  }): Promise<AdminMcpServerRecord> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO admin_mcp_servers (
            tenant_id,
            server_id,
            server_name,
            description,
            transport_kind,
            mode,
            route_path,
            upstream_url,
            headers_allowlist,
            version,
            config_hash,
            enabled,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 1, $10, $11, $12)
          RETURNING *
        `,
        [
          tenantId,
          input.serverId,
          input.serverName,
          input.description,
          input.transportKind,
          input.mode,
          input.routePath,
          input.upstreamUrl,
          JSON.stringify(input.headersAllowlist),
          input.configHash,
          input.enabled,
          input.createdBy
        ]
      );

      return mapMcpServer(result.rows[0]);
    });
  }

  async updateMcpServer(tenantId: string, input: {
    serverId: string;
    serverName: string;
    description: string | null;
    transportKind: "http";
    mode: "managed" | "proxy";
    routePath: string;
    upstreamUrl: string | null;
    headersAllowlist: string[];
    configHash: string;
    enabled: boolean;
  }): Promise<AdminMcpServerRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE admin_mcp_servers
          SET
            server_name = $2,
            description = $3,
            transport_kind = $4,
            mode = $5,
            route_path = $6,
            upstream_url = $7,
            headers_allowlist = $8::jsonb,
            config_hash = $9,
            enabled = $10,
            version = version + 1,
            updated_at = NOW()
          WHERE server_id = $1
            AND tenant_id = $11
          RETURNING *
        `,
        [
          input.serverId,
          input.serverName,
          input.description,
          input.transportKind,
          input.mode,
          input.routePath,
          input.upstreamUrl,
          JSON.stringify(input.headersAllowlist),
          input.configHash,
          input.enabled,
          tenantId
        ]
      );

      return result.rows[0] ? mapMcpServer(result.rows[0]) : null;
    });
  }

  async disableMcpServer(tenantId: string, serverId: string): Promise<AdminMcpServerRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE admin_mcp_servers
          SET enabled = FALSE, version = version + 1, updated_at = NOW()
          WHERE server_id = $1
            AND tenant_id = $2
          RETURNING *
        `,
        [serverId, tenantId]
      );

      return result.rows[0] ? mapMcpServer(result.rows[0]) : null;
    });
  }

  async setMcpServerPublished(tenantId: string, serverId: string, isPublished: boolean): Promise<AdminMcpServerRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE admin_mcp_servers
          SET is_published = $3, version = version + 1, updated_at = NOW()
          WHERE server_id = $1
            AND tenant_id = $2
          RETURNING *
        `,
        [serverId, tenantId, isPublished]
      );

      return result.rows[0] ? mapMcpServer(result.rows[0]) : null;
    });
  }
}
