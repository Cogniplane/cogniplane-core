import { withTenantScope, type Pool } from "../../../lib/db.js";
import { isoTimestamp, isoTimestampOrNull } from "../../../lib/db-mappers.js";

export type GithubConnectionRecord = {
  tenantId: string;
  userId: string;
  githubUserId: string;
  githubLogin: string;
  githubName: string | null;
  githubEmail: string | null;
  githubAvatarUrl: string | null;
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

function mapGithubConnection(row: Record<string, unknown>): GithubConnectionRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    githubUserId: String(row.github_user_id),
    githubLogin: String(row.github_login),
    githubName: row.github_name ? String(row.github_name) : null,
    githubEmail: row.github_email ? String(row.github_email) : null,
    githubAvatarUrl: row.github_avatar_url ? String(row.github_avatar_url) : null,
    tokenType: String(row.token_type ?? "bearer"),
    grantedScopes: toStringArray(row.granted_scopes),
    accessTokenEncrypted: String(row.access_token_encrypted),
    accessTokenExpiresAt: isoTimestampOrNull(row.access_token_expires_at),
    refreshTokenEncrypted: row.refresh_token_encrypted ? String(row.refresh_token_encrypted) : null,
    refreshTokenExpiresAt: isoTimestampOrNull(row.refresh_token_expires_at),
    tokenLastRefreshedAt: isoTimestampOrNull(row.github_token_last_refreshed_at),
    tokenLastUsedAt: isoTimestampOrNull(row.github_token_last_used_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

export class GithubConnectionStore {
  constructor(private readonly db: Pool) {}

  async get(tenantId: string, userId: string): Promise<GithubConnectionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM user_github_connections
          WHERE tenant_id = $1 AND user_id = $2
          LIMIT 1
        `,
        [tenantId, userId]
      );

      return result.rows[0] ? mapGithubConnection(result.rows[0]) : null;
    });
  }

  async upsert(input: {
    tenantId: string;
    userId: string;
    githubUserId: string;
    githubLogin: string;
    githubName: string | null;
    githubEmail: string | null;
    githubAvatarUrl: string | null;
    tokenType: string;
    grantedScopes: string[];
    accessTokenEncrypted: string;
    accessTokenExpiresAt: string | null;
    refreshTokenEncrypted: string | null;
    refreshTokenExpiresAt: string | null;
    tokenLastRefreshedAt: string | null;
  }): Promise<GithubConnectionRecord> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO user_github_connections (
            tenant_id,
            user_id,
            github_user_id,
            github_login,
            github_name,
            github_email,
            github_avatar_url,
            token_type,
            granted_scopes,
            access_token_encrypted,
            access_token_expires_at,
            refresh_token_encrypted,
            refresh_token_expires_at,
            github_token_last_refreshed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
          ON CONFLICT (tenant_id, user_id)
          DO UPDATE SET
            github_user_id = EXCLUDED.github_user_id,
            github_login = EXCLUDED.github_login,
            github_name = EXCLUDED.github_name,
            github_email = EXCLUDED.github_email,
            github_avatar_url = EXCLUDED.github_avatar_url,
            token_type = EXCLUDED.token_type,
            granted_scopes = EXCLUDED.granted_scopes,
            access_token_encrypted = EXCLUDED.access_token_encrypted,
            access_token_expires_at = EXCLUDED.access_token_expires_at,
            refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
            refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
            github_token_last_refreshed_at = EXCLUDED.github_token_last_refreshed_at,
            updated_at = NOW()
          RETURNING *
        `,
        [
          input.tenantId,
          input.userId,
          input.githubUserId,
          input.githubLogin,
          input.githubName,
          input.githubEmail,
          input.githubAvatarUrl,
          input.tokenType,
          JSON.stringify(input.grantedScopes),
          input.accessTokenEncrypted,
          input.accessTokenExpiresAt,
          input.refreshTokenEncrypted,
          input.refreshTokenExpiresAt,
          input.tokenLastRefreshedAt
        ]
      );

      return mapGithubConnection(result.rows[0]);
    });
  }

  async delete(tenantId: string, userId: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          DELETE FROM user_github_connections
          WHERE tenant_id = $1 AND user_id = $2
        `,
        [tenantId, userId]
      );

      return (result.rowCount ?? 0) > 0;
    });
  }

  async markTokenUsed(tenantId: string, userId: string): Promise<void> {
    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `
          UPDATE user_github_connections
          SET github_token_last_used_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1 AND user_id = $2
        `,
        [tenantId, userId]
      );
    });
  }
}
