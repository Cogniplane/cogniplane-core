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
  // Repositories the agent may use, lower case. Empty means none.
  allowedRepositories: string[];
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
    allowedRepositories: toStringArray(row.allowed_repositories),
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

export type SetAllowedRepositoriesResult =
  | { status: "not_connected" }
  | { status: "account_changed" }
  | { status: "updated"; previous: string[]; record: GithubConnectionRecord };

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
            -- The same account keeps its selection. Another account starts
            -- with none, because the chosen repositories belonged to the
            -- previous account.
            allowed_repositories = CASE
              WHEN user_github_connections.github_user_id = EXCLUDED.github_user_id
                THEN user_github_connections.allowed_repositories
              ELSE '{}'::text[]
            END,
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

  /**
   * Store refreshed tokens only on the connection that the refresh started
   * from. Returns null when a disconnect or reconnect happened meanwhile, so
   * a slow refresh cannot recreate or overwrite that connection.
   */
  async updateRefreshedToken(input: {
    tenantId: string;
    userId: string;
    expectedGithubUserId: string;
    expectedRefreshTokenEncrypted: string;
    tokenType: string;
    grantedScopes: string[];
    accessTokenEncrypted: string;
    accessTokenExpiresAt: string | null;
    refreshTokenEncrypted: string | null;
    refreshTokenExpiresAt: string | null;
  }): Promise<GithubConnectionRecord | null> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE user_github_connections
          SET token_type = $5,
              granted_scopes = $6::jsonb,
              access_token_encrypted = $7,
              access_token_expires_at = $8,
              refresh_token_encrypted = $9,
              refresh_token_expires_at = $10,
              github_token_last_refreshed_at = NOW(),
              updated_at = NOW()
          WHERE tenant_id = $1 AND user_id = $2
            AND github_user_id = $3 AND refresh_token_encrypted = $4
          RETURNING *
        `,
        [
          input.tenantId,
          input.userId,
          input.expectedGithubUserId,
          input.expectedRefreshTokenEncrypted,
          input.tokenType,
          JSON.stringify(input.grantedScopes),
          input.accessTokenEncrypted,
          input.accessTokenExpiresAt,
          input.refreshTokenEncrypted,
          input.refreshTokenExpiresAt
        ]
      );

      return result.rows[0] ? mapGithubConnection(result.rows[0]) : null;
    });
  }

  /**
   * Replace the repositories that the agent may use. The caller passes a list
   * that it already normalized, and the GitHub user id that the member chose
   * the list for. The check runs under the row lock, so a reconnect to another
   * account between the page load and the save cannot receive the list.
   * Returns the previous list for the audit event.
   */
  async setAllowedRepositories(
    tenantId: string,
    userId: string,
    repositories: readonly string[],
    expectedGithubUserId: string
  ): Promise<SetAllowedRepositoriesResult> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const current = await client.query(
        `
          SELECT github_user_id, allowed_repositories
          FROM user_github_connections
          WHERE tenant_id = $1 AND user_id = $2
          FOR UPDATE
        `,
        [tenantId, userId]
      );
      const row = current.rows[0];
      if (!row) return { status: "not_connected" } as const;
      if (String(row.github_user_id) !== expectedGithubUserId) return { status: "account_changed" } as const;

      const result = await client.query(
        `
          UPDATE user_github_connections
          SET allowed_repositories = $3::text[], updated_at = NOW()
          WHERE tenant_id = $1 AND user_id = $2
          RETURNING *
        `,
        [tenantId, userId, [...repositories]]
      );
      return {
        status: "updated",
        previous: toStringArray(row.allowed_repositories),
        record: mapGithubConnection(result.rows[0])
      } as const;
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
