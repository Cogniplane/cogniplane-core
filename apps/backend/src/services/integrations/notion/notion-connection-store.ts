import { withTenantScope, type Pool } from "../../../lib/db.js";
import { isoTimestamp, isoTimestampOrNull } from "../../../lib/db-mappers.js";

export type NotionConnectionRecord = {
  tenantId: string;
  userId: string;
  notionUserId: string;
  notionWorkspaceId: string | null;
  notionWorkspaceName: string | null;
  notionWorkspaceIcon: string | null;
  notionBotId: string | null;
  notionOwnerEmail: string | null;
  notionOwnerName: string | null;
  tokenType: string;
  grantedScopes: string[];
  accessTokenEncrypted: string;
  accessTokenExpiresAt: string | null;
  refreshTokenEncrypted: string | null;
  refreshTokenExpiresAt: string | null;
  tokenLastRefreshedAt: string | null;
  tokenLastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapNotionConnection(row: Record<string, unknown>): NotionConnectionRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    notionUserId: String(row.notion_user_id),
    notionWorkspaceId: nullableString(row.notion_workspace_id),
    notionWorkspaceName: nullableString(row.notion_workspace_name),
    notionWorkspaceIcon: nullableString(row.notion_workspace_icon),
    notionBotId: nullableString(row.notion_bot_id),
    notionOwnerEmail: nullableString(row.notion_owner_email),
    notionOwnerName: nullableString(row.notion_owner_name),
    tokenType: String(row.token_type ?? "bearer"),
    grantedScopes: toStringArray(row.granted_scopes),
    accessTokenEncrypted: String(row.access_token_encrypted),
    accessTokenExpiresAt: isoTimestampOrNull(row.access_token_expires_at),
    refreshTokenEncrypted: row.refresh_token_encrypted ? String(row.refresh_token_encrypted) : null,
    refreshTokenExpiresAt: isoTimestampOrNull(row.refresh_token_expires_at),
    tokenLastRefreshedAt: isoTimestampOrNull(row.notion_token_last_refreshed_at),
    tokenLastUsedAt: isoTimestampOrNull(row.notion_token_last_used_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

export class NotionConnectionStore {
  constructor(private readonly db: Pool) {}

  async get(tenantId: string, userId: string): Promise<NotionConnectionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM user_notion_connections WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
        [tenantId, userId]
      );
      return result.rows[0] ? mapNotionConnection(result.rows[0]) : null;
    });
  }

  async upsert(input: {
    tenantId: string;
    userId: string;
    notionUserId: string;
    notionWorkspaceId: string | null;
    notionWorkspaceName: string | null;
    notionWorkspaceIcon: string | null;
    notionBotId: string | null;
    notionOwnerEmail: string | null;
    notionOwnerName: string | null;
    tokenType: string;
    grantedScopes: string[];
    accessTokenEncrypted: string;
    accessTokenExpiresAt: string | null;
    refreshTokenEncrypted: string | null;
    refreshTokenExpiresAt: string | null;
    tokenLastRefreshedAt: string | null;
  }): Promise<NotionConnectionRecord> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO user_notion_connections (
            tenant_id, user_id, notion_user_id, notion_workspace_id, notion_workspace_name,
            notion_workspace_icon, notion_bot_id, notion_owner_email, notion_owner_name,
            token_type, granted_scopes, access_token_encrypted,
            access_token_expires_at, refresh_token_encrypted, refresh_token_expires_at,
            notion_token_last_refreshed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16)
          ON CONFLICT (tenant_id, user_id)
          DO UPDATE SET
            notion_user_id = EXCLUDED.notion_user_id,
            notion_workspace_id = EXCLUDED.notion_workspace_id,
            notion_workspace_name = EXCLUDED.notion_workspace_name,
            notion_workspace_icon = EXCLUDED.notion_workspace_icon,
            notion_bot_id = EXCLUDED.notion_bot_id,
            notion_owner_email = EXCLUDED.notion_owner_email,
            notion_owner_name = EXCLUDED.notion_owner_name,
            token_type = EXCLUDED.token_type,
            granted_scopes = EXCLUDED.granted_scopes,
            access_token_encrypted = EXCLUDED.access_token_encrypted,
            access_token_expires_at = EXCLUDED.access_token_expires_at,
            refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
            refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
            notion_token_last_refreshed_at = EXCLUDED.notion_token_last_refreshed_at,
            updated_at = NOW()
          RETURNING *`,
        [
          input.tenantId,
          input.userId,
          input.notionUserId,
          input.notionWorkspaceId,
          input.notionWorkspaceName,
          input.notionWorkspaceIcon,
          input.notionBotId,
          input.notionOwnerEmail,
          input.notionOwnerName,
          input.tokenType,
          JSON.stringify(input.grantedScopes),
          input.accessTokenEncrypted,
          input.accessTokenExpiresAt,
          input.refreshTokenEncrypted,
          input.refreshTokenExpiresAt,
          input.tokenLastRefreshedAt
        ]
      );
      return mapNotionConnection(result.rows[0]);
    });
  }

  async delete(tenantId: string, userId: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM user_notion_connections WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async markTokenUsed(tenantId: string, userId: string): Promise<void> {
    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `UPDATE user_notion_connections
         SET notion_token_last_used_at = NOW(), updated_at = NOW()
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
    });
  }
}
