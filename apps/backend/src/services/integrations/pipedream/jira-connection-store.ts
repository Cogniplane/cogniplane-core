import type { PoolClient } from "pg";

import { withTenantScope, type Pool } from "../../../lib/db.js";
import { isoTimestamp } from "../../../lib/db-mappers.js";

export type JiraConnectionRecord = {
  tenantId: string;
  userId: string;
  externalUserId: string;
  accountId: string;
  accountName: string | null;
  cloudId: string;
  siteName: string;
  siteUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type JiraConnectionUpsert = Omit<JiraConnectionRecord, "createdAt" | "updatedAt">;

/** The Pipedream project and environment that hold a member's accounts. */
export type PipedreamBinding = { projectId: string; environment: "development" | "production" };

/** The member's current Pipedream external user ID and its generation. */
export type JiraIdentity = { generation: number; externalUserId: string };

export type JiraCleanupReason = "user_disconnect" | "member_removed" | "project_changed";

export type JiraCleanupRecord = {
  cleanupId: string;
  tenantId: string;
  userId: string;
  externalUserId: string;
  accountId: string | null;
  binding: PipedreamBinding | null;
  reason: JiraCleanupReason;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The identity changed, or the member left, after the caller read it. */
export class JiraLifecycleConflictError extends Error {
  constructor(readonly reason: "identity_changed" | "not_member") {
    super(reason === "not_member" ? "The user is not a member of this organization." : "The Jira connection changed.");
    this.name = "JiraLifecycleConflictError";
  }
}

function mapRow(row: Record<string, unknown>): JiraConnectionRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    externalUserId: String(row.pipedream_external_user_id),
    accountId: String(row.pipedream_account_id),
    accountName: row.account_name === null || row.account_name === undefined ? null : String(row.account_name),
    cloudId: String(row.jira_cloud_id),
    siteName: String(row.jira_site_name),
    siteUrl: String(row.jira_site_url),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapCleanup(row: Record<string, unknown>): JiraCleanupRecord {
  return {
    cleanupId: String(row.cleanup_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    externalUserId: String(row.pipedream_external_user_id),
    accountId: nullableString(row.pipedream_account_id),
    binding: row.pipedream_project_id
      ? { projectId: String(row.pipedream_project_id), environment: row.pipedream_environment as PipedreamBinding["environment"] }
      : null,
    reason: row.reason as JiraCleanupReason,
    attempts: Number(row.attempts),
    lastError: nullableString(row.last_error),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

// Lock order for every lifecycle transaction: membership, then identity. Member
// removal deletes the membership row first and its trigger then updates the
// identity, so the same order prevents deadlocks. The membership lock is
// exclusive between lifecycle transactions because a missing identity row has
// nothing to lock: without it, a first authorization that read no identity can
// write an ID that a concurrent disconnect already retired. FOR NO KEY UPDATE
// still lets foreign key checks from other tables proceed.
async function lockMembership(client: PoolClient, tenantId: string, userId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 FOR NO KEY UPDATE`,
    [tenantId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function lockIdentity(client: PoolClient, tenantId: string, userId: string) {
  const result = await client.query(
    `SELECT generation, pipedream_external_user_id, pipedream_project_id, pipedream_environment
     FROM user_jira_identities WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
    [tenantId, userId]
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    generation: Number(row.generation),
    externalUserId: nullableString(row.pipedream_external_user_id),
    projectId: nullableString(row.pipedream_project_id),
    environment: nullableString(row.pipedream_environment)
  };
}

/**
 * Records a cleanup for the current external ID, removes the active mapping,
 * and retires the ID, in the caller's transaction. Returns null when there is
 * nothing to retire.
 */
async function retireInTransaction(
  client: PoolClient,
  tenantId: string,
  userId: string,
  reason: JiraCleanupReason,
  fallbackBinding: PipedreamBinding | null
): Promise<JiraCleanupRecord | null> {
  const identity = await lockIdentity(client, tenantId, userId);
  const mapping = await client.query(
    `DELETE FROM user_jira_connections WHERE tenant_id = $1 AND user_id = $2
     RETURNING pipedream_external_user_id, pipedream_account_id`,
    [tenantId, userId]
  );
  const removed = mapping.rows[0] as Record<string, unknown> | undefined;
  const externalUserId = identity?.externalUserId ?? nullableString(removed?.pipedream_external_user_id);
  if (!externalUserId) return null;
  const projectId = identity?.projectId ?? fallbackBinding?.projectId ?? null;
  const environment = identity?.projectId ? identity.environment : fallbackBinding?.environment ?? null;
  const cleanup = await client.query(
    `INSERT INTO user_jira_cleanups (
       tenant_id, user_id, pipedream_external_user_id, pipedream_account_id,
       pipedream_project_id, pipedream_environment, reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [tenantId, userId, externalUserId, nullableString(removed?.pipedream_account_id), projectId, environment, reason]
  );
  await client.query(
    `INSERT INTO user_jira_identities (tenant_id, user_id, generation, pipedream_external_user_id)
     VALUES ($1, $2, 1, NULL)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET
       generation = user_jira_identities.generation + 1,
       pipedream_external_user_id = NULL,
       pipedream_project_id = NULL,
       pipedream_environment = NULL,
       updated_at = NOW()`,
    [tenantId, userId]
  );
  return mapCleanup(cleanup.rows[0]);
}

export class JiraConnectionStore {
  constructor(private readonly db: Pool) {}

  async get(tenantId: string, userId: string): Promise<JiraConnectionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM user_jira_connections WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  /** The current identity, or null when the member has none in use. Never writes. */
  async getIdentity(tenantId: string, userId: string): Promise<JiraIdentity | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT generation, pipedream_external_user_id FROM user_jira_identities
         WHERE tenant_id = $1 AND user_id = $2 AND pipedream_external_user_id IS NOT NULL`,
        [tenantId, userId]
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? { generation: Number(row.generation), externalUserId: String(row.pipedream_external_user_id) } : null;
    });
  }

  /**
   * Returns the member's identity for `binding`. With `create`, it makes one
   * when the member has none in use; without it, it returns null then.
   * `derive` computes the external ID for a generation. When the stored
   * identity was used in another project or environment, it is retired with
   * a pending cleanup in that project, and a new generation starts here.
   */
  async bindIdentity(
    tenantId: string,
    userId: string,
    binding: PipedreamBinding,
    derive: (generation: number) => string,
    create: boolean
  ): Promise<JiraIdentity | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      if (!(await lockMembership(client, tenantId, userId))) throw new JiraLifecycleConflictError("not_member");
      let identity = await lockIdentity(client, tenantId, userId);
      if (identity?.externalUserId && identity.projectId
        && (identity.projectId !== binding.projectId || identity.environment !== binding.environment)) {
        await retireInTransaction(client, tenantId, userId, "project_changed", null);
        identity = await lockIdentity(client, tenantId, userId);
      }
      if (!create && !identity?.externalUserId) return null;
      const generation = identity?.generation ?? 0;
      const externalUserId = identity?.externalUserId ?? derive(generation);
      await client.query(
        `INSERT INTO user_jira_identities (
           tenant_id, user_id, generation, pipedream_external_user_id, pipedream_project_id, pipedream_environment
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET
           pipedream_external_user_id = EXCLUDED.pipedream_external_user_id,
           pipedream_project_id = EXCLUDED.pipedream_project_id,
           pipedream_environment = EXCLUDED.pipedream_environment,
           updated_at = NOW()`,
        [tenantId, userId, generation, externalUserId, binding.projectId, binding.environment]
      );
      return { generation, externalUserId };
    });
  }

  /**
   * Saves the selected account and site only if `expected` is still the
   * member's identity and the member still belongs to the tenant. This
   * rejects a selection that started before a disconnect or a removal.
   */
  async upsert(input: JiraConnectionUpsert, expected: JiraIdentity): Promise<JiraConnectionRecord> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      if (!(await lockMembership(client, input.tenantId, input.userId))) {
        throw new JiraLifecycleConflictError("not_member");
      }
      const identity = await lockIdentity(client, input.tenantId, input.userId);
      if (!identity || identity.generation !== expected.generation
        || identity.externalUserId !== expected.externalUserId || input.externalUserId !== expected.externalUserId) {
        throw new JiraLifecycleConflictError("identity_changed");
      }
      const result = await client.query(
        `INSERT INTO user_jira_connections (
            tenant_id, user_id, pipedream_external_user_id, pipedream_account_id,
            account_name, jira_cloud_id, jira_site_name, jira_site_url
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (tenant_id, user_id) DO UPDATE SET
            pipedream_external_user_id = EXCLUDED.pipedream_external_user_id,
            pipedream_account_id = EXCLUDED.pipedream_account_id,
            account_name = EXCLUDED.account_name,
            jira_cloud_id = EXCLUDED.jira_cloud_id,
            jira_site_name = EXCLUDED.jira_site_name,
            jira_site_url = EXCLUDED.jira_site_url,
            updated_at = NOW()
          RETURNING *`,
        [
          input.tenantId,
          input.userId,
          input.externalUserId,
          input.accountId,
          input.accountName,
          input.cloudId,
          input.siteName,
          input.siteUrl
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  /**
   * Removes the active mapping and retires the external ID in one short
   * transaction, before any remote call. Returns the pending cleanup, or null
   * when the member has no identity in use.
   */
  async retire(
    tenantId: string,
    userId: string,
    reason: JiraCleanupReason,
    binding: PipedreamBinding | null
  ): Promise<JiraCleanupRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      await lockMembership(client, tenantId, userId);
      return retireInTransaction(client, tenantId, userId, reason, binding);
    });
  }

  async listCleanups(tenantId: string, userId?: string): Promise<JiraCleanupRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM user_jira_cleanups
         WHERE tenant_id = $1 AND ($2::text IS NULL OR user_id = $2)
         ORDER BY created_at, cleanup_id
         LIMIT 500`,
        [tenantId, userId ?? null]
      );
      return result.rows.map(mapCleanup);
    });
  }

  async getCleanup(tenantId: string, cleanupId: string): Promise<JiraCleanupRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM user_jira_cleanups WHERE tenant_id = $1 AND cleanup_id = $2::uuid`,
        [tenantId, cleanupId]
      );
      return result.rows[0] ? mapCleanup(result.rows[0]) : null;
    });
  }

  async completeCleanup(tenantId: string, cleanupId: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM user_jira_cleanups WHERE tenant_id = $1 AND cleanup_id = $2::uuid`,
        [tenantId, cleanupId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /** `error` must be a fixed, safe message: it is shown to administrators. */
  async recordCleanupFailure(tenantId: string, cleanupId: string, error: string): Promise<JiraCleanupRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `UPDATE user_jira_cleanups
         SET attempts = attempts + 1, last_error = left($3, 300), updated_at = NOW()
         WHERE tenant_id = $1 AND cleanup_id = $2::uuid
         RETURNING *`,
        [tenantId, cleanupId, error]
      );
      return result.rows[0] ? mapCleanup(result.rows[0]) : null;
    });
  }
}
