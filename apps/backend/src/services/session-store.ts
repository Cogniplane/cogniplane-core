
import { type Pool, withTenantScope, withTransaction } from "../lib/db.js";
import { requireSessionUploadAccess } from "./session-upload-access.js";
import { projectRoleSql, requireProjectAccess } from "./project-access.js";
import { SessionExecutionError } from "./session-execution-store.js";
import type { PoolClient } from "pg";
import { sessionReadAccessSql, sessionTrashAccessSql } from "./session-access.js";
import type { ArtifactStorage } from "./artifacts/artifact-storage.js";
import { uuidv7 } from "../lib/uuid.js";
import { isoTimestamp } from "../lib/db-mappers.js";
import {
  SESSION_TRASH_RETENTION_DAYS,
  SessionCapabilitySelectionSchema,
  type SessionCapabilitiesUpdate
} from "@cogniplane/shared-types";

export type SessionRecord = {
  sessionId: string;
  projectId?: string | null;
  userId: string;
  sessionName: string;
  status: "active" | "archived" | "deleted";
  archivedAt?: string;
  deletedAt?: string;
  canEdit?: boolean;
  // Coarse UI bucket; "skill_improvement" lets the chat shell render an
  // improver-specific banner. Defaults to "normal" everywhere it isn't set.
  // Optional so test fakes constructing partial SessionRecord values keep
  // compiling — production rows always carry a value because the column has
  // a NOT NULL DEFAULT 'normal'.
  purpose?: string;
  createdAt: string;
  updatedAt: string;
  hasPendingApprovals?: boolean;
  isRunning?: boolean;
  activeTurnStartedAt?: string;
  latestTurnId?: string;
  latestTurnSequence?: number;
  hasTurnFailed?: boolean;
};

export type SessionTrashCleanupOptions = {
  batchSize?: number;
  purgeRuntime?: (input: { tenantId: string; sessionId: string; userId: string }) => Promise<void>;
};

type SessionStorageGcRow = {
  tenant_id: string;
  session_id: string;
  storage_key: string;
};

type SessionRuntimeGcRow = {
  tenant_id: string;
  session_id: string;
  user_id: string;
};

function mapSession(row: Record<string, unknown>): SessionRecord {
  const status = row.status;
  if (status !== "active" && status !== "archived" && status !== "deleted") {
    throw new Error("Invalid session status in database");
  }
  const record: SessionRecord = {
    sessionId: String(row.session_id),
    projectId: row.project_id ? String(row.project_id) : null,
    userId: String(row.user_id),
    sessionName: String(row.session_name),
    status,
    purpose: row.purpose ? String(row.purpose) : "normal",
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
  if (row.archived_at) record.archivedAt = isoTimestamp(row.archived_at);
  if (row.deleted_at) record.deletedAt = isoTimestamp(row.deleted_at);
  if (row.can_edit !== undefined) record.canEdit = Boolean(row.can_edit);
  if (row.has_pending_approvals !== undefined) {
    record.hasPendingApprovals = Boolean(row.has_pending_approvals);
  }
  if (row.is_running !== undefined) record.isRunning = Boolean(row.is_running);
  if (row.active_turn_started_at) record.activeTurnStartedAt = isoTimestamp(row.active_turn_started_at);
  if (row.latest_turn_id != null) {
    record.latestTurnId = String(row.latest_turn_id);
    record.latestTurnSequence = Number(row.latest_turn_sequence);
    record.hasTurnFailed = row.latest_turn_status === "error";
  }
  return record;
}

function sessionLifecycleAccessSql(session: string, user: string) {
  return `((${session}.project_id IS NULL AND ${session}.user_id=${user}) OR EXISTS (
    SELECT 1 FROM projects lifecycle_project WHERE lifecycle_project.tenant_id=${session}.tenant_id
      AND lifecycle_project.project_id=${session}.project_id AND lifecycle_project.archived_at IS NULL
      AND ${projectRoleSql("lifecycle_project", user)} IN ('owner','editor')
  ))`;
}

export class SessionStore {
  constructor(
    private readonly db: Pool,
    private readonly maintenanceDb: Pool = db,
    options: { retentionDays?: number } = {},
  ) {
    this.retentionDays = Math.max(0, Math.trunc(options.retentionDays ?? SESSION_TRASH_RETENTION_DAYS));
  }

  private readonly retentionDays: number;

  getRetentionDays(): number {
    return this.retentionDays;
  }

  private async lockLifecycleSession(
    client: PoolClient,
    tenantId: string,
    sessionId: string,
    userId: string,
    options: { checkBusy?: boolean; active?: boolean } = {}
  ) {
    const initial = await client.query("SELECT project_id, user_id FROM sessions WHERE tenant_id=$1 AND session_id=$2", [tenantId, sessionId]);
    if (!initial.rows[0]) return false;
    const projectId = initial.rows[0].project_id as string | null;
    if (projectId) await requireProjectAccess(client, { tenantId, projectId, userId }, "editor", { lock: true, active: options.active ?? true });
    else if (initial.rows[0].user_id !== userId) return false;
    // Admission and assignment also lock project before session.
    const current = await client.query("SELECT project_id, status FROM sessions WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE", [tenantId, sessionId]);
    if (!current.rows[0] || current.rows[0].project_id !== projectId) return false;
    if (projectId && options.checkBusy !== false) {
      const busy = await client.query(`SELECT 1 WHERE EXISTS (
        SELECT 1 FROM session_executions WHERE tenant_id=$1 AND session_id=$2
          AND status='active' AND expires_at>clock_timestamp()
      ) OR EXISTS (SELECT 1 FROM approvals WHERE tenant_id=$1 AND session_id=$2 AND status='pending' AND expires_at>clock_timestamp())`,
      [tenantId, sessionId]);
      if (busy.rowCount) throw new SessionExecutionError("session_busy", 409);
    }
    return { projectId, status: current.rows[0].status as SessionRecord["status"] };
  }

  // Capability selection is readable project metadata, including for viewers.
  // Runtime admission separately requires an active editor execution; this read
  // grants no execution authority and skips the UI's pending-work probes.
  async getCapabilitySelection(tenantId: string, sessionId: string, userId: string) {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT capability_selection FROM sessions s
         WHERE tenant_id = $1 AND session_id = $2 AND ${sessionReadAccessSql("s", "$3")}`,
        [tenantId, sessionId, userId]
      );
      if (!result.rows[0]) throw new Error("Session not found while resolving capabilities");
      return SessionCapabilitySelectionSchema.nullable().parse(result.rows[0].capability_selection);
    });
  }

  async getCapabilities(tenantId: string, sessionId: string, userId: string): Promise<SessionCapabilitiesUpdate & { canEdit: boolean }> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT capability_selection, capability_version,
           (${sessionLifecycleAccessSql("s", "$3")} AND s.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM session_executions e WHERE e.tenant_id=s.tenant_id AND e.session_id=s.session_id AND e.status='active' AND e.expires_at>clock_timestamp())
            AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.tenant_id = s.tenant_id
              AND a.session_id = s.session_id AND a.status = 'pending')
            AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = s.tenant_id
              AND m.session_id = s.session_id AND m.role = 'assistant' AND m.status = 'streaming')) AS can_edit
         FROM sessions s WHERE s.tenant_id = $1 AND s.session_id = $2 AND ${sessionReadAccessSql("s", "$3")}`,
        [tenantId, sessionId, userId]
      );
      if (!result.rows[0]) throw Object.assign(new Error("Session not found while resolving capabilities"), { statusCode: 404 });
      return {
        selection: SessionCapabilitySelectionSchema.nullable().parse(result.rows[0].capability_selection),
        version: Number(result.rows[0].capability_version),
        canEdit: Boolean(result.rows[0].can_edit)
      };
    });
  }

  async setCapabilities(
    tenantId: string, sessionId: string, userId: string, input: SessionCapabilitiesUpdate
  ): Promise<boolean> {
    // Preferences do not change conversation recency or move the sidebar row.
    // capability_version tracks these changes independently of updated_at.
    return withTenantScope(this.db, tenantId, async (client) => {
      if (!await this.lockLifecycleSession(client, tenantId, sessionId, userId)) return false;
      const result = await client.query(
        `UPDATE sessions s SET capability_selection = $4::jsonb,
           capability_version = capability_version + 1
         WHERE s.tenant_id = $1 AND s.session_id = $2 AND ${sessionLifecycleAccessSql("s", "$3")}
           AND s.status = 'active' AND s.capability_version = $5
           AND NOT EXISTS (SELECT 1 FROM session_executions e WHERE e.tenant_id=s.tenant_id AND e.session_id=s.session_id AND e.status='active' AND e.expires_at>clock_timestamp())
            AND NOT EXISTS (SELECT 1 FROM approvals a
             WHERE a.tenant_id = s.tenant_id AND a.session_id = s.session_id AND a.status = 'pending')
           AND NOT EXISTS (SELECT 1 FROM messages m
             WHERE m.tenant_id = s.tenant_id AND m.session_id = s.session_id
               AND m.role = 'assistant' AND m.status = 'streaming')`,
        [tenantId, sessionId, userId, input.selection === null ? null : JSON.stringify(input.selection), input.version]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * Lists active sessions by default, or archived sessions with `status`.
   * By default only `purpose = 'normal'`
   * sessions are returned — improver runs (`skill_improvement`) and any
   * future special-purpose sessions are hidden from the main chat sidebar
   * unless the caller opts in via `purposes`.
   *
   * Pass `purposes: 'all'` (or an explicit list) to include them. Empty
   * list = same as default.
   */
  async list(
    tenantId: string,
    userId: string,
    options: { purposes?: string[] | "all"; status?: "active" | "archived" | "deleted"; projectId?: string } = {}
  ): Promise<SessionRecord[]> {
    const purposes = options.purposes;
    const includeAll = purposes === "all";
    const purposeList = includeAll
      ? null
      : Array.isArray(purposes) && purposes.length > 0
        ? purposes
        : ["normal"];

    return withTenantScope(this.db, tenantId, async (client) => {
      const params: unknown[] = [tenantId, userId, options.status ?? "active"];
      let purposeClause = "";
      if (purposeList) {
        params.push(purposeList);
        purposeClause = `AND s.purpose = ANY($${params.length}::text[])`;
      }
      let projectClause = "";
      if (options.projectId) {
        params.push(options.projectId);
        projectClause = `AND s.project_id = $${params.length}`;
      }
      const sessionRows = await client.query(
        `
          SELECT
            s.session_id,
            s.user_id,
            s.session_name,
            s.status,
            s.archived_at,
            s.deleted_at,
            s.purpose,
            s.project_id,
            s.created_at,
            s.updated_at,
            latest_turn.message_id AS latest_turn_id,
            latest_turn.id AS latest_turn_sequence,
            latest_turn.status AS latest_turn_status,
            EXISTS (
              SELECT 1
              FROM approvals a
              WHERE a.tenant_id = s.tenant_id
                AND a.session_id = s.session_id
                AND a.status = 'pending'
            ) AS has_pending_approvals
            , (${sessionLifecycleAccessSql("s", "$2")}) AS can_edit
            , (EXISTS (
              SELECT 1 FROM session_executions e
              WHERE e.tenant_id=s.tenant_id AND e.session_id=s.session_id
                AND e.status='active' AND e.expires_at>clock_timestamp()
            ) OR EXISTS (
              SELECT 1 FROM messages streaming
              WHERE streaming.tenant_id=s.tenant_id AND streaming.session_id=s.session_id
                AND streaming.role='assistant' AND streaming.status='streaming'
            )) AS is_running
            , (SELECT MIN(e.started_at) FROM session_executions e
               WHERE e.tenant_id=s.tenant_id AND e.session_id=s.session_id AND e.status='active') AS active_turn_started_at
          FROM sessions s
          LEFT JOIN LATERAL (
            SELECT m.message_id, m.id, m.status
            FROM messages m
            WHERE m.tenant_id = s.tenant_id AND m.session_id = s.session_id
              AND m.role = 'assistant'
            ORDER BY m.id DESC
            LIMIT 1
          ) latest_turn ON TRUE
          WHERE s.tenant_id = $1 AND ${options.status === "deleted"
            ? sessionTrashAccessSql("s", "$2")
            : sessionReadAccessSql("s", "$2")} AND s.status = $3
            ${purposeClause}
            ${projectClause}
          ORDER BY s.updated_at DESC
        `,
        params
      );
      return sessionRows.rows.map(mapSession);
    });
  }

  async create(
    tenantId: string,
    userId: string,
    sessionName: string,
    options: { purpose?: string } = {}
  ): Promise<SessionRecord> {
    const sessionId = uuidv7();
    const purpose = options.purpose ?? "normal";
    return withTenantScope(this.db, tenantId, async (client) => {
      const insertedSession = await client.query(
        `
          INSERT INTO sessions (session_id, tenant_id, user_id, session_name, purpose)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING session_id, user_id, session_name, status, archived_at, deleted_at, purpose, project_id, created_at, updated_at
        `,
        [sessionId, tenantId, userId, sessionName, purpose]
      );
      return mapSession(insertedSession.rows[0]);
    });
  }

  async getReadable(tenantId: string, sessionId: string, userId: string): Promise<SessionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT s.session_id, s.project_id, s.user_id, s.session_name, s.status,
                s.archived_at, s.deleted_at, s.purpose, s.created_at, s.updated_at,
                (${sessionLifecycleAccessSql("s", "$3")}) AS can_edit FROM sessions s
         WHERE s.tenant_id = $1 AND s.session_id = $2 AND ${sessionReadAccessSql("s", "$3")}`,
        [tenantId, sessionId, userId]
      );
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    });
  }

  async requireUploadAccess(tenantId: string, sessionId: string, userId: string): Promise<string | null> {
    return withTenantScope(this.db, tenantId, client =>
      requireSessionUploadAccess(client, { tenantId, sessionId, userId }));
  }

  async getOwned(tenantId: string, sessionId: string, userId: string): Promise<SessionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const sessionRows = await client.query(
        `
          SELECT session_id, user_id, session_name, status, archived_at, deleted_at, purpose, project_id, created_at, updated_at,
                 TRUE AS can_edit
          FROM sessions
          WHERE tenant_id = $1 AND session_id = $2 AND user_id = $3
          LIMIT 1
        `,
        [tenantId, sessionId, userId]
      );
      return sessionRows.rows[0] ? mapSession(sessionRows.rows[0]) : null;
    });
  }

  async rename(tenantId: string, sessionId: string, userId: string, sessionName: string): Promise<SessionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const renamedSession = await client.query(
        `
          UPDATE sessions s
          SET session_name = $4, updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2 AND ${sessionLifecycleAccessSql("s", "$3")} AND status = 'active'
          RETURNING session_id, user_id, session_name, status, archived_at, deleted_at, purpose, project_id, created_at, updated_at
        `,
        [tenantId, sessionId, userId, sessionName]
      );
      return renamedSession.rows[0] ? mapSession(renamedSession.rows[0]) : null;
    });
  }

  async renameIfCurrent(
    tenantId: string,
    sessionId: string,
    userId: string,
    expectedCurrentName: string,
    newName: string
  ): Promise<SessionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const renamedSession = await client.query(
        `
          UPDATE sessions s
          SET session_name = $5, updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2 AND ${sessionLifecycleAccessSql("s", "$3")} AND status = 'active'
            AND session_name = $4
          RETURNING session_id, user_id, session_name, status, archived_at, deleted_at, purpose, project_id, created_at, updated_at
        `,
        [tenantId, sessionId, userId, expectedCurrentName, newName]
      );
      return renamedSession.rows[0] ? mapSession(renamedSession.rows[0]) : null;
    });
  }

  async setArchived(
    tenantId: string, sessionId: string, userId: string, archived: boolean
  ): Promise<SessionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const locked = await this.lockLifecycleSession(client, tenantId, sessionId, userId, { checkBusy: false, active: false });
      if (!locked) return null;
      const targetStatus = archived ? "archived" : "active";
      if (locked.status === targetStatus) {
        const current = await client.query(
          `SELECT session_id, user_id, session_name, status, archived_at, deleted_at, purpose, project_id, created_at, updated_at
           FROM sessions WHERE tenant_id=$1 AND session_id=$2`,
          [tenantId, sessionId]
        );
        return current.rows[0] ? mapSession(current.rows[0]) : null;
      }
      if (locked.projectId) {
        await requireProjectAccess(client, { tenantId, projectId: locked.projectId, userId }, "editor", { active: true });
      }
      if (locked.projectId) {
        const busy = await client.query(`SELECT 1 WHERE EXISTS (
          SELECT 1 FROM session_executions WHERE tenant_id=$1 AND session_id=$2
            AND status='active' AND expires_at>clock_timestamp()
        ) OR EXISTS (SELECT 1 FROM approvals WHERE tenant_id=$1 AND session_id=$2 AND status='pending' AND expires_at>clock_timestamp())`,
        [tenantId, sessionId]);
        if (busy.rowCount) throw new SessionExecutionError("session_busy", 409);
      }
      const result = await client.query(
        `UPDATE sessions s
         SET status = $4, archived_at = CASE WHEN $4 = 'archived' THEN NOW() ELSE NULL END,
             deleted_at = NULL, updated_at = NOW()
         WHERE s.tenant_id = $1 AND s.session_id = $2 AND ${sessionLifecycleAccessSql("s", "$3")}
           AND s.status = $5 AND s.purpose <> 'project_reference'
           AND ($4 <> 'archived' OR NOT EXISTS (
             SELECT 1 FROM approvals a WHERE a.tenant_id = s.tenant_id
               AND a.session_id = s.session_id AND a.status = 'pending'
           ))
         RETURNING session_id, user_id, session_name, status, archived_at, deleted_at, purpose, project_id, created_at, updated_at`,
        [tenantId, sessionId, userId, archived ? "archived" : "active", archived ? "active" : "archived"]
      );
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    });
  }

  async remove(tenantId: string, sessionId: string, userId: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      if (!await this.lockLifecycleSession(client, tenantId, sessionId, userId)) return false;
      const removalUpdate = await client.query(
        `
          UPDATE sessions s
          SET status = 'deleted', deleted_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2 AND ${sessionLifecycleAccessSql("s", "$3")}
            AND status IN ('active', 'archived') AND purpose <> 'project_reference'
        `,
        [tenantId, sessionId, userId]
      );
      return (removalUpdate.rowCount ?? 0) > 0;
    });
  }

  async restoreDeleted(tenantId: string, sessionId: string, userId: string): Promise<SessionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      if (this.retentionDays === 0) return null;
      const locked = await this.lockLifecycleSession(client, tenantId, sessionId, userId, {
        checkBusy: false,
        active: true,
      });
      if (!locked || locked.status !== "deleted") return null;
      const restored = await client.query(
        `UPDATE sessions SET status=CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END,
             deleted_at=NULL, updated_at=NOW()
         WHERE tenant_id=$1 AND session_id=$2 AND status='deleted'
           AND deleted_at > NOW() - ($3 * INTERVAL '1 day')
         RETURNING session_id, user_id, session_name, status, archived_at, deleted_at, purpose, project_id, created_at, updated_at`,
        [tenantId, sessionId, this.retentionDays],
      );
      return restored.rows[0] ? mapSession(restored.rows[0]) : null;
    });
  }

  async cleanupExpired(
    storage: Pick<ArtifactStorage, "delete">,
    options: SessionTrashCleanupOptions = {},
  ): Promise<{ deletedSessions: number; deletedObjects: number; purgedRuntimes: number }> {
    const limit = options.batchSize ?? 100;
    const committed = await withTransaction(this.maintenanceDb, async (db) => {
      const candidates = await db.query<{
        tenant_id: string;
        session_id: string;
        user_id: string;
      }>(
        `SELECT tenant_id, session_id, user_id
         FROM sessions
         WHERE status='deleted' AND deleted_at <= NOW() - ($2 * INTERVAL '1 day')
         ORDER BY deleted_at, session_id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit, this.retentionDays],
      );
      let deletedSessions = 0;
      for (const candidate of candidates.rows) {
        const artifacts = await db.query<{ storage_key: string }>(
          `SELECT DISTINCT storage_key FROM artifacts
           WHERE tenant_id=$1 AND session_id=$2 AND storage_key IS NOT NULL`,
          [candidate.tenant_id, candidate.session_id],
        );
        for (const artifact of artifacts.rows) {
          await db.query(
            `INSERT INTO session_storage_gc (tenant_id, session_id, storage_key)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [candidate.tenant_id, candidate.session_id, artifact.storage_key],
          );
        }
        await db.query(
          `INSERT INTO session_runtime_gc (tenant_id, session_id, user_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [candidate.tenant_id, candidate.session_id, candidate.user_id],
        );

        // These legacy foreign keys predate the session cascade rules. Remove
        // their rows explicitly before deleting the session itself.
        await db.query(
          `DELETE FROM messages WHERE tenant_id=$1 AND session_id=$2`,
          [candidate.tenant_id, candidate.session_id],
        );
        await db.query(
          `DELETE FROM runtime_sessions WHERE tenant_id=$1 AND session_id=$2`,
          [candidate.tenant_id, candidate.session_id],
        );
        await db.query(
          `DELETE FROM session_executions WHERE tenant_id=$1 AND session_id=$2`,
          [candidate.tenant_id, candidate.session_id],
        );
        const deleted = await db.query(
          `DELETE FROM sessions
           WHERE tenant_id=$1 AND session_id=$2 AND status='deleted'
             AND deleted_at <= NOW() - ($3 * INTERVAL '1 day')`,
          [candidate.tenant_id, candidate.session_id, this.retentionDays],
        );
        deletedSessions += deleted.rowCount ?? 0;
      }

      const storageGc = await db.query<SessionStorageGcRow>(
        `WITH candidates AS (
           SELECT tenant_id, session_id, storage_key
           FROM session_storage_gc
           WHERE next_attempt_at <= NOW()
           ORDER BY next_attempt_at, created_at, tenant_id, session_id, storage_key
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE session_storage_gc AS gc
         SET attempts=gc.attempts+1, next_attempt_at=NOW() + INTERVAL '1 hour'
         FROM candidates
         WHERE gc.tenant_id=candidates.tenant_id
           AND gc.session_id=candidates.session_id
           AND gc.storage_key=candidates.storage_key
         RETURNING gc.tenant_id, gc.session_id, gc.storage_key`,
        [limit],
      );
      const runtimeGc = await db.query<SessionRuntimeGcRow>(
        `WITH candidates AS (
           SELECT tenant_id, session_id, user_id
           FROM session_runtime_gc
           WHERE next_attempt_at <= NOW()
           ORDER BY next_attempt_at, created_at, tenant_id, session_id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE session_runtime_gc AS gc
         SET attempts=gc.attempts+1, next_attempt_at=NOW() + INTERVAL '1 hour'
         FROM candidates
         WHERE gc.tenant_id=candidates.tenant_id AND gc.session_id=candidates.session_id
         RETURNING gc.tenant_id, gc.session_id, gc.user_id`,
        [limit],
      );
      return { deletedSessions, storageGc: storageGc.rows, runtimeGc: runtimeGc.rows };
    });

    let deletedObjects = 0;
    for (const pending of committed.storageGc) {
      const refs = await this.maintenanceDb.query(
        // Storage keys are global object pointers and may be referenced by any
        // tenant. Download-token rows cascade with their artifact/session, so
        // artifact rows and project-file versions are the durable references.
        `SELECT 1 FROM project_file_versions
           WHERE storage_key=$1
         UNION ALL SELECT 1 FROM artifacts
           WHERE storage_key=$1 AND status <> 'deleted'
         LIMIT 1`,
        [pending.storage_key],
      );
      if (refs.rowCount) {
        await this.maintenanceDb.query(
          `DELETE FROM session_storage_gc
           WHERE tenant_id=$1 AND session_id=$2 AND storage_key=$3`,
          [pending.tenant_id, pending.session_id, pending.storage_key],
        );
        continue;
      }
      try {
        await storage.delete(pending.storage_key);
        const removed = await this.maintenanceDb.query(
          `DELETE FROM session_storage_gc
           WHERE tenant_id=$1 AND session_id=$2 AND storage_key=$3
             AND NOT EXISTS (
               SELECT 1 FROM project_file_versions
               WHERE storage_key=$3
             )
             AND NOT EXISTS (
               SELECT 1 FROM artifacts
               WHERE storage_key=$3 AND status <> 'deleted'
             )`,
          [pending.tenant_id, pending.session_id, pending.storage_key],
        );
        deletedObjects += removed.rowCount ?? 0;
      } catch (error) {
        await this.maintenanceDb.query(
          `UPDATE session_storage_gc
           SET next_attempt_at=NOW() + LEAST(INTERVAL '1 hour', INTERVAL '1 minute' * power(2, LEAST(attempts, 6))),
               last_error=$4
           WHERE tenant_id=$1 AND session_id=$2 AND storage_key=$3`,
          [pending.tenant_id, pending.session_id, pending.storage_key, error instanceof Error ? error.message : String(error)],
        );
      }
    }

    let purgedRuntimes = 0;
    if (options.purgeRuntime) {
      for (const pending of committed.runtimeGc) {
        try {
          await options.purgeRuntime({
            tenantId: pending.tenant_id,
            sessionId: pending.session_id,
            userId: pending.user_id,
          });
          const removed = await this.maintenanceDb.query(
            `DELETE FROM session_runtime_gc WHERE tenant_id=$1 AND session_id=$2`,
            [pending.tenant_id, pending.session_id],
          );
          purgedRuntimes += removed.rowCount ?? 0;
        } catch (error) {
          await this.maintenanceDb.query(
            `UPDATE session_runtime_gc
             SET next_attempt_at=NOW() + LEAST(INTERVAL '1 hour', INTERVAL '1 minute' * power(2, LEAST(attempts, 6))),
                 last_error=$3
             WHERE tenant_id=$1 AND session_id=$2`,
            [pending.tenant_id, pending.session_id, error instanceof Error ? error.message : String(error)],
          );
        }
      }
    }
    return { deletedSessions: committed.deletedSessions, deletedObjects, purgedRuntimes };
  }
}
