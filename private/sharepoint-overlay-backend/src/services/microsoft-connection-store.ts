import { withTenantScope, type Pool } from "../../../../apps/backend/src/lib/db.js";
import { AuditEventStore, type AuditEventInput } from "../../../../apps/backend/src/services/audit-event-store.js";
import {
  assertOwnerSecurityVersion,
  ownerSecurityVersionSql
} from "../../../../apps/backend/src/services/auth/security-change.js";
import type {} from "../audit-event-types.js";

export type MicrosoftConnectionRecord = {
  tenantId: string;
  userId: string;
  microsoftUserId: string;
  microsoftEmail: string | null;
  microsoftDisplayName: string | null;
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

function mapMicrosoftConnection(row: Record<string, unknown>): MicrosoftConnectionRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    microsoftUserId: String(row.microsoft_user_id),
    microsoftEmail: row.microsoft_email ? String(row.microsoft_email) : null,
    microsoftDisplayName: row.microsoft_display_name ? String(row.microsoft_display_name) : null,
    tokenType: String(row.token_type ?? "bearer"),
    grantedScopes: toStringArray(row.granted_scopes),
    accessTokenEncrypted: String(row.access_token_encrypted),
    accessTokenExpiresAt: row.access_token_expires_at
      ? new Date(String(row.access_token_expires_at)).toISOString()
      : null,
    refreshTokenEncrypted: row.refresh_token_encrypted ? String(row.refresh_token_encrypted) : null,
    refreshTokenExpiresAt: row.refresh_token_expires_at
      ? new Date(String(row.refresh_token_expires_at)).toISOString()
      : null,
    tokenLastRefreshedAt: row.microsoft_token_last_refreshed_at
      ? new Date(String(row.microsoft_token_last_refreshed_at)).toISOString()
      : null,
    tokenLastUsedAt: row.microsoft_token_last_used_at
      ? new Date(String(row.microsoft_token_last_used_at)).toISOString()
      : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

/** A connection as its owner sees it: also when a security change suspended it. */
export type MicrosoftOwnerConnectionRecord = MicrosoftConnectionRecord & { suspended: boolean };

// The owner's account still has the stored version (or is a WorkOS account).
const CURRENT_VERSION_SQL = ownerSecurityVersionSql("user_microsoft_connections");
const SUSPENDED_SQL = `NOT (${CURRENT_VERSION_SQL})`;

function mapOwnerConnection(row: Record<string, unknown> | undefined): MicrosoftOwnerConnectionRecord | null {
  return row ? { ...mapMicrosoftConnection(row), suspended: row.suspended === true } : null;
}

export class MicrosoftConnectionStore {
  constructor(private readonly db: Pool) {}

  /**
   * The connection for use: tools, files, and session start. A connection
   * that a security change of the owner suspended is not returned (see
   * services/auth/security-change.ts in the backend).
   */
  async get(tenantId: string, userId: string): Promise<MicrosoftConnectionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM user_microsoft_connections
         WHERE tenant_id = $1 AND user_id = $2 AND ${CURRENT_VERSION_SQL}
         LIMIT 1`,
        [tenantId, userId]
      );
      return result.rows[0] ? mapMicrosoftConnection(result.rows[0]) : null;
    });
  }

  /** The connection for its owner's settings page and disconnect, suspended or not. Not for use. */
  async getForOwner(tenantId: string, userId: string): Promise<MicrosoftOwnerConnectionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT *, ${SUSPENDED_SQL} AS suspended FROM user_microsoft_connections
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      return mapOwnerConnection(result.rows[0]);
    });
  }

  /**
   * The owner confirms the connection from a current session: store that
   * session's security version. `expectedMicrosoftUserId` is the account that
   * the owner saw, so a reconnect meanwhile is not confirmed. Returns null
   * when that account is not connected. The result stays suspended when the
   * session's version is not current. A confirm that restores the connection
   * writes `user.microsoft.confirmed` in the same transaction. Only a
   * connection with the email that Microsoft Graph returned can be confirmed:
   * a display name proves nothing to the owner.
   */
  async confirm(
    tenantId: string,
    userId: string,
    expectedMicrosoftUserId: string,
    ownerSecurityVersion: number | null
  ): Promise<MicrosoftOwnerConnectionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `UPDATE user_microsoft_connections SET owner_security_version = $4
         WHERE tenant_id = $1 AND user_id = $2 AND microsoft_user_id = $3
           AND microsoft_email IS NOT NULL
         RETURNING *, ${SUSPENDED_SQL} AS suspended`,
        [tenantId, userId, expectedMicrosoftUserId, ownerSecurityVersion]
      );
      const confirmed = mapOwnerConnection(result.rows[0]);
      if (confirmed && !confirmed.suspended) {
        await AuditEventStore.createInTransaction(client, {
          tenantId, userId, sessionId: null, type: "user.microsoft.confirmed",
          payload: { microsoftUserId: confirmed.microsoftUserId, ownerSecurityVersion }
        });
      }
      return confirmed;
    });
  }

  async upsert(input: {
    tenantId: string;
    userId: string;
    microsoftUserId: string;
    microsoftEmail: string | null;
    microsoftDisplayName: string | null;
    tokenType: string;
    grantedScopes: string[];
    accessTokenEncrypted: string;
    accessTokenExpiresAt: string | null;
    refreshTokenEncrypted: string | null;
    refreshTokenExpiresAt: string | null;
    tokenLastRefreshedAt: string | null;
    // The security version of the session that started the authorization.
    // The callback has no session, so the write is bound to this version:
    // OwnerSecurityVersionChangedError when it is not the owner's current one.
    // Only the callback calls upsert; a token refresh uses updateRefreshedToken.
    ownerSecurityVersion: number | null;
  },
  // The connect's audit event; it commits in the connect's transaction.
  audit?: (connection: MicrosoftConnectionRecord) => AuditEventInput): Promise<MicrosoftConnectionRecord> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      await assertOwnerSecurityVersion(client, input.tenantId, input.userId, input.ownerSecurityVersion);
      const result = await client.query(
        `INSERT INTO user_microsoft_connections (
            tenant_id, user_id, microsoft_user_id, microsoft_email, microsoft_display_name,
            token_type, granted_scopes, access_token_encrypted,
            access_token_expires_at, refresh_token_encrypted, refresh_token_expires_at,
            microsoft_token_last_refreshed_at, owner_security_version
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (tenant_id, user_id)
          DO UPDATE SET
            microsoft_user_id = EXCLUDED.microsoft_user_id,
            microsoft_email = EXCLUDED.microsoft_email,
            microsoft_display_name = EXCLUDED.microsoft_display_name,
            token_type = EXCLUDED.token_type,
            granted_scopes = EXCLUDED.granted_scopes,
            access_token_encrypted = EXCLUDED.access_token_encrypted,
            access_token_expires_at = EXCLUDED.access_token_expires_at,
            refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
            refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
            microsoft_token_last_refreshed_at = EXCLUDED.microsoft_token_last_refreshed_at,
            owner_security_version = EXCLUDED.owner_security_version,
            updated_at = NOW()
          RETURNING *`,
        [
          input.tenantId, input.userId, input.microsoftUserId, input.microsoftEmail,
          input.microsoftDisplayName, input.tokenType,
          JSON.stringify(input.grantedScopes), input.accessTokenEncrypted,
          input.accessTokenExpiresAt, input.refreshTokenEncrypted,
          input.refreshTokenExpiresAt, input.tokenLastRefreshedAt, input.ownerSecurityVersion
        ]
      );
      const connection = mapMicrosoftConnection(result.rows[0]);
      if (audit) await AuditEventStore.createInTransaction(client, audit(connection));
      return connection;
    });
  }

  /**
   * Stores refreshed tokens only on the connection that the refresh started
   * from: the same Microsoft account and the same refresh token. Returns null
   * when a disconnect, a reconnect or another refresh happened meanwhile, so a
   * slow refresh cannot create the row again or overwrite another connection.
   * Also null when a security change suspended the connection meanwhile. The
   * stored security version does not change.
   */
  async updateRefreshedToken(input: {
    tenantId: string;
    userId: string;
    expectedMicrosoftUserId: string;
    expectedRefreshTokenEncrypted: string;
    tokenType: string;
    grantedScopes: string[];
    accessTokenEncrypted: string;
    accessTokenExpiresAt: string | null;
    refreshTokenEncrypted: string;
  }): Promise<MicrosoftConnectionRecord | null> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE user_microsoft_connections
         SET token_type = $5,
             granted_scopes = $6::jsonb,
             access_token_encrypted = $7,
             access_token_expires_at = $8,
             refresh_token_encrypted = $9,
             microsoft_token_last_refreshed_at = NOW(),
             updated_at = NOW()
         WHERE tenant_id = $1 AND user_id = $2
           AND microsoft_user_id = $3 AND refresh_token_encrypted = $4
           AND ${CURRENT_VERSION_SQL}
         RETURNING *`,
        [
          input.tenantId, input.userId, input.expectedMicrosoftUserId, input.expectedRefreshTokenEncrypted,
          input.tokenType, JSON.stringify(input.grantedScopes), input.accessTokenEncrypted,
          input.accessTokenExpiresAt, input.refreshTokenEncrypted
        ]
      );
      return result.rows[0] ? mapMicrosoftConnection(result.rows[0]) : null;
    });
  }

  /** `audit` builds the disconnect's audit event from the removed row. It commits in the delete's transaction. */
  async delete(tenantId: string, userId: string,
    audit?: (removed: MicrosoftConnectionRecord) => AuditEventInput): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM user_microsoft_connections WHERE tenant_id = $1 AND user_id = $2 RETURNING *`,
        [tenantId, userId]
      );
      if (!result.rows[0]) return false;
      if (audit) await AuditEventStore.createInTransaction(client, audit(mapMicrosoftConnection(result.rows[0])));
      return true;
    });
  }

  async markTokenUsed(tenantId: string, userId: string): Promise<void> {
    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `UPDATE user_microsoft_connections
         SET microsoft_token_last_used_at = NOW(), updated_at = NOW()
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
    });
  }
}
