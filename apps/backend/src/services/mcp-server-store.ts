import { randomUUID } from "node:crypto";
import { type Pool, withTenantScope } from "../lib/db.js";
import type { PoolClient } from "pg";
import { computeConfigHash, decrypt, encrypt } from "../lib/crypto-utils.js";
import type { McpUpstreamAuth } from "../lib/mcp-upstream-client.js";
import { isCredentialQueryParameterName } from "../lib/sensitive-query-params.js";

import { AdminConfigError } from "./admin-config-error.js";
import { validateMcpServerInput } from "./dynamic-config-mutation-service.js";
import type {
  AdminMcpServerRecord,
  RuntimeMcpServerRecord
} from "./admin-config-records.js";
import { mapMcpServer } from "./admin-config-store-mappers.js";
import { MemberMcpCredentialStore } from "./member-mcp-credential-store.js";

type UpstreamAuthType = AdminMcpServerRecord["upstreamAuthType"];

function computeMcpServerConfigHash(input: {
  serverId: string;
  serverName: string;
  description: string | null;
  transportKind: "http";
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string | null;
  upstreamAuthType: UpstreamAuthType;
  upstreamAuthName: string | null;
  upstreamAuthConfigured: boolean;
  credentialScope: "organization" | "personal";
  credentialBindingId: string;
}): string {
  return computeConfigHash(input);
}

function extractLegacyQueryAuth(upstreamUrl: string): {
  cleanUrl: string;
  name: string;
  secret: string;
} | null {
  const url = new URL(upstreamUrl);
  const credentials = [...url.searchParams.entries()].filter(([name, value]) =>
    isCredentialQueryParameterName(name) && value.length > 0
  );
  if (credentials.length === 0) return null;
  if (credentials.length > 1) {
    throw new AdminConfigError(
      "The MCP upstream URL contains multiple credential-like query parameters. " +
        "Move them to the encrypted upstream authentication fields before using this server."
    );
  }

  const [name, secret] = credentials[0]!;
  url.searchParams.delete(name);
  return { cleanUrl: url.toString(), name, secret };
}

export function pendingLegacyQueryAuth(server: Pick<AdminMcpServerRecord,
  "upstreamAuthType" | "upstreamAuthConfigured" | "upstreamUrl">) {
  if (server.upstreamAuthType !== "none" || server.upstreamAuthConfigured || !server.upstreamUrl) return null;
  return extractLegacyQueryAuth(server.upstreamUrl);
}

export class McpServerStore {
  constructor(
    private readonly db: Pool,
    private readonly encryptionSecret: string
  ) {}

  withTransaction<T>(tenantId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTenantScope(this.db, tenantId, run);
  }

  private async migrateLegacyQueryAuth(
    client: { query: Pool["query"] },
    row: Record<string, unknown>,
    requestTenantId: string
  ): Promise<Record<string, unknown>> {
    const legacy = pendingLegacyQueryAuth({
      upstreamAuthType: String(row.upstream_auth_type ?? "none") as UpstreamAuthType,
      upstreamAuthConfigured: Boolean(row.upstream_auth_secret_encrypted),
      upstreamUrl: row.upstream_url ? String(row.upstream_url) : null
    });
    if (!legacy) return row;

    const encryptedSecret = encrypt(legacy.secret, this.encryptionSecret);
    const credentialBindingId = String(row.tenant_id) === requestTenantId
      ? randomUUID()
      : String(row.credential_binding_id ?? "00000000-0000-4000-8000-000000000000");
    const configHash = computeMcpServerConfigHash({
      serverId: String(row.server_id), serverName: String(row.server_name),
      description: row.description ? String(row.description) : null, transportKind: "http",
      mode: String(row.mode) as "managed" | "proxy", routePath: String(row.route_path),
      upstreamUrl: legacy.cleanUrl, upstreamAuthType: "query", upstreamAuthName: legacy.name,
      upstreamAuthConfigured: true, credentialScope: "organization", credentialBindingId
    });
    if (String(row.tenant_id) !== requestTenantId) {
      // Inherited system rows are readable but deliberately not writable under
      // a tenant's RLS scope. Keep them usable and keep the secret out of the
      // tenant API; a system-scoped read will persist the migration later.
      return {
        ...row,
        upstream_url: legacy.cleanUrl,
        upstream_auth_type: "query",
        upstream_auth_name: legacy.name,
        upstream_auth_secret_encrypted: encryptedSecret,
        credential_binding_id: credentialBindingId,
        config_hash: configHash
      };
    }

    const result = await client.query(
      `
        UPDATE admin_mcp_servers
        SET upstream_url = $3,
            upstream_auth_type = 'query',
            upstream_auth_name = $4,
            upstream_auth_secret_encrypted = $5,
            credential_binding_id = $7,
            config_hash = $8
        WHERE tenant_id = $1
          AND server_id = $2
          AND upstream_url = $6
          AND upstream_auth_type = 'none'
          AND upstream_auth_secret_encrypted IS NULL
        RETURNING *
      `,
      [
        String(row.tenant_id),
        String(row.server_id),
        legacy.cleanUrl,
        legacy.name,
        encryptedSecret,
        String(row.upstream_url),
        credentialBindingId,
        configHash
      ]
    );

    if (result.rows[0]) return result.rows[0];
    const refreshed = await client.query(
      `SELECT * FROM admin_mcp_servers WHERE tenant_id = $1 AND server_id = $2 LIMIT 1`,
      [String(row.tenant_id), String(row.server_id)]
    );
    return refreshed.rows[0] ?? row;
  }

  private runtimeRecord(row: Record<string, unknown>): RuntimeMcpServerRecord {
    const record = mapMcpServer(row);
    if (record.credentialScope === "personal") return { ...record, upstreamAuth: null };
    const encrypted = row.upstream_auth_secret_encrypted
      ? String(row.upstream_auth_secret_encrypted)
      : null;
    let upstreamAuth: McpUpstreamAuth | null = null;
    if (record.upstreamAuthType === "bearer" && encrypted) {
      upstreamAuth = { type: "bearer", secret: decrypt(encrypted, this.encryptionSecret) };
    } else if (
      (record.upstreamAuthType === "header" || record.upstreamAuthType === "query") &&
      record.upstreamAuthName &&
      encrypted
    ) {
      upstreamAuth = {
        type: record.upstreamAuthType,
        name: record.upstreamAuthName,
        secret: decrypt(encrypted, this.encryptionSecret)
      };
    }
    return { ...record, upstreamAuth };
  }

  async listMcpServers(tenantId: string, includeDisabled = true, isBetaTester = true,
    options: { migrateLegacyAuth?: boolean } = {}): Promise<AdminMcpServerRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM (
            SELECT DISTINCT ON (server_id) *
            FROM admin_mcp_servers
            WHERE ($1::boolean = TRUE OR enabled = TRUE)
              AND ($3::boolean = TRUE OR is_published = TRUE)
              AND tenant_id IN ($2::text, 'system')
            ORDER BY server_id, (tenant_id = $2::text) DESC, updated_at DESC
          ) AS visible_servers
          ORDER BY server_name ASC, updated_at DESC
        `,
        [includeDisabled, tenantId, isBetaTester]
      );

      const rows = options.migrateLegacyAuth === false ? result.rows : await Promise.all(
        result.rows.map((row) => this.migrateLegacyQueryAuth(client, row, tenantId))
      );
      return rows.map((row) => mapMcpServer(row));
    });
  }

  async getMcpServer(tenantId: string, serverId: string, transactionClient?: PoolClient): Promise<RuntimeMcpServerRecord | null> {
    const get = async (client: PoolClient) => {
      const result = await client.query(
        `
          SELECT *
          FROM admin_mcp_servers
          WHERE server_id = $1
            AND tenant_id IN ($2::text, 'system')
          ORDER BY (tenant_id = $2::text) DESC
          LIMIT 1
        `,
        [serverId, tenantId]
      );

      if (!result.rows[0]) return null;
      const row = await this.migrateLegacyQueryAuth(client, result.rows[0], tenantId);
      return this.runtimeRecord(row);
    };
    return transactionClient ? get(transactionClient) : withTenantScope(this.db, tenantId, get);
  }

  async getAdminMcpServer(tenantId: string, serverId: string, transactionClient?: PoolClient): Promise<AdminMcpServerRecord | null> {
    const get = async (client: PoolClient) => {
      const result = await client.query(
        `SELECT * FROM admin_mcp_servers
         WHERE server_id = $1 AND tenant_id IN ($2::text, 'system')
         ORDER BY (tenant_id = $2::text) DESC LIMIT 1`,
        [serverId, tenantId]
      );
      if (!result.rows[0]) return null;
      const row = await this.migrateLegacyQueryAuth(client, result.rows[0], tenantId);
      return mapMcpServer(row);
    };
    return transactionClient ? get(transactionClient) : withTenantScope(this.db, tenantId, get);
  }

  async createMcpServer(tenantId: string, input: {
    serverId: string;
    serverName: string;
    description: string | null;
    transportKind: "http";
    mode: "managed" | "proxy";
    routePath: string;
    upstreamUrl: string | null;
    upstreamAuthType: UpstreamAuthType;
    upstreamAuthName: string | null;
    upstreamAuthSecret: string | null;
    credentialScope?: "organization" | "personal";
    enabled: boolean;
    createdBy: string;
  }, transactionClient?: PoolClient): Promise<AdminMcpServerRecord> {
    if (input.mode === "managed" && input.upstreamUrl) {
      throw new AdminConfigError("Managed MCP servers cannot configure an upstreamUrl.");
    }
    const credentialScope = input.credentialScope ?? "organization";
    if (credentialScope === "personal" &&
      (input.mode !== "proxy" || input.upstreamAuthType === "none" || input.upstreamAuthSecret != null)) {
      throw new AdminConfigError("Personal credentials require an authenticated proxy and no shared secret.");
    }
    if (credentialScope === "organization" && input.upstreamAuthType !== "none" && !input.upstreamAuthSecret) {
      throw new AdminConfigError("Organization authentication requires a shared secret.");
    }
    const create = async (client: PoolClient) => {
      if (tenantId !== "system") {
        const systemServer = await client.query(
          `
            SELECT 1
            FROM admin_mcp_servers
            WHERE server_id = $1
              AND tenant_id = 'system'
            LIMIT 1
          `,
          [input.serverId]
        );

        if (systemServer.rows[0]) {
          throw new AdminConfigError(
            `MCP server "${input.serverId}" is system-provided and cannot be created. ` +
              "Create a server with a different ID to customize it."
          );
        }
      }

      const credentialBindingId = randomUUID();
      const configHash = computeMcpServerConfigHash({
        serverId: input.serverId,
        serverName: input.serverName,
        description: input.description,
        transportKind: input.transportKind,
        mode: input.mode,
        routePath: input.routePath,
        upstreamUrl: input.upstreamUrl,
        upstreamAuthType: input.upstreamAuthType,
        upstreamAuthName: input.upstreamAuthName,
        upstreamAuthConfigured: Boolean(input.upstreamAuthSecret),
        credentialScope,
        credentialBindingId
      });
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
            upstream_auth_type,
            upstream_auth_name,
            upstream_auth_secret_encrypted,
            version,
            config_hash,
            enabled,
            created_by,
            credential_scope,
            credential_binding_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12, $13, $14, $15, $16)
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
          input.upstreamAuthType,
          input.upstreamAuthName,
          input.upstreamAuthSecret
            ? encrypt(input.upstreamAuthSecret, this.encryptionSecret)
            : null,
          configHash,
          input.enabled,
          input.createdBy,
          credentialScope,
          credentialBindingId
        ]
      );

      return mapMcpServer(result.rows[0]);
    };
    return transactionClient ? create(transactionClient) : withTenantScope(this.db, tenantId, create);
  }

  async updateMcpServer(tenantId: string, input: {
    serverId: string;
    serverName: string;
    description: string | null;
    transportKind: "http";
    mode: "managed" | "proxy";
    routePath: string;
    upstreamUrl?: string | null;
    upstreamAuthType?: UpstreamAuthType;
    upstreamAuthName?: string | null;
    upstreamAuthSecret?: string | null;
    credentialScope?: "organization" | "personal";
    enabled: boolean;
  }, transactionClient?: PoolClient): Promise<AdminMcpServerRecord | null> {
    if (input.mode === "managed" && input.upstreamUrl) {
      throw new AdminConfigError("Managed MCP servers cannot configure an upstreamUrl.");
    }
    const update = async (client: PoolClient) => {
      const existing = await client.query(
        `SELECT upstream_url, upstream_auth_type, upstream_auth_name,
                upstream_auth_secret_encrypted, credential_scope, credential_binding_id
         FROM admin_mcp_servers
         WHERE server_id = $1 AND tenant_id = $2
         LIMIT 1
         FOR UPDATE`,
        [input.serverId, tenantId]
      );
      if (!existing.rows[0]) return null;

      const upstreamUrl = input.mode === "managed"
        ? null
        : input.upstreamUrl === undefined
          ? (existing.rows[0].upstream_url ? String(existing.rows[0].upstream_url) : null)
          : input.upstreamUrl;
      const existingAuthType = String(existing.rows[0].upstream_auth_type) as UpstreamAuthType;
      const existingScope = existing.rows[0].credential_scope === "personal" ? "personal" : "organization";
      const credentialScope = input.credentialScope ?? existingScope;
      const upstreamAuthType = input.mode === "managed"
        ? "none"
        : input.upstreamAuthType ?? existingAuthType;
      const upstreamAuthName = upstreamAuthType === "none" || upstreamAuthType === "bearer"
        ? null
        : input.upstreamAuthName === undefined
          ? upstreamAuthType === existingAuthType && existing.rows[0].upstream_auth_name
            ? String(existing.rows[0].upstream_auth_name)
            : null
          : input.upstreamAuthName;
      if (credentialScope === "personal" && input.upstreamAuthSecret != null) {
        throw new AdminConfigError("Personal MCP connections cannot store a shared secret.");
      }
      if (credentialScope === "personal" && (input.mode !== "proxy" || upstreamAuthType === "none")) {
        throw new AdminConfigError("Personal credentials require an authenticated proxy.");
      }
      const encryptedSecret = upstreamAuthType === "none" || credentialScope === "personal"
        ? null
        : input.upstreamAuthSecret
          ? encrypt(input.upstreamAuthSecret, this.encryptionSecret)
          : existingScope === "organization" && existing.rows[0].upstream_auth_secret_encrypted
            ? String(existing.rows[0].upstream_auth_secret_encrypted)
            : null;
      // A partial update is validated before this merge, with the omitted
      // fields unknown. Validate the merged state as well, so an update that
      // changes only the header name cannot store a reserved or invalid header.
      validateMcpServerInput({
        mode: input.mode,
        routePath: input.routePath,
        upstreamUrl,
        upstreamAuthType,
        upstreamAuthName,
        upstreamAuthSecret: input.upstreamAuthSecret,
        credentialScope
      }, { requireUrlAndSecret: false });
      if (input.mode === "proxy" && !upstreamUrl) {
        throw new AdminConfigError("Proxy MCP servers require an upstreamUrl.");
      }
      if (credentialScope === "organization" && upstreamAuthType !== "none" && !encryptedSecret) {
        throw new AdminConfigError(
          "Proxy MCP upstream authentication requires a secret when first configured."
        );
      }
      if (
        (upstreamAuthType === "header" || upstreamAuthType === "query") &&
        !upstreamAuthName
      ) {
        throw new AdminConfigError(
          `${upstreamAuthType} authentication requires upstreamAuthName.`
        );
      }
      const credentialBindingId = upstreamUrl !== existing.rows[0].upstream_url ||
        upstreamAuthType !== existingAuthType || upstreamAuthName !== (existing.rows[0].upstream_auth_name ?? null) ||
        credentialScope !== existingScope || Boolean(input.upstreamAuthSecret)
        ? randomUUID() : String(existing.rows[0].credential_binding_id ?? randomUUID());
      const configHash = computeMcpServerConfigHash({
        serverId: input.serverId,
        serverName: input.serverName,
        description: input.description,
        transportKind: input.transportKind,
        mode: input.mode,
        routePath: input.routePath,
        upstreamUrl,
        upstreamAuthType,
        upstreamAuthName,
        upstreamAuthConfigured: Boolean(encryptedSecret),
        credentialScope,
        credentialBindingId
      });

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
            upstream_auth_type = $8,
            upstream_auth_name = $9,
            upstream_auth_secret_encrypted = $10,
            config_hash = $11,
            enabled = $12,
            version = version + 1,
            updated_at = NOW(),
            credential_scope = $14,
            credential_binding_id = $15
          WHERE server_id = $1
            AND tenant_id = $13
          RETURNING *
        `,
        [
          input.serverId,
          input.serverName,
          input.description,
          input.transportKind,
          input.mode,
          input.routePath,
          upstreamUrl,
          upstreamAuthType,
          upstreamAuthName,
          encryptedSecret,
          configHash,
          input.enabled,
          tenantId,
          credentialScope,
          credentialBindingId
        ]
      );
      if (result.rows[0] && credentialBindingId !== existing.rows[0].credential_binding_id) {
        await MemberMcpCredentialStore.revokeForServer(client, tenantId, input.serverId);
      }

      return result.rows[0] ? mapMcpServer(result.rows[0]) : null;
    };
    return transactionClient ? update(transactionClient) : withTenantScope(this.db, tenantId, update);
  }

  async disableMcpServer(tenantId: string, serverId: string, transactionClient?: PoolClient): Promise<AdminMcpServerRecord | null> {
    const disable = async (client: PoolClient) => {
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
    };
    return transactionClient ? disable(transactionClient) : withTenantScope(this.db, tenantId, disable);
  }

  async setMcpServerPublished(tenantId: string, serverId: string, isPublished: boolean, transactionClient?: PoolClient): Promise<AdminMcpServerRecord | null> {
    const publish = async (client: PoolClient) => {
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
    };
    return transactionClient ? publish(transactionClient) : withTenantScope(this.db, tenantId, publish);
  }
}
