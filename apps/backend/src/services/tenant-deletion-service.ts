import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import type { Pool } from "../lib/db.js";
import type { ArtifactStorage } from "./artifacts/artifact-storage.js";
import type { SkillBundleStorage } from "./skills/skill-bundle-storage.js";

type CleanupKind = "artifact" | "skill_bundle" | "runtime_thread" | "redis_database";

export type TenantDeletionInput = {
  requestId: string;
  tenantId: string;
  redisDisposition: string;
  thirdPartyDisposition: string;
  backupDisposition: string;
};

export type TenantDeletionReceipt = {
  requestId: string;
  tenantIdHash: string;
  status: "cleanup_pending" | "cleanup_failed" | "completed";
  rowCounts: Record<string, number>;
  objectCount: number;
  runtimeThreadCount: number;
  deletedObjectCount: number;
  retainedSharedObjectCount: number;
  purgedRuntimeThreadCount: number;
  redisDisposition: string;
  thirdPartyDisposition: string;
  backupDisposition: string;
  initiatedAt: string;
  databaseDeletedAt: string;
  completedAt: string | null;
  lastError: string | null;
};

type TenantDeletionDependencies = {
  db: Pool;
  artifactStorage: Pick<ArtifactStorage, "delete">;
  skillBundleStorage: Pick<SkillBundleStorage, "deleteBundle">;
  purgeRuntimeThread(threadId: string): Promise<void>;
  flushRedis?: () => Promise<void>;
};

type CleanupRow = { kind: CleanupKind; locator: string };

function tenantHash(tenantId: string): string {
  return createHash("sha256").update(tenantId).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function receiptFromRow(row: Record<string, unknown>): TenantDeletionReceipt {
  return {
    requestId: String(row.request_id),
    tenantIdHash: String(row.tenant_id_hash),
    status: row.status as TenantDeletionReceipt["status"],
    rowCounts: (row.row_counts as Record<string, number>) ?? {},
    objectCount: Number(row.object_count),
    runtimeThreadCount: Number(row.runtime_thread_count),
    deletedObjectCount: Number(row.deleted_object_count),
    retainedSharedObjectCount: Number(row.retained_shared_object_count),
    purgedRuntimeThreadCount: Number(row.purged_runtime_thread_count),
    redisDisposition: String(row.redis_disposition),
    thirdPartyDisposition: String(row.third_party_disposition),
    backupDisposition: String(row.backup_disposition),
    initiatedAt: new Date(row.initiated_at as string | Date).toISOString(),
    databaseDeletedAt: new Date(row.database_deleted_at as string | Date).toISOString(),
    completedAt: row.completed_at
      ? new Date(row.completed_at as string | Date).toISOString()
      : null,
    lastError: row.last_error === null ? null : String(row.last_error)
  };
}

async function loadReceipt(client: PoolClient, requestId: string): Promise<TenantDeletionReceipt | null> {
  const result = await client.query(
    `SELECT * FROM tenant_deletion_receipts WHERE request_id = $1`,
    [requestId]
  );
  return result.rowCount === 0 ? null : receiptFromRow(result.rows[0]);
}

async function countTenantRows(client: PoolClient, tenantId: string): Promise<Record<string, number>> {
  const tables = await client.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'tenant_id'
      ORDER BY table_name
    `
  );
  const counts: Record<string, number> = {};
  for (const { table_name: tableName } of tables.rows) {
    // The identifier comes from PostgreSQL's catalog, not operator input.
    const quotedTable = `"${tableName.replaceAll('"', '""')}"`;
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.${quotedTable} WHERE tenant_id = $1`,
      [tenantId]
    );
    counts[tableName] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

async function enqueueCleanup(client: PoolClient, requestId: string, tenantId: string, includeRedis: boolean) {
  await client.query(
    `
      INSERT INTO tenant_deletion_cleanup (request_id, kind, locator)
      SELECT $1, 'artifact', storage_key FROM artifacts WHERE tenant_id = $2
      UNION
      SELECT $1, 'artifact', storage_key FROM project_file_versions WHERE tenant_id = $2
      UNION
      SELECT $1, 'artifact', storage_key FROM project_file_storage_gc WHERE tenant_id = $2
      UNION
      SELECT $1, 'artifact', storage_key FROM session_storage_gc WHERE tenant_id = $2
      UNION
      SELECT $1, 'skill_bundle', bundle_storage_uri
        FROM admin_skill_revisions
       WHERE tenant_id = $2 AND bundle_storage_uri IS NOT NULL
      UNION
      SELECT $1, 'runtime_thread', session_id FROM sessions WHERE tenant_id = $2
      UNION
      SELECT $1, 'runtime_thread', session_id FROM session_runtime_gc WHERE tenant_id = $2
      ON CONFLICT DO NOTHING
    `,
    [requestId, tenantId]
  );
  if (includeRedis) {
    await client.query(
      `
        INSERT INTO tenant_deletion_cleanup (request_id, kind, locator)
        VALUES ($1, 'redis_database', 'dedicated-environment-database')
        ON CONFLICT DO NOTHING
      `,
      [requestId]
    );
  }
}

export class TenantDeletionService {
  constructor(private readonly deps: TenantDeletionDependencies) {}

  async execute(input: TenantDeletionInput): Promise<TenantDeletionReceipt> {
    if (!input.requestId.trim()) throw new Error("requestId is required.");
    if (!input.tenantId.trim()) throw new Error("tenantId is required.");

    await this.deleteDatabaseRows(input);
    await this.runCleanup(input.requestId);

    const receipt = await this.deps.db.connect();
    try {
      const result = await loadReceipt(receipt, input.requestId);
      if (!result) throw new Error(`Deletion receipt ${input.requestId} disappeared.`);
      return result;
    } finally {
      receipt.release();
    }
  }

  private async deleteDatabaseRows(input: TenantDeletionInput): Promise<void> {
    const client = await this.deps.db.connect();
    try {
      await client.query("BEGIN");
      const existing = await loadReceipt(client, input.requestId);
      if (existing) {
        if (existing.tenantIdHash !== tenantHash(input.tenantId)) {
          throw new Error(`Request ${input.requestId} belongs to a different tenant identifier.`);
        }
        await client.query("COMMIT");
        return;
      }

      const tenant = await client.query(
        `SELECT tenant_id FROM tenants WHERE tenant_id = $1 FOR UPDATE`,
        [input.tenantId]
      );
      if (tenant.rowCount === 0) {
        throw new Error(`Tenant ${input.tenantId} does not exist and has no matching deletion receipt.`);
      }

      const rowCounts = await countTenantRows(client, input.tenantId);
      const userIds = await client.query<{ user_id: string }>(
        `SELECT user_id FROM tenant_memberships WHERE tenant_id = $1`,
        [input.tenantId]
      );

      await client.query(
        `
          INSERT INTO tenant_deletion_receipts (
            request_id, tenant_id_hash, status, row_counts,
            redis_disposition, third_party_disposition, backup_disposition,
            database_deleted_at
          ) VALUES ($1, $2, 'cleanup_pending', $3::jsonb, $4, $5, $6, NOW())
        `,
        [
          input.requestId,
          tenantHash(input.tenantId),
          JSON.stringify(rowCounts),
          input.redisDisposition,
          input.thirdPartyDisposition,
          input.backupDisposition
        ]
      );
      await enqueueCleanup(client, input.requestId, input.tenantId, Boolean(this.deps.flushRedis));

      const cleanupCounts = await client.query<{ objects: string; runtime_threads: string }>(
        `
          SELECT
            COUNT(*) FILTER (WHERE kind IN ('artifact', 'skill_bundle'))::text AS objects,
            COUNT(*) FILTER (WHERE kind = 'runtime_thread')::text AS runtime_threads
          FROM tenant_deletion_cleanup
          WHERE request_id = $1
        `,
        [input.requestId]
      );
      await client.query(
        `
          UPDATE tenant_deletion_receipts
          SET object_count = $2, runtime_thread_count = $3
          WHERE request_id = $1
        `,
        [
          input.requestId,
          Number(cleanupCounts.rows[0]?.objects ?? 0),
          Number(cleanupCounts.rows[0]?.runtime_threads ?? 0)
        ]
      );

      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [input.tenantId]);
      const orphanedUsers = await client.query(
        `
          DELETE FROM users u
          WHERE u.user_id = ANY($1::text[])
            AND NOT EXISTS (
              SELECT 1 FROM tenant_memberships tm WHERE tm.user_id = u.user_id
            )
        `,
        [userIds.rows.map((row) => row.user_id)]
      );
      rowCounts.orphaned_users = orphanedUsers.rowCount ?? 0;
      await client.query(
        `UPDATE tenant_deletion_receipts SET row_counts = $2::jsonb WHERE request_id = $1`,
        [input.requestId, JSON.stringify(rowCounts)]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async runCleanup(requestId: string): Promise<void> {
    const pending = await this.deps.db.query<CleanupRow>(
      `
        SELECT kind, locator
        FROM tenant_deletion_cleanup
        WHERE request_id = $1
        ORDER BY kind, locator
      `,
      [requestId]
    );
    const failures: string[] = [];

    for (const item of pending.rows) {
      try {
        const outcome = await this.cleanupItem(item);
        await this.deps.db.query(
          `
            WITH removed AS (
              DELETE FROM tenant_deletion_cleanup
              WHERE request_id = $1 AND kind = $2 AND locator = $3
              RETURNING kind
            )
            UPDATE tenant_deletion_receipts
            SET deleted_object_count = deleted_object_count +
                  (SELECT COUNT(*) FROM removed WHERE kind IN ('artifact', 'skill_bundle') AND $4 = 'deleted'),
                retained_shared_object_count = retained_shared_object_count +
                  (SELECT COUNT(*) FROM removed WHERE kind IN ('artifact', 'skill_bundle') AND $4 = 'retained_shared'),
                purged_runtime_thread_count = purged_runtime_thread_count +
                  (SELECT COUNT(*) FROM removed WHERE kind = 'runtime_thread'),
                last_error = NULL
            WHERE request_id = $1
          `,
          [requestId, item.kind, item.locator, outcome]
        );
      } catch (error) {
        // The queue already retains the locator needed for retry. Keep it out
        // of the durable receipt because object keys can contain tenant data.
        const message = `${item.kind}: ${errorMessage(error)}`;
        failures.push(message);
        await this.deps.db.query(
          `
            UPDATE tenant_deletion_cleanup
            SET attempts = attempts + 1, last_error = $4
            WHERE request_id = $1 AND kind = $2 AND locator = $3
          `,
          [requestId, item.kind, item.locator, message]
        );
      }
    }

    const remaining = await this.deps.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tenant_deletion_cleanup WHERE request_id = $1`,
      [requestId]
    );
    const remainingCount = Number(remaining.rows[0]?.count ?? 0);
    await this.deps.db.query(
      `
        UPDATE tenant_deletion_receipts
        SET status = $2,
            completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END,
            last_error = $3
        WHERE request_id = $1
      `,
      [
        requestId,
        remainingCount === 0 ? "completed" : "cleanup_failed",
        failures.length > 0 ? failures.join("\n") : null
      ]
    );
  }

  private async cleanupItem(item: CleanupRow): Promise<"deleted" | "retained_shared" | "purged"> {
    if (item.kind === "artifact") {
      const references = await this.deps.db.query(
        `
          SELECT 1 FROM artifacts WHERE storage_key = $1
          UNION ALL SELECT 1 FROM project_file_versions WHERE storage_key = $1
          UNION ALL SELECT 1 FROM project_file_storage_gc WHERE storage_key = $1
          UNION ALL SELECT 1 FROM session_storage_gc WHERE storage_key = $1
          LIMIT 1
        `,
        [item.locator]
      );
      if ((references.rowCount ?? 0) > 0) return "retained_shared";
      await this.deps.artifactStorage.delete(item.locator);
      return "deleted";
    }
    if (item.kind === "skill_bundle") {
      const references = await this.deps.db.query(
        `SELECT 1 FROM admin_skill_revisions WHERE bundle_storage_uri = $1 LIMIT 1`,
        [item.locator]
      );
      if ((references.rowCount ?? 0) > 0) return "retained_shared";
      await this.deps.skillBundleStorage.deleteBundle(item.locator);
      return "deleted";
    }
    if (item.kind === "runtime_thread") {
      await this.deps.purgeRuntimeThread(item.locator);
      return "purged";
    }
    if (!this.deps.flushRedis) {
      throw new Error("Redis cleanup was queued but no Redis client was configured.");
    }
    await this.deps.flushRedis();
    return "purged";
  }
}
