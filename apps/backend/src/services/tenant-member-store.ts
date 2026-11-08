import type { LoginType } from "../config.js";
import { type Pool, withTenantScope } from "../lib/db.js";

import type { TenantMemberRecord } from "./admin-config-records.js";
import { mapTenantMember } from "./admin-config-store-mappers.js";

export type TenantMembershipRole = "owner" | "admin" | "member";

/**
 * What sign-in needs to know about one membership. `getRole` answers "is this
 * user a member"; this answers "may this user's token act in this tenant".
 * See docs/architecture/auth.md.
 */
export type LocalAccountStatus = "pending_setup" | "active" | "disabled" | "removed";

export type TenantAuthState = {
  role: TenantMembershipRole;
  /** How the tenant's members sign in. Fixed at tenant creation. */
  loginType: LoginType;
  /** Which login path owns the user row. */
  authSource: LoginType;
  /** Local accounts only; null for WorkOS users. */
  localStatus: LocalAccountStatus | null;
  /** Local accounts only; every token of a session must carry this value. */
  securityVersion: number | null;
};

function isLocalStatus(value: unknown): value is LocalAccountStatus {
  return value === "pending_setup" || value === "active" || value === "disabled" || value === "removed";
}

const AUTH_STATE_SQL = `
  SELECT tm.role, t.login_type, u.auth_source, li.status AS local_status, li.security_version
  FROM tenant_memberships tm
  JOIN tenants t ON t.tenant_id = tm.tenant_id
  JOIN users u ON u.user_id = tm.user_id
  LEFT JOIN local_identities li ON li.tenant_id = tm.tenant_id AND li.user_id = tm.user_id
  WHERE tm.tenant_id = $1
    AND tm.user_id = $2
  LIMIT 1
`;

type AuthStateRow = {
  role: string;
  login_type: string;
  auth_source: string;
  local_status: string | null;
  security_version: number | null;
};

function mapAuthState(row: AuthStateRow | undefined): TenantAuthState | null {
  if (!row) return null;
  const { role, login_type: loginType, auth_source: authSource } = row;
  if (role !== "owner" && role !== "admin" && role !== "member") return null;
  // An unknown value means a schema this code does not know. Refuse.
  if (!isLoginType(loginType) || !isLoginType(authSource)) return null;
  if (authSource === "local") {
    // A local member without a local identity is a data error: refuse.
    if (!isLocalStatus(row.local_status) || typeof row.security_version !== "number") return null;
    return { role, loginType, authSource, localStatus: row.local_status, securityVersion: row.security_version };
  }
  return { role, loginType, authSource, localStatus: null, securityVersion: null };
}

/**
 * Whether the account itself may act, without a token: a WorkOS user always,
 * a local user only while active, and only in a tenant of its own login type.
 */
export function isAccountActive(state: TenantAuthState): boolean {
  return state.authSource === state.loginType && (state.authSource !== "local" || state.localStatus === "active");
}

function isLoginType(value: unknown): value is LoginType {
  return value === "workos" || value === "local";
}

export class TenantMemberStore {
  constructor(private readonly db: Pool) {}

  /**
   * Returns the role of `userId` in `tenantId`, or null if no membership row
   * exists. Used by the auth middleware to decide whether to admit the request
   * — see `lib/auth-jwt.ts`. Construct against the privileged pool there:
   * the lookup runs before the tenant context is established, and rejecting
   * non-members is itself a tenant-spanning question.
   */
  async getRole(tenantId: string, userId: string): Promise<TenantMembershipRole | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query<{ role: string }>(
        `
          SELECT role
          FROM tenant_memberships
          WHERE tenant_id = $1
            AND user_id = $2
          LIMIT 1
        `,
        [tenantId, userId]
      );
      const row = result.rows[0];
      if (!row) return null;
      const role = row.role;
      if (role === "owner" || role === "admin" || role === "member") return role;
      return null;
    });
  }

  /**
   * Membership role plus the tenant's login type and the user's login path, in
   * one query, or null if no membership row exists. Construct against the
   * privileged pool, like `getRole`: it runs before the tenant context exists.
   */
  async getAuthState(tenantId: string, userId: string): Promise<TenantAuthState | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query<AuthStateRow>(AUTH_STATE_SQL, [tenantId, userId]);
      return mapAuthState(result.rows[0]);
    });
  }

  /**
   * The role of a member whose account may act now (`isAccountActive`), or
   * null. Runtime admission uses it: work for a disabled or not yet set up
   * local account is refused, also on a replica that did not see the change.
   * `getRole` keeps answering "is this user a member" for admin screens.
   */
  async getActiveRole(tenantId: string, userId: string): Promise<TenantMembershipRole | null> {
    const state = await this.getAuthState(tenantId, userId);
    return state && isAccountActive(state) ? state.role : null;
  }

  async listTenantMembers(tenantId: string): Promise<TenantMemberRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT
            tm.tenant_id,
            tm.user_id,
            tm.role,
            tm.is_beta_tester,
            tm.created_at,
            tm.updated_at,
            u.email,
            u.display_name,
            li.status AS account_status,
            EXISTS (
              SELECT 1 FROM user_totp_factors f
              WHERE f.tenant_id = tm.tenant_id AND f.user_id = tm.user_id AND f.confirmed_at IS NOT NULL
            ) OR EXISTS (
              SELECT 1 FROM user_passkeys p WHERE p.tenant_id = tm.tenant_id AND p.user_id = tm.user_id
            ) AS mfa_enabled,
            (SELECT count(*) FROM user_passkeys p WHERE p.tenant_id = tm.tenant_id AND p.user_id = tm.user_id)::int AS passkey_count,
            le.kind AS link_email_kind,
            le.status AS link_email_status,
            le.updated_at AS link_email_updated_at,
            le.last_error AS link_email_error
          FROM tenant_memberships tm
          JOIN users u ON u.user_id = tm.user_id
          LEFT JOIN local_identities li ON li.tenant_id = tm.tenant_id AND li.user_id = tm.user_id
          -- The latest email that carried a link to this account (email on only).
          LEFT JOIN LATERAL (
            SELECT o.kind, o.status, o.updated_at, o.last_error
            FROM email_outbox o
            WHERE o.tenant_id = tm.tenant_id AND o.user_id = tm.user_id
              AND o.kind IN ('account_setup_link', 'password_reset_link')
            ORDER BY o.created_at DESC, o.email_id DESC
            LIMIT 1
          ) le ON true
          WHERE tm.tenant_id = $1
          ORDER BY u.display_name ASC NULLS LAST, u.email ASC
        `,
        [tenantId]
      );

      return result.rows.map((row) => mapTenantMember(row));
    });
  }

  async setUserBetaTester(
    tenantId: string,
    userId: string,
    isBetaTester: boolean
  ): Promise<TenantMemberRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE tenant_memberships
          SET is_beta_tester = $3, updated_at = NOW()
          WHERE tenant_id = $1
            AND user_id = $2
          RETURNING tenant_id, user_id, role, is_beta_tester, created_at, updated_at
        `,
        [tenantId, userId, isBetaTester]
      );

      if (!result.rows[0]) {
        return null;
      }

      const membershipRow = result.rows[0] as Record<string, unknown>;

      const userResult = await client.query(
        `SELECT email, display_name FROM users WHERE user_id = $1 LIMIT 1`,
        [userId]
      );

      const userRow = userResult.rows[0] as Record<string, unknown> | undefined;

      return mapTenantMember({
        ...membershipRow,
        email: userRow?.email ?? null,
        display_name: userRow?.display_name ?? null
      });
    });
  }

  async isUserBetaTester(tenantId: string, userId: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT is_beta_tester
          FROM tenant_memberships
          WHERE tenant_id = $1
            AND user_id = $2
          LIMIT 1
        `,
        [tenantId, userId]
      );

      return result.rows[0] ? Boolean(result.rows[0].is_beta_tester) : false;
    });
  }
}
