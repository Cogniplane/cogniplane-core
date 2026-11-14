import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import type { Pool } from "../lib/db.js";
import type { ArtifactStorage } from "./artifacts/artifact-storage.js";
import type { SkillBundleStorage } from "./skills/skill-bundle-storage.js";

type CleanupKind = "artifact" | "skill_bundle" | "runtime_thread" | "redis_database";

/**
 * Texts for the receipt's `redisDisposition`. The command writes the first
 * text when it deletes the rows. Cleanup replaces it when it runs a queued
 * flush, so the receipt tells what happened, not what was requested. Receipts
 * from older versions can hold "Dedicated environment Redis database flushed;
 * ...", written before the flush ran.
 */
export const REDIS_DISPOSITION = {
  notConfigured: "REDIS_URL was not configured; Redis was not contacted.",
  notRequested:
    "Redis not flushed: --flush-redis was not given. Sessions and counters of other tenants are unchanged. " +
    "Keys of the deleted tenant stay in Redis until they expire.",
  flushQueued: "Redis flush requested with --flush-redis; it has not run yet.",
  flushed:
    "Redis database flushed (--flush-redis): all keys in the database that REDIS_URL selects were removed, " +
    "for all tenants. All users were signed out and all rate-limit and quota counters were reset.",
  flushFailed: "Redis flush failed and stays queued. Run the command again with --flush-redis.",
  flushNotAllowed:
    "Redis not flushed: a flush is queued for this request, but this run did not have --flush-redis. " +
    "Run the command again with --flush-redis to flush the whole Redis database."
} as const;

export type TenantDeletionInput = {
  requestId: string;
  tenantId: string;
  /** Recorded when this request deletes the rows; a replay keeps the stored text. */
  redisDisposition: string;
  /** The operator's statement. The service does not check it against `externalResources`. */
  thirdPartyDisposition: string;
  backupDisposition: string;
};

/**
 * Counts of the tenant's resources outside this database, read before the
 * cascade deletes their rows. Tenant deletion deletes only the local rows: it
 * kills no sandbox and revokes no token or account. The counts tell the
 * operator what to check at each provider; they hold no id, label or secret.
 */
export type ExternalResourceInventory = {
  /** Distinct `sessions.sandbox_id` values. E2B can have expired some already. */
  e2bSandboxes: number;
  /** Pipedream Connect external user ids. Each one can own Jira accounts in Pipedream. */
  jira: {
    /** Distinct ids, current and retired together: the number of ids to check in Pipedream. */
    externalUserIds: number;
    /** Current ids, from `user_jira_identities` and `user_jira_connections`. */
    activeExternalUserIds: number;
    /** Current ids without a selected account: an authorization started, and accounts can exist that no row names. */
    activeExternalUserIdsWithoutSelectedAccount: number;
    /** Distinct selected Pipedream account ids (`user_jira_connections`). */
    selectedAccounts: number;
    /** Distinct retired ids whose remote delete did not finish (`user_jira_cleanups`). */
    retiredExternalUserIdsPendingCleanup: number;
    /** `user_jira_cleanups` rows. More than the ids above when one id has more than one row. */
    pendingCleanups: number;
  };
  /** Connection rows, each with a stored OAuth token. The grant at the provider stays until it is revoked or expires. */
  oauthConnections: { github: number; notion: number; microsoft: number };
  /** `member_mcp_credentials` rows that hold a secret. */
  personalMcpCredentials: number;
};

export type TenantDeletionReceipt = {
  requestId: string;
  tenantIdHash: string;
  status: "cleanup_pending" | "cleanup_failed" | "completed";
  rowCounts: Record<string, number>;
  /** Null for a receipt written before the inventory existed: the counts were not recorded. */
  externalResources: ExternalResourceInventory | null;
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
  /**
   * Flushes the whole Redis database, for every tenant. Give it only when the
   * operator asked for that (--flush-redis). A new deletion then queues a
   * flush, and a replay runs a flush that an earlier run queued. Without it,
   * the service never queues or runs a flush; a queued flush stays queued.
   */
  flushRedis?: () => Promise<void>;
};

type CleanupRow = { kind: CleanupKind; locator: string };

/**
 * Columns that store a `users.user_id` without a foreign key to `users`. The
 * deletion reads the foreign-key columns from the catalog. The integration
 * test "names every column that can hold a user id" keeps this list complete.
 */
export const USER_ID_COLUMNS_WITHOUT_FOREIGN_KEY: readonly (readonly [table: string, column: string])[] = [
  ["admin_mcp_app_csp_approvals", "approved_by"],
  ["admin_mcp_connection_tests", "scope_user_id"],
  ["admin_mcp_servers", "created_by"],
  ["admin_skill_revisions", "created_by"],
  ["admin_skill_revisions", "reviewed_by"],
  ["admin_skills", "created_by"],
  ["agent_memories", "approved_by_user_id"],
  ["agent_memories", "user_id"],
  ["artifact_download_tokens", "issued_by_user_id"],
  ["auth_action_tokens", "created_by"],
  ["auth_action_tokens", "user_id"],
  ["email_outbox", "user_id"],
  ["local_passwords", "user_id"],
  ["member_mcp_credentials", "user_id"],
  ["model_spending_reservations", "user_id"],
  ["organization_skill_author_updates", "recipient_user_id"],
  ["organization_skill_submission_attempts", "decided_by"],
  ["organization_skill_submissions", "author_user_id"],
  ["personal_capability_defaults", "user_id"],
  ["personal_skill_revisions", "user_id"],
  ["personal_skills", "user_id"],
  ["pii_scan_jobs", "source_user_id"],
  ["pii_scan_runs", "source_user_id"],
  ["policy_decision", "user_id"],
  ["policy_rule", "created_by"],
  ["project_skill_revisions", "created_by"],
  ["project_skills", "created_by"],
  ["project_skills", "source_user_id"],
  ["scheduled_job_runs", "user_id"],
  ["session_runtime_gc", "user_id"],
  ["tenant_custom_models", "created_by"],
  ["user_jira_cleanups", "user_id"],
  ["user_jira_identities", "user_id"],
  ["user_passkeys", "user_id"],
  ["user_recovery_codes", "user_id"],
  ["user_totp_factors", "user_id"]
];

/** A column that can store a user id; both names are quoted SQL identifiers. */
type UserReference = { table: string; column: string; tenantScoped: boolean };

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

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
    externalResources: (row.external_resources as ExternalResourceInventory | null | undefined) ?? null,
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
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.${quoteIdentifier(tableName)} WHERE tenant_id = $1`,
      [tenantId]
    );
    counts[tableName] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}

// Call this in the deletion transaction, before the tenant delete: the
// cascade removes every row that it counts. A retirement gives the member a new Jira
// external id, so a retired id is normally not also current; the union counts
// an id in both groups once.
async function countExternalResources(client: PoolClient, tenantId: string): Promise<ExternalResourceInventory> {
  const result = await client.query<Record<string, number>>(
    `
      WITH active_jira AS (
        SELECT pipedream_external_user_id AS id
          FROM user_jira_identities
         WHERE tenant_id = $1 AND pipedream_external_user_id IS NOT NULL
        UNION
        SELECT pipedream_external_user_id FROM user_jira_connections WHERE tenant_id = $1
      ),
      retired_jira AS (
        SELECT DISTINCT pipedream_external_user_id AS id FROM user_jira_cleanups WHERE tenant_id = $1
      )
      SELECT
        (SELECT COUNT(DISTINCT sandbox_id) FROM sessions
          WHERE tenant_id = $1 AND sandbox_id IS NOT NULL)::int AS e2b_sandboxes,
        (SELECT COUNT(*) FROM (SELECT id FROM active_jira UNION SELECT id FROM retired_jira) ids)::int
          AS jira_external_user_ids,
        (SELECT COUNT(*) FROM active_jira)::int AS jira_active_external_user_ids,
        (SELECT COUNT(*) FROM active_jira a
          WHERE NOT EXISTS (
            SELECT 1 FROM user_jira_connections c
             WHERE c.tenant_id = $1 AND c.pipedream_external_user_id = a.id
          ))::int AS jira_active_without_selected_account,
        (SELECT COUNT(DISTINCT pipedream_account_id) FROM user_jira_connections
          WHERE tenant_id = $1)::int AS jira_selected_accounts,
        (SELECT COUNT(*) FROM retired_jira)::int AS jira_retired_pending_cleanup,
        (SELECT COUNT(*) FROM user_jira_cleanups WHERE tenant_id = $1)::int AS jira_pending_cleanups,
        (SELECT COUNT(*) FROM user_github_connections WHERE tenant_id = $1)::int AS github_connections,
        (SELECT COUNT(*) FROM user_notion_connections WHERE tenant_id = $1)::int AS notion_connections,
        (SELECT COUNT(*) FROM user_microsoft_connections WHERE tenant_id = $1)::int AS microsoft_connections,
        (SELECT COUNT(*) FROM member_mcp_credentials
          WHERE tenant_id = $1 AND secret_encrypted IS NOT NULL)::int AS personal_mcp_credentials
    `,
    [tenantId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("External resource count returned no row.");
  const count = (column: string) => Number(row[column] ?? 0);
  return {
    e2bSandboxes: count("e2b_sandboxes"),
    jira: {
      externalUserIds: count("jira_external_user_ids"),
      activeExternalUserIds: count("jira_active_external_user_ids"),
      activeExternalUserIdsWithoutSelectedAccount: count("jira_active_without_selected_account"),
      selectedAccounts: count("jira_selected_accounts"),
      retiredExternalUserIdsPendingCleanup: count("jira_retired_pending_cleanup"),
      pendingCleanups: count("jira_pending_cleanups")
    },
    oauthConnections: {
      github: count("github_connections"),
      notion: count("notion_connections"),
      microsoft: count("microsoft_connections")
    },
    personalMcpCredentials: count("personal_mcp_credentials")
  };
}

// Every column that can store a user id: each foreign key to users from the
// catalog, also from a table with no tenant_id, and the listed columns without
// one. A foreign key to users that does not use user_id stops the deletion,
// because the checks below cannot test it.
async function loadUserReferences(client: PoolClient): Promise<UserReference[]> {
  const foreignKeys = await client.query<{
    constraint_name: string;
    schema_name: string;
    table_name: string;
    column_name: string | null;
    tenant_scoped: boolean;
  }>(
    `
      SELECT con.conname AS constraint_name, n.nspname AS schema_name, c.relname AS table_name,
             (SELECT a.attname
                FROM unnest(con.conkey, con.confkey) AS k(attnum, ref_attnum)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                JOIN pg_attribute r ON r.attrelid = con.confrelid AND r.attnum = k.ref_attnum
               WHERE r.attname = 'user_id') AS column_name,
             EXISTS (
               SELECT 1 FROM pg_attribute t
               WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped
             ) AS tenant_scoped
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE con.contype = 'f' AND con.confrelid = 'public.users'::regclass
      ORDER BY n.nspname, c.relname, con.conname
    `
  );
  const references = new Map<string, UserReference>();
  const add = (reference: UserReference) => references.set(`${reference.table}.${reference.column}`, reference);
  for (const row of foreignKeys.rows) {
    if (!row.column_name) {
      throw new Error(`Foreign key ${row.constraint_name} references users without user_id; tenant deletion cannot check it.`);
    }
    // The identifiers come from PostgreSQL's catalog, not operator input.
    add({
      table: `${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.table_name)}`,
      column: quoteIdentifier(row.column_name),
      tenantScoped: row.tenant_scoped
    });
  }
  for (const [table, column] of USER_ID_COLUMNS_WITHOUT_FOREIGN_KEY) {
    add({ table: `public.${quoteIdentifier(table)}`, column: quoteIdentifier(column), tenantScoped: true });
  }
  return [...references.values()];
}

// The users that a row of the tenant names ($1): members, also former members
// that have no membership or local identity left.
function tenantUserIdsQuery(references: UserReference[]): string {
  return references
    .filter((reference) => reference.tenantScoped)
    .map(({ table, column }) => `SELECT ${column} FROM ${table} WHERE tenant_id = $1`)
    .join("\n UNION ");
}

// Deletes the users in $1 that no row names. Run it after the tenant delete:
// its cascade removed the tenant's rows, so each row that still names a user
// is in another tenant or a table without a tenant. A user delete then causes
// no foreign-key action on any row.
function deleteUnreferencedUsersQuery(references: UserReference[]): string {
  const remaining = references
    .map(({ table, column }) => `SELECT ${column} AS user_id FROM ${table} WHERE ${column} = ANY($1::text[])`)
    .join("\n UNION ALL ");
  return `
    DELETE FROM users u
    WHERE u.user_id = ANY($1::text[])
      AND NOT EXISTS (SELECT 1 FROM (${remaining}) remaining WHERE remaining.user_id = u.user_id)
  `;
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
      const externalResources = await countExternalResources(client, input.tenantId);
      const userReferences = await loadUserReferences(client);
      // Member removal deletes only the membership, so a former member is
      // found through the tenant's other rows. Lock the users rows before the
      // delete checks them: a foreign-key write elsewhere holds FOR KEY SHARE
      // on its users row, so this waits for it, and a later write waits for
      // this transaction. Sorted, so two deletions lock in the same order.
      const userIds = await client.query<{ user_id: string }>(
        `
          SELECT user_id FROM users
          WHERE user_id IN (${tenantUserIdsQuery(userReferences)})
          ORDER BY user_id
          FOR UPDATE
        `,
        [input.tenantId]
      );

      await client.query(
        `
          INSERT INTO tenant_deletion_receipts (
            request_id, tenant_id_hash, status, row_counts, external_resources,
            redis_disposition, third_party_disposition, backup_disposition,
            database_deleted_at
          ) VALUES ($1, $2, 'cleanup_pending', $3::jsonb, $4::jsonb, $5, $6, $7, NOW())
        `,
        [
          input.requestId,
          tenantHash(input.tenantId),
          JSON.stringify(rowCounts),
          JSON.stringify(externalResources),
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
        deleteUnreferencedUsersQuery(userReferences),
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
    // Set when a queued Redis flush did not run or failed in this run.
    let redisDisposition: string | null = null;

    for (const item of pending.rows) {
      try {
        const outcome = await this.cleanupItem(item);
        // Queue removal and its receipt update share one statement. Redis
        // itself is outside this transaction; a failed update leaves a retry.
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
                redis_disposition = CASE
                  WHEN EXISTS (SELECT 1 FROM removed WHERE kind = 'redis_database') THEN $5
                  ELSE redis_disposition
                END,
                last_error = NULL
            WHERE request_id = $1
          `,
          [requestId, item.kind, item.locator, outcome, REDIS_DISPOSITION.flushed]
        );
      } catch (error) {
        // The queue already retains the locator needed for retry. Keep it out
        // of the durable receipt because object keys can contain tenant data.
        const message = `${item.kind}: ${errorMessage(error)}`;
        failures.push(message);
        if (item.kind === "redis_database") {
          redisDisposition = this.deps.flushRedis ? REDIS_DISPOSITION.flushFailed : REDIS_DISPOSITION.flushNotAllowed;
        }
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
    // A replay of a completed request keeps its completion time: the replay
    // did no work, so the receipt must not change.
    await this.deps.db.query(
      `
        UPDATE tenant_deletion_receipts
        SET status = $2,
            completed_at = CASE WHEN $2 = 'completed' THEN COALESCE(completed_at, NOW()) ELSE NULL END,
            last_error = $3,
            redis_disposition = COALESCE($4::text, redis_disposition)
        WHERE request_id = $1
      `,
      [
        requestId,
        remainingCount === 0 ? "completed" : "cleanup_failed",
        failures.length > 0 ? failures.join("\n") : null,
        redisDisposition
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
    // Only an explicit --flush-redis allows a flush, also for a flush that an
    // older version queued without asking.
    if (!this.deps.flushRedis) {
      throw new Error(
        "A Redis flush is queued for this request. Run the command again with --flush-redis to flush the whole Redis database."
      );
    }
    await this.deps.flushRedis();
    return "purged";
  }
}
