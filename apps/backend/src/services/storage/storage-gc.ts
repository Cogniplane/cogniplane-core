import type { PoolClient } from "pg";

import { type Pool, withTransaction } from "../../lib/db.js";
import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { SkillBundleStorage } from "../skills/skill-bundle-storage.js";

import { artifactObjectReferencedSql, skillBundleReferencedSql } from "./storage-references.js";

/**
 * Cleanup queues for stored objects. A database change that drops the last
 * pointer to an object writes a queue row in its own transaction. The object
 * delete runs after the commit, and the row stays until the delete succeeds
 * or a live reference owns the object again. So a storage error or a process
 * stop between the two keeps the locator for a retry.
 *
 * The scheduler worker drains the session, project-file and skill-bundle
 * storage queues on each tick (`StorageGc.drain`).
 * It does not depend on the retention settings or on SCHEDULER_ENABLED.
 */

type Queryable = Pick<PoolClient, "query">;

/** Queues of artifact storage keys, with the column that names the owner of each row. */
export const ARTIFACT_OBJECT_QUEUES = {
  session_storage_gc: "session_id",
  project_file_storage_gc: "project_id"
} as const;
export type ArtifactObjectQueue = keyof typeof ARTIFACT_OBJECT_QUEUES;

export type ArtifactObjectGcRow = {
  queue: ArtifactObjectQueue;
  tenantId: string;
  /** The session or project of the row: the `ARTIFACT_OBJECT_QUEUES` column. */
  ownerId: string;
  storageKey: string;
};

export type SkillBundleGcRow = { tenantId: string; storageUri: string };

/**
 * - `deleted`: this call deleted the object and removed the queue row.
 * - `retained`: a live reference owns the object; the queue row is gone and
 *   the object stays.
 * - `pending`: the queue row stays for a later pass, for example after a
 *   storage error.
 */
export type StorageGcOutcome = "deleted" | "retained" | "pending";

// A claim takes a row for one hour, so a parallel pass skips it. A failed
// delete brings it back sooner, with exponential backoff up to one hour.
const LEASE_SQL = "NOW() + INTERVAL '1 hour'";
const BACKOFF_SQL = "NOW() + LEAST(INTERVAL '1 hour', INTERVAL '1 minute' * power(2, LEAST(attempts, 6)))";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Queues an artifact object of a session in the caller's transaction. With
 * `leased`, the caller deletes it right after the commit: the row starts with
 * a claim, so the worker takes it only if that attempt does not finish.
 */
export async function enqueueSessionStorageGc(
  client: Queryable,
  row: { tenantId: string; sessionId: string; storageKey: string; leased?: boolean }
): Promise<void> {
  await client.query(
    `INSERT INTO session_storage_gc (tenant_id, session_id, storage_key, attempts, next_attempt_at)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN 1 ELSE 0 END, CASE WHEN $4 THEN ${LEASE_SQL} ELSE NOW() END)
     ON CONFLICT DO NOTHING`,
    [row.tenantId, row.sessionId, row.storageKey, row.leased === true]
  );
}

/** Queues a skill bundle in the caller's transaction. `leased`: as for `enqueueSessionStorageGc`. */
export async function enqueueSkillBundleGc(
  client: Queryable,
  row: { tenantId: string; storageUri: string; leased?: boolean }
): Promise<void> {
  await client.query(
    `INSERT INTO skill_bundle_storage_gc (tenant_id, storage_uri, attempts, next_attempt_at)
     VALUES ($1, $2, CASE WHEN $3 THEN 1 ELSE 0 END, CASE WHEN $3 THEN ${LEASE_SQL} ELSE NOW() END)
     ON CONFLICT DO NOTHING`,
    [row.tenantId, row.storageUri, row.leased === true]
  );
}

/** Leases due rows of one artifact object queue, in every tenant. */
export async function claimArtifactObjectGc(
  db: Queryable,
  queue: ArtifactObjectQueue,
  limit: number
): Promise<ArtifactObjectGcRow[]> {
  const owner = ARTIFACT_OBJECT_QUEUES[queue];
  const claimed = await db.query<{ tenant_id: string; owner_id: string; storage_key: string }>(
    `WITH candidates AS (
       SELECT tenant_id, ${owner}, storage_key
       FROM ${queue}
       WHERE next_attempt_at <= NOW()
       ORDER BY next_attempt_at, created_at, tenant_id, ${owner}, storage_key
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE ${queue} AS gc
     SET attempts = gc.attempts + 1, next_attempt_at = ${LEASE_SQL}
     FROM candidates
     WHERE gc.tenant_id = candidates.tenant_id
       AND gc.${owner} = candidates.${owner}
       AND gc.storage_key = candidates.storage_key
     RETURNING gc.tenant_id, gc.${owner} AS owner_id, gc.storage_key`,
    [limit]
  );
  return claimed.rows.map((row) => ({
    queue,
    tenantId: String(row.tenant_id),
    ownerId: String(row.owner_id),
    storageKey: String(row.storage_key)
  }));
}

/**
 * Deletes one queued artifact object when no live row in any tenant
 * references it (`artifactObjectReferencedSql`). `db` must see every tenant:
 * pass the maintenance pool.
 */
export async function collectArtifactObject(
  db: Queryable,
  storage: Pick<ArtifactStorage, "delete">,
  row: ArtifactObjectGcRow
): Promise<StorageGcOutcome> {
  const owner = ARTIFACT_OBJECT_QUEUES[row.queue];
  const key = [row.tenantId, row.ownerId, row.storageKey];
  const referenced = await db.query<{ referenced: boolean }>(
    `SELECT ${artifactObjectReferencedSql("$1")} AS referenced`,
    [row.storageKey]
  );
  if (referenced.rows[0]?.referenced === true) {
    await db.query(
      `DELETE FROM ${row.queue} WHERE tenant_id = $1 AND ${owner} = $2 AND storage_key = $3`,
      key
    );
    return "retained";
  }
  try {
    await storage.delete(row.storageKey);
  } catch (error) {
    await db.query(
      `UPDATE ${row.queue} SET next_attempt_at = ${BACKOFF_SQL}, last_error = $4
       WHERE tenant_id = $1 AND ${owner} = $2 AND storage_key = $3`,
      [...key, errorText(error)]
    );
    return "pending";
  }
  // A reference that a copy added after the check keeps the row; the next
  // pass sees it and drops the row.
  const removed = await db.query(
    `DELETE FROM ${row.queue}
     WHERE tenant_id = $1 AND ${owner} = $2 AND storage_key = $3
       AND NOT ${artifactObjectReferencedSql("$3")}`,
    key
  );
  return removed.rowCount ? "deleted" : "pending";
}

/**
 * Leases rows of the skill bundle queue. Without `tenantId`: due rows of
 * every tenant (the worker). With `tenantId`: every row of that tenant, also
 * rows in backoff, because an admin asked for the cleanup now.
 */
export async function claimSkillBundleGc(
  db: Queryable,
  limit: number,
  tenantId?: string
): Promise<SkillBundleGcRow[]> {
  const claimed = await db.query<{ tenant_id: string; storage_uri: string }>(
    `WITH candidates AS (
       SELECT tenant_id, storage_uri
       FROM skill_bundle_storage_gc
       WHERE ${tenantId === undefined ? "next_attempt_at <= NOW()" : "tenant_id = $2"}
       ORDER BY next_attempt_at, created_at, tenant_id, storage_uri
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE skill_bundle_storage_gc AS gc
     SET attempts = gc.attempts + 1, next_attempt_at = ${LEASE_SQL}
     FROM candidates
     WHERE gc.tenant_id = candidates.tenant_id AND gc.storage_uri = candidates.storage_uri
     RETURNING gc.tenant_id, gc.storage_uri`,
    tenantId === undefined ? [limit] : [limit, tenantId]
  );
  return claimed.rows.map((row) => ({ tenantId: String(row.tenant_id), storageUri: String(row.storage_uri) }));
}

/**
 * Deletes one queued bundle when no revision in any tenant names it
 * (`skillBundleReferencedSql`). Pass the maintenance pool.
 */
export async function collectSkillBundle(
  db: Queryable,
  storage: Pick<SkillBundleStorage, "deleteBundle">,
  row: SkillBundleGcRow
): Promise<StorageGcOutcome> {
  const key = [row.tenantId, row.storageUri];
  const referenced = await db.query<{ referenced: boolean }>(
    `SELECT ${skillBundleReferencedSql("$1")} AS referenced`,
    [row.storageUri]
  );
  if (referenced.rows[0]?.referenced === true) {
    await db.query(`DELETE FROM skill_bundle_storage_gc WHERE tenant_id = $1 AND storage_uri = $2`, key);
    return "retained";
  }
  try {
    await storage.deleteBundle(row.storageUri);
  } catch (error) {
    await db.query(
      `UPDATE skill_bundle_storage_gc SET next_attempt_at = ${BACKOFF_SQL}, last_error = $3
       WHERE tenant_id = $1 AND storage_uri = $2`,
      [...key, errorText(error)]
    );
    return "pending";
  }
  const removed = await db.query(
    `DELETE FROM skill_bundle_storage_gc
     WHERE tenant_id = $1 AND storage_uri = $2 AND NOT ${skillBundleReferencedSql("$2")}`,
    key
  );
  return removed.rowCount ? "deleted" : "pending";
}

export type StorageGcDrainResult = {
  deletedObjects: number;
  deletedBundles: number;
  /** Rows that stay queued after this pass, for example after a storage error. */
  pending: number;
};

type StorageGcLogger = { warn(payload: unknown, message: string): void };

/**
 * Drains the storage cleanup queues of every tenant. The reference checks
 * read every tenant, so `maintenanceDb` is the maintenance pool
 * (`maintenance_user`, BYPASSRLS). Each statement names its rows by tenant
 * id; it never reads a tenant's data.
 */
export class StorageGc {
  constructor(
    private readonly deps: {
      maintenanceDb: Pool;
      artifactStorage: Pick<ArtifactStorage, "delete">;
      skillBundleStorage: Pick<SkillBundleStorage, "deleteBundle">;
      logger?: StorageGcLogger;
    }
  ) {}

  async drain(batchSize = 100): Promise<StorageGcDrainResult> {
    const result: StorageGcDrainResult = { deletedObjects: 0, deletedBundles: 0, pending: 0 };
    for (const queue of Object.keys(ARTIFACT_OBJECT_QUEUES) as ArtifactObjectQueue[]) {
      const rows = await withTransaction(this.deps.maintenanceDb, (db) => claimArtifactObjectGc(db, queue, batchSize));
      for (const row of rows) {
        const outcome = await this.collectArtifactObject(row);
        if (outcome === "deleted") result.deletedObjects += 1;
        if (outcome === "pending") result.pending += 1;
      }
    }
    const bundles = await withTransaction(this.deps.maintenanceDb, (db) => claimSkillBundleGc(db, batchSize));
    for (const row of bundles) {
      const outcome = await this.collectSkillBundle(row);
      if (outcome === "deleted") result.deletedBundles += 1;
      if (outcome === "pending") result.pending += 1;
    }
    return result;
  }

  /** Tries one queued artifact object now. A failure stays queued for `drain`. */
  async collectArtifactObject(row: ArtifactObjectGcRow): Promise<StorageGcOutcome> {
    try {
      return await collectArtifactObject(this.deps.maintenanceDb, this.deps.artifactStorage, row);
    } catch (error) {
      // A database error: the row keeps its lease and comes back after it.
      this.deps.logger?.warn({ err: error, tenantId: row.tenantId, queue: row.queue },
        "Storage cleanup of an artifact object failed; it stays queued");
      return "pending";
    }
  }

  async collectSkillBundle(row: SkillBundleGcRow): Promise<StorageGcOutcome> {
    try {
      return await collectSkillBundle(this.deps.maintenanceDb, this.deps.skillBundleStorage, row);
    } catch (error) {
      this.deps.logger?.warn({ err: error, tenantId: row.tenantId },
        "Storage cleanup of a skill bundle failed; it stays queued");
      return "pending";
    }
  }

  /**
   * Tries every queued bundle of one tenant now, for an admin's revision
   * cleanup. Returns the outcome by URI.
   */
  async retryTenantSkillBundles(tenantId: string, limit = 100): Promise<Map<string, StorageGcOutcome>> {
    // The maintenance pool, with the tenant predicate in the claim: the
    // reference check of each row must read every tenant.
    const rows = await withTransaction(this.deps.maintenanceDb, (db) => claimSkillBundleGc(db, limit, tenantId));
    const outcomes = new Map<string, StorageGcOutcome>();
    for (const row of rows) outcomes.set(row.storageUri, await this.collectSkillBundle(row));
    return outcomes;
  }
}
