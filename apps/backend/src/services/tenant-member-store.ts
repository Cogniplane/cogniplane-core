import { type Pool, withTenantScope } from "../lib/db.js";

import type { TenantMemberRecord } from "./admin-config-records.js";
import { mapTenantMember } from "./admin-config-store-mappers.js";

export type TenantMembershipRole = "owner" | "admin" | "member";

export class TenantMemberStore {
  constructor(private readonly db: Pool) {}

  /**
   * Returns the role of `userId` in `tenantId`, or null if no membership row
   * exists. Used by the auth middleware to decide whether to admit the request
   * — see `lib/auth-workos.ts`. Construct against the privileged pool there:
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
            u.display_name
          FROM tenant_memberships tm
          JOIN users u ON u.user_id = tm.user_id
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
