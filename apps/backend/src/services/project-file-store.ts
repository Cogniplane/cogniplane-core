import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { Readable } from "node:stream";
import type { PoolClient } from "pg";
import type {
  ProjectFile,
  ProjectFileCreate,
  ProjectFileVersion,
  ProjectFolder,
  ProjectLibrary,
} from "@cogniplane/shared-types";
import {
  ProjectFileCreateSchema,
  ProjectFileLocationSchema,
  ProjectEntryNameSchema,
} from "@cogniplane/shared-types";
import { withTenantScope, withTransaction, type Pool } from "../lib/db.js";
import { uuidv7 } from "../lib/uuid.js";
import { requireProjectAccess } from "./project-access.js";
import type { AuditEventType } from "./audit-event-types.js";
import { isoTimestamp } from "../lib/db-mappers.js";
import { ALLOWED_ARTIFACT_MIME_TYPES } from "../lib/allowed-mime-types.js";
import type {
  ArtifactStorage,
  StoredArtifact,
} from "./artifacts/artifact-storage.js";
import type { PiiProtectionService } from "./pii/pii-protection-service.js";
import { isTextReadableArtifact, readStreamAsBoundedText } from "./artifacts/artifact-helpers.js";

export type ProjectFileActor = {
  tenantId: string;
  userId: string;
  projectId: string;
};
export type ProjectFileCreatedByType = "user" | "agent";
export const MAX_PROJECT_FILE_SELECTIONS = 20;
export const MAX_PROJECT_RUNTIME_SNAPSHOT_FILES = 200;
export const MAX_PROJECT_RECONCILIATION_CHARS = 100_000;
export type ProjectRuntimeFileSnapshotEntry = {
  fileId: string;
  versionId: string;
  versionNumber: number;
  folderId: string | null;
  name: string;
  mimeType: string;
  kind: "published" | "draft";
  selected: boolean;
};
export type ProjectRuntimeFileSnapshot = {
  projectId: string;
  capturedAt: string;
  files: ProjectRuntimeFileSnapshotEntry[];
  truncated: boolean;
};
export type ProjectConflictContext = {
  draftId: string;
  targetFileId: string;
  name: string;
  folderId: string | null;
  mimeType: string;
  baseVersionId: string;
  baseVersionNumber: number;
  latestVersionId: string;
  latestVersionNumber: number;
  proposedContent: string;
  baseContent: string;
  latestContent: string;
};
export type ProjectConflictMetadata = Omit<
  ProjectConflictContext,
  "proposedContent" | "baseContent" | "latestContent"
>;
export class ProjectFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const missing = () =>
  new ProjectFileError(
    "project_file_not_found",
    "This project file is unavailable.",
    404,
  );
// Store callers, including the agent runtime, must not depend on HTTP validation.
function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ProjectFileError(
      "invalid_request",
      result.error.issues[0]?.message ?? "Invalid project file input.",
      400,
    );
  return result.data;
}
type Row = Record<string, unknown>;
function version(row: Row): ProjectFileVersion {
  return {
    versionId: String(row.version_id),
    fileId: String(row.file_id),
    versionNumber: Number(row.version_number),
    mimeType: String(row.mime_type),
    fileSizeBytes: Number(row.file_size_bytes),
    checksumSha256: String(row.checksum_sha256),
    createdBy: String(row.version_created_by ?? row.created_by),
    createdAt: isoTimestamp(row.version_created_at ?? row.created_at),
    restoredFromVersionId: row.restored_from_version_id
      ? String(row.restored_from_version_id)
      : null,
  };
}
function file(row: Row): ProjectFile {
  if (row.kind !== "published" && row.kind !== "draft")
    throw new Error(
      "Unexpected project file kind returned by the store query.",
    );
  return {
    fileId: String(row.file_id),
    folderId: row.folder_id ? String(row.folder_id) : null,
    name: String(row.name),
    kind: row.kind,
    targetFileId: row.target_file_id ? String(row.target_file_id) : null,
    baseVersionId: row.base_version_id ? String(row.base_version_id) : null,
    createdByType: row.created_by_type === "agent" ? "agent" : "user",
    trashedAt: row.trashed_at ? isoTimestamp(row.trashed_at) : null,
    updatedAt: isoTimestamp(row.updated_at),
    version: version(row),
  };
}
function folder(row: Row): ProjectFolder {
  return {
    folderId: String(row.folder_id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    name: String(row.name),
    deletedAt: row.deleted_at ? isoTimestamp(row.deleted_at) : null,
  };
}
const joinedFileColumns = `f.*, v.*, v.created_at AS version_created_at, v.created_by AS version_created_by`;
const joinedFiles = `SELECT ${joinedFileColumns}
  FROM project_files f JOIN project_file_versions v USING (tenant_id, project_id, file_id)
  WHERE f.tenant_id = $1 AND f.project_id = $2 AND v.version_id = f.current_version_id`;
const joinedFilesWithCount = `SELECT ${joinedFileColumns}, COUNT(*) OVER() AS total_count
  FROM project_files f JOIN project_file_versions v USING (tenant_id, project_id, file_id)
  WHERE f.tenant_id = $1 AND f.project_id = $2 AND v.version_id = f.current_version_id`;

export class ProjectFileStore {
  private piiProtection: Pick<PiiProtectionService, "evaluateArtifact"> | undefined;

  constructor(
    private readonly db: Pool,
    private readonly logger: Pick<FastifyBaseLogger, "warn">,
    private readonly maintenanceDb: Pool = db,
  ) {}

  /**
   * Remove expired Trash and superseded promotion rows, then retry storage
   * deletion for objects that no longer have a project or artifact reference.
   * Database cleanup commits before object deletion so a transient bucket
   * failure leaves a durable GC row for the next worker tick.
   */
  async cleanupExpired(
    storage: Pick<ArtifactStorage, "delete">,
    batchSize = 100,
  ): Promise<{ deletedFiles: number; deletedObjects: number }> {
    const result = await withTransaction(this.maintenanceDb, async (db) => {
      const roots = await db.query(
        `SELECT tenant_id, project_id, file_id FROM project_files
         WHERE kind = 'promoted' OR (trashed_at IS NOT NULL AND trashed_at < NOW() - INTERVAL '30 days')
         ORDER BY updated_at, file_id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      const doomed = new Map<string, { tenantId: string; projectId: string; fileId: string }>();
      for (const row of roots.rows) {
        const entry = {
          tenantId: String(row.tenant_id),
          projectId: String(row.project_id),
          fileId: String(row.file_id),
        };
        doomed.set(`${entry.tenantId}:${entry.projectId}:${entry.fileId}`, entry);
      }
      if (doomed.size) {
        const rootIds = [...doomed.values()];
        const placeholders = rootIds.map((_, index) =>
          `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`).join(",");
        const params = rootIds.flatMap((entry) => [entry.tenantId, entry.projectId, entry.fileId]);
        const dependent = await db.query(
          `SELECT f.tenant_id, f.project_id, f.file_id
           FROM project_files f
           JOIN (VALUES ${placeholders}) AS roots(tenant_id, project_id, file_id)
             ON roots.tenant_id=f.tenant_id AND roots.project_id=f.project_id AND roots.file_id=f.target_file_id
           FOR UPDATE`,
          params,
        );
        for (const row of dependent.rows) {
          const entry = {
            tenantId: String(row.tenant_id),
            projectId: String(row.project_id),
            fileId: String(row.file_id),
          };
          doomed.set(`${entry.tenantId}:${entry.projectId}:${entry.fileId}`, entry);
        }
      }
      const doomedFiles = [...doomed.values()];
      if (doomedFiles.length) {
        const placeholders = doomedFiles.map((_, index) =>
          `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`).join(",");
        const params = doomedFiles.flatMap((entry) => [entry.tenantId, entry.projectId, entry.fileId]);
        await db.query(
        `INSERT INTO project_file_storage_gc (tenant_id, project_id, storage_key)
         SELECT DISTINCT v.tenant_id, v.project_id, v.storage_key
         FROM project_file_versions v
           JOIN (VALUES ${placeholders}) AS doomed(tenant_id, project_id, file_id)
             ON doomed.tenant_id=v.tenant_id AND doomed.project_id=v.project_id AND doomed.file_id=v.file_id
         WHERE NOT EXISTS (
           SELECT 1 FROM project_file_versions live
           WHERE live.storage_key=v.storage_key
             AND NOT EXISTS (
               SELECT 1 FROM (VALUES ${placeholders}) AS removed(tenant_id, project_id, file_id)
               WHERE removed.tenant_id=live.tenant_id AND removed.project_id=live.project_id
                 AND removed.file_id=live.file_id
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM artifacts a
           WHERE a.storage_key=v.storage_key AND a.status <> 'deleted'
         )
         ON CONFLICT DO NOTHING`,
          params,
        );
        await db.query(
        `UPDATE project_files f SET target_file_id=NULL, base_version_id=NULL
         FROM (VALUES ${placeholders}) AS doomed(tenant_id, project_id, file_id)
         WHERE f.tenant_id=doomed.tenant_id AND f.project_id=doomed.project_id AND f.file_id=doomed.file_id`,
          params,
        );
        await db.query(
        `DELETE FROM project_file_versions v
         USING (VALUES ${placeholders}) AS doomed(tenant_id, project_id, file_id)
         WHERE v.tenant_id=doomed.tenant_id AND v.project_id=doomed.project_id AND v.file_id=doomed.file_id`,
          params,
        );
        await db.query(
        `DELETE FROM project_files f
         USING (VALUES ${placeholders}) AS doomed(tenant_id, project_id, file_id)
         WHERE f.tenant_id=doomed.tenant_id AND f.project_id=doomed.project_id AND f.file_id=doomed.file_id`,
          params,
        );
        const auditByProject = new Map<string, { tenantId: string; projectId: string; fileIds: string[] }>();
        for (const entry of doomedFiles) {
          const key = `${entry.tenantId}:${entry.projectId}`;
          const group = auditByProject.get(key) ?? {
            tenantId: entry.tenantId,
            projectId: entry.projectId,
            fileIds: [],
          };
          group.fileIds.push(entry.fileId);
          auditByProject.set(key, group);
        }
        for (const group of auditByProject.values()) {
          await db.query(
          `INSERT INTO audit_events (tenant_id, user_id, session_id, event_type, payload)
           VALUES ($1, NULL, NULL, 'project_file_retention_deleted', $2::jsonb)`,
            [
              group.tenantId,
              JSON.stringify({
                projectId: group.projectId,
                fileIds: group.fileIds,
                reason: "retention",
              }),
            ],
          );
        }
      }
      // Older versions of the sweep could enqueue keys that were still
      // referenced by a promoted target. Remove those stale rows before the
      // bounded pending query so they cannot permanently occupy its head.
      await db.query(
        `DELETE FROM project_file_storage_gc gc
         WHERE EXISTS (SELECT 1 FROM project_file_versions v WHERE v.storage_key=gc.storage_key)
            OR EXISTS (SELECT 1 FROM artifacts a WHERE a.storage_key=gc.storage_key AND a.status <> 'deleted')`,
      );
      const pending = await db.query(
        `WITH candidates AS (
           SELECT tenant_id, project_id, storage_key
           FROM project_file_storage_gc
           WHERE next_attempt_at <= NOW()
           ORDER BY next_attempt_at, created_at, tenant_id, project_id, storage_key
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE project_file_storage_gc AS gc
         SET attempts=gc.attempts+1, next_attempt_at=NOW() + INTERVAL '1 hour'
         FROM candidates
         WHERE gc.tenant_id=candidates.tenant_id
           AND gc.project_id=candidates.project_id
           AND gc.storage_key=candidates.storage_key
         RETURNING gc.tenant_id, gc.project_id, gc.storage_key`,
        [batchSize],
      );
      return {
        deletedFiles: doomedFiles.length,
        pending: pending.rows.map((row) => ({
          tenantId: String(row.tenant_id),
          projectId: String(row.project_id),
          storageKey: String(row.storage_key),
        })),
      };
    });

    let deletedObjects = 0;
    for (const pending of result.pending) {
      const refs = await this.maintenanceDb.query(
        `SELECT 1 FROM project_file_versions
           WHERE storage_key=$1
         UNION ALL SELECT 1 FROM artifacts
           WHERE storage_key=$1 AND status <> 'deleted' LIMIT 1`,
        [pending.storageKey],
      );
      if (refs.rowCount) {
        await this.maintenanceDb.query(
          `DELETE FROM project_file_storage_gc WHERE tenant_id=$1 AND project_id=$2 AND storage_key=$3`,
          [pending.tenantId, pending.projectId, pending.storageKey],
        );
        continue;
      }
      try {
        await storage.delete(pending.storageKey);
        const removed = await this.maintenanceDb.query(
          `DELETE FROM project_file_storage_gc
           WHERE tenant_id=$1 AND project_id=$2 AND storage_key=$3
             AND NOT EXISTS (SELECT 1 FROM project_file_versions WHERE storage_key=$3)
             AND NOT EXISTS (SELECT 1 FROM artifacts WHERE storage_key=$3 AND status <> 'deleted')`,
          [pending.tenantId, pending.projectId, pending.storageKey],
        );
        deletedObjects += removed.rowCount ?? 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          { err: error, tenantId: pending.tenantId, projectId: pending.projectId, storageKey: pending.storageKey },
          "Failed to delete an expired project file object; will retry",
        );
        await this.maintenanceDb.query(
          `UPDATE project_file_storage_gc
           SET next_attempt_at=NOW() + LEAST(INTERVAL '1 hour', INTERVAL '1 minute' * power(2, LEAST(attempts, 6))),
               last_error=$4
           WHERE tenant_id=$1 AND project_id=$2 AND storage_key=$3`,
          [pending.tenantId, pending.projectId, pending.storageKey, message],
        );
      }
    }
    return { deletedFiles: result.deletedFiles, deletedObjects };
  }

  setPiiProtection(
    piiProtection: Pick<PiiProtectionService, "evaluateArtifact">,
  ): void {
    this.piiProtection = piiProtection;
  }
  private async scoped<T>(
    actor: ProjectFileActor,
    mutate: boolean,
    fn: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    return withTenantScope(this.db, actor.tenantId, async (db) => {
      await requireProjectAccess(db, actor, mutate ? "editor" : "viewer", {
        lock: mutate, active: mutate,
      });
      return fn(db);
    });
  }
  private async entry(
    db: PoolClient,
    actor: ProjectFileActor,
    fileId: string,
    includeTrash = false,
  ) {
    const result = await db.query(
      `${joinedFiles} AND f.file_id = $3 AND f.kind <> 'promoted'
      ${includeTrash ? "" : "AND f.trashed_at IS NULL"}`,
      [actor.tenantId, actor.projectId, fileId],
    );
    if (!result.rows[0]) throw missing();
    return result.rows[0];
  }
  private async destination(
    db: PoolClient,
    actor: ProjectFileActor,
    folderId: string | null,
  ) {
    if (!folderId) return;
    const result = await db.query(
      `SELECT folder_id FROM project_folders
      WHERE tenant_id = $1 AND project_id = $2 AND folder_id = $3 AND deleted_at IS NULL`,
      [actor.tenantId, actor.projectId, folderId],
    );
    if (!result.rows[0])
      throw new ProjectFileError(
        "project_folder_missing",
        "Choose an existing destination folder and try again.",
      );
  }
  private async freePath(
    db: PoolClient,
    actor: ProjectFileActor,
    name: string,
    folderId: string | null,
    excludeId: string | null = null,
  ) {
    const result = await db.query(
      `SELECT 1 FROM project_files WHERE tenant_id = $1 AND project_id = $2
      AND folder_id IS NOT DISTINCT FROM $3 AND lower(name) = lower($4) AND kind = 'published'
      AND trashed_at IS NULL AND file_id IS DISTINCT FROM $5
      UNION ALL SELECT 1 FROM project_folders WHERE tenant_id = $1 AND project_id = $2
      AND parent_id IS NOT DISTINCT FROM $3 AND lower(name) = lower($4) AND deleted_at IS NULL
      AND folder_id IS DISTINCT FROM $5`,
      [actor.tenantId, actor.projectId, folderId, name, excludeId],
    );
    if (result.rowCount)
      throw new ProjectFileError(
        "project_path_occupied",
        "That name is already used in this folder. Choose another name or folder.",
      );
  }
  private async audit(
    db: PoolClient,
    actor: ProjectFileActor,
    type: AuditEventType,
    payload: Record<string, unknown>,
  ) {
    await db.query(
      `INSERT INTO audit_events (tenant_id, user_id, session_id, event_type, payload)
      VALUES ($1, $2, NULL, $3, $4::jsonb)`,
      [
        actor.tenantId,
        actor.userId,
        type,
        JSON.stringify({ projectId: actor.projectId, ...payload }),
      ],
    );
    await db.query(
      `UPDATE projects SET updated_at = NOW() WHERE tenant_id = $1 AND project_id = $2`,
      [actor.tenantId, actor.projectId],
    );
  }
  async list(actor: ProjectFileActor): Promise<ProjectLibrary> {
    return this.scoped(actor, false, async (db) => {
      const files = await db.query(
        `${joinedFiles} AND f.kind <> 'promoted' ORDER BY f.updated_at DESC, f.file_id`,
        [actor.tenantId, actor.projectId],
      );
      const folders = await db.query(
        `SELECT * FROM project_folders WHERE tenant_id = $1 AND project_id = $2 ORDER BY name, folder_id`,
        [actor.tenantId, actor.projectId],
      );
      return { files: files.rows.map(file), folders: folders.rows.map(folder) };
    });
  }
  async listPublished(actor: ProjectFileActor): Promise<ProjectFile[]> {
    return this.scoped(actor, false, async (db) => {
      const result = await db.query(
        `${joinedFiles} AND f.kind = 'published' AND f.trashed_at IS NULL ORDER BY f.file_id`,
        [actor.tenantId, actor.projectId],
      );
      return result.rows.map(file);
    });
  }
  async captureRuntimeSnapshot(
    actor: ProjectFileActor,
    selectedFileIds: string[] = []
  ): Promise<ProjectRuntimeFileSnapshot> {
    return this.scoped(actor, false, async (db) => {
      const selected = [...new Set(selectedFileIds)].slice(0, MAX_PROJECT_FILE_SELECTIONS);
      const result = await db.query(
        `${joinedFilesWithCount} AND f.trashed_at IS NULL AND f.kind <> 'promoted' AND
          (f.kind = 'published' OR f.file_id = ANY($3::text[]))
         ORDER BY (f.file_id = ANY($3::text[])) DESC, f.updated_at DESC, f.file_id
         LIMIT $4`,
        [actor.tenantId, actor.projectId, selected, MAX_PROJECT_RUNTIME_SNAPSHOT_FILES]
      );
      const files = result.rows
        .map((row) => ({
          fileId: String(row.file_id),
          versionId: String(row.version_id),
          versionNumber: Number(row.version_number),
          folderId: row.folder_id ? String(row.folder_id) : null,
          name: String(row.name),
          mimeType: String(row.mime_type),
          kind: row.kind === "draft" ? "draft" as const : "published" as const,
          selected: selected.includes(String(row.file_id))
        }));
      return {
        projectId: actor.projectId,
        capturedAt: new Date().toISOString(),
        files,
        truncated: Number(result.rows[0]?.total_count ?? 0) > files.length
      };
    });
  }

  async readRuntimeSnapshotFile(input: {
    actor: ProjectFileActor;
    snapshot: ProjectRuntimeFileSnapshot;
    fileId: string;
    sessionId: string;
    messageId: string | null;
    storage: Pick<ArtifactStorage, "openReadStream">;
  }) {
    const entry = input.snapshot.files.find((candidate) => candidate.fileId === input.fileId);
    if (!entry || input.snapshot.projectId !== input.actor.projectId) throw missing();
    const content = await this.scoped(input.actor, false, async (db) => {
      const result = await db.query(
        `SELECT f.*, v.*, v.created_at AS version_created_at, v.created_by AS version_created_by
         FROM project_files f JOIN project_file_versions v
           ON v.tenant_id=f.tenant_id AND v.project_id=f.project_id AND v.file_id=f.file_id
         WHERE f.tenant_id=$1 AND f.project_id=$2 AND f.file_id=$3 AND v.version_id=$4`,
        [input.actor.tenantId, input.actor.projectId, entry.fileId, entry.versionId]
      );
      if (!result.rows[0]) throw missing();
      return {
        ...version(result.rows[0]),
        name: String(result.rows[0].name),
        storageKey: String(result.rows[0].storage_key)
      };
    });
    // The snapshot pins the version and intentionally remains readable if the
    // file is trashed or promoted after the turn starts. Membership is still
    // rechecked above, so this preserves turn consistency without bypassing
    // project access revocation.
    const stream = await input.storage.openReadStream(content.storageKey);
    await this.loggerAudit(input.actor, input.sessionId, input.messageId, entry);
    return { ...content, stream };
  }

  private async loggerAudit(
    actor: ProjectFileActor,
    sessionId: string,
    messageId: string | null,
    entry: ProjectRuntimeFileSnapshotEntry
  ) {
    await withTenantScope(this.db, actor.tenantId, (db) => db.query(
      `INSERT INTO audit_events (tenant_id, user_id, session_id, event_type, payload)
       VALUES ($1, $2, $3, 'project_file_read', $4::jsonb)`,
      [actor.tenantId, actor.userId, sessionId,
        JSON.stringify({ projectId: actor.projectId, fileId: entry.fileId, versionId: entry.versionId, messageId })]
    ));
  }

  async createAgentDraftFromContent(input: {
    actor: ProjectFileActor;
    name: string;
    folderId: string | null;
    targetFileId: string | null;
    baseVersionId: string | null;
    mimeType: string;
    content: Uint8Array;
    storage: Pick<ArtifactStorage, "put" | "delete">;
    maxBytes: number;
    createdByType?: ProjectFileCreatedByType;
    stored?: StoredArtifact;
  }): Promise<ProjectFile> {
    const { actor } = input;
    const parsed = parseInput(ProjectFileLocationSchema, {
      name: input.name,
      folderId: input.folderId
    });
    if (input.content.length === 0) {
      throw new ProjectFileError("project_file_empty", "The project draft cannot be empty.", 400);
    }
    if (input.content.length > input.maxBytes) {
      throw new ProjectFileError("project_file_too_large", "The project draft exceeds the file size limit.", 413);
    }
    if ((input.targetFileId === null) !== (input.baseVersionId === null)) {
      throw new ProjectFileError("project_base_missing", "An update draft needs its target and base version.", 400);
    }
    const mimeType = input.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (!ALLOWED_ARTIFACT_MIME_TYPES.has(mimeType)) {
      throw new ProjectFileError(
        "unsupported_media_type",
        `Unsupported project file MIME type: ${input.mimeType}`,
        415,
      );
    }
    // Reject authorization and mode failures before provider or storage work.
    // The insertion transaction repeats this check because the project mode
    // may change while the provider or storage operation is in flight.
    await this.scoped(actor, true, async (db) => {
      const modeResult = await db.query(
        `SELECT agent_file_mode FROM projects WHERE tenant_id=$1 AND project_id=$2`,
        [actor.tenantId, actor.projectId]
      );
      const mode = modeResult.rows[0]?.agent_file_mode ?? "read-only";
      if (mode === "read-only")
        throw new ProjectFileError("project_agent_read_only", "This project's agent file mode is read-only.");
      if (mode === "create-only" && input.targetFileId)
        throw new ProjectFileError("project_agent_create_only", "Create-only mode cannot update an existing project file.");
    });
    if (this.piiProtection) {
      const decision = await this.piiProtection.evaluateArtifact({
        tenantId: actor.tenantId,
        artifact: {
          artifactId: `project-draft:${uuidv7()}`,
          contentType: mimeType,
          entityTypes: [],
          readContent: async () => Buffer.from(input.content).toString("utf8")
        },
        // Project drafts are new bytes entering the shared library, so they
        // follow the tenant's existing upload PII scope and blocking policy.
        subject: { kind: "upload" }
      });
      if (decision.action === "block") {
        throw new ProjectFileError(
          "pii_block",
          "The project draft was blocked by organization policy.",
          422,
        );
      }
    }
    // A supplied object is already owned by the artifact path and this method
    // only adds a project-file reference. Any future PII purge of that shared
    // object must check project_file_versions before deleting by storage key.
    const stored = input.stored ?? await input.storage.put({
      storageKey: `project-files/${actor.projectId}/${uuidv7()}`,
      stream: Readable.from([Buffer.from(input.content)])
    });
    const ownsStoredObject = !input.stored;
    try {
      return await this.scoped(actor, true, async (db) => {
        const modeResult = await db.query(
          `SELECT agent_file_mode FROM projects WHERE tenant_id=$1 AND project_id=$2 FOR SHARE`,
          [actor.tenantId, actor.projectId]
        );
        const mode = modeResult.rows[0]?.agent_file_mode ?? "read-only";
        if (mode === "read-only")
          throw new ProjectFileError("project_agent_read_only", "This project's agent file mode is read-only.");
        if (mode === "create-only" && input.targetFileId)
          throw new ProjectFileError("project_agent_create_only", "Create-only mode cannot update an existing project file.");
        await this.destination(db, actor, parsed.folderId);
        const fileId = uuidv7();
        const versionId = uuidv7();
        if (input.targetFileId) {
          const target = await this.entry(db, actor, input.targetFileId);
          if (target.kind !== "published") throw missing();
          if (target.current_version_id !== input.baseVersionId)
            throw new ProjectFileError("project_version_conflict", "The published file changed. Keep this draft and compare the latest version.");
        }

        // Repeated agent writes for one published target are iterations of the
        // same reviewable draft. Keep one draft row and append an immutable
        // version instead of creating several drafts that all conflict at
        // promotion time.
        if (input.targetFileId && input.createdByType === "agent") {
          const existing = await db.query(
            `${joinedFiles} AND f.kind = 'draft' AND f.target_file_id = $3
             AND f.base_version_id = $4 AND f.folder_id IS NOT DISTINCT FROM $5
             AND lower(f.name) = lower($6) AND f.created_by_type = 'agent'
             ORDER BY f.updated_at DESC, f.file_id LIMIT 1 FOR UPDATE OF f`,
            [
              actor.tenantId,
              actor.projectId,
              input.targetFileId,
              input.baseVersionId,
              parsed.folderId,
              parsed.name,
            ],
          );
          const draft = existing.rows[0];
          if (draft) {
            const versionId = uuidv7();
            await db.query(
              `INSERT INTO project_file_versions (tenant_id,project_id,file_id,version_id,version_number,storage_backend,storage_key,mime_type,file_size_bytes,checksum_sha256,created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [
                actor.tenantId,
                actor.projectId,
                draft.file_id,
                versionId,
                Number(draft.version_number) + 1,
                stored.storageBackend,
                stored.storageKey,
                mimeType,
                stored.fileSizeBytes,
                stored.checksumSha256,
                actor.userId,
              ],
            );
            await db.query(
              `UPDATE project_files SET current_version_id=$4, updated_at=NOW()
               WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3`,
              [actor.tenantId, actor.projectId, draft.file_id, versionId],
            );
            await this.audit(db, actor, "project_draft_rewritten", {
              fileId: draft.file_id,
              versionId,
              replacedVersionId: draft.version_id,
            });
            return file(await this.entry(db, actor, String(draft.file_id)));
          }
        }
        await db.query(
          `INSERT INTO project_files (tenant_id,project_id,file_id,folder_id,name,kind,current_version_id,target_file_id,base_version_id,created_by,created_by_type)
           VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10)`,
          [actor.tenantId, actor.projectId, fileId, parsed.folderId, parsed.name, versionId, input.targetFileId, input.baseVersionId, actor.userId, input.createdByType ?? "user"]
        );
        await db.query(
          `INSERT INTO project_file_versions (tenant_id,project_id,file_id,version_id,version_number,storage_backend,storage_key,mime_type,file_size_bytes,checksum_sha256,created_by)
           VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10)`,
          [actor.tenantId, actor.projectId, fileId, versionId, stored.storageBackend, stored.storageKey, mimeType, stored.fileSizeBytes, stored.checksumSha256, actor.userId]
        );
        await this.audit(db, actor, "project_draft_created", { fileId, versionId, targetFileId: input.targetFileId });
        return file(await this.entry(db, actor, fileId));
      });
    } catch (error) {
      if (!ownsStoredObject) throw error;
      await input.storage.delete(stored.storageKey).catch((cleanupError) => {
        this.logger.warn({ err: cleanupError, tenantId: actor.tenantId, projectId: actor.projectId, storageKey: stored.storageKey }, "Failed to remove an uncommitted project draft");
      });
      throw error;
    }
  }

  private async loadConflictRow(input: {
    actor: ProjectFileActor;
    draftId: string;
    sessionId: string;
    messageId: string | null;
  }): Promise<Row> {
    return this.scoped(input.actor, false, async (db) => {
      const result = await db.query(
        `SELECT
           draft.file_id AS draft_file_id,
           draft.name AS draft_name,
           draft.folder_id AS draft_folder_id,
           draft.target_file_id,
           draft.base_version_id,
           proposedv.version_id AS proposed_version_id,
           proposedv.mime_type AS proposed_mime_type,
           proposedv.storage_key AS proposed_storage_key,
           basev.version_id AS base_version_id_actual,
           basev.version_number AS base_version_number,
           basev.mime_type AS base_mime_type,
           basev.storage_key AS base_storage_key,
           latestv.version_id AS latest_version_id,
           latestv.version_number AS latest_version_number,
           latestv.mime_type AS latest_mime_type,
           latestv.storage_key AS latest_storage_key
         FROM project_files draft
         JOIN project_file_versions proposedv
           ON proposedv.tenant_id=draft.tenant_id AND proposedv.project_id=draft.project_id
          AND proposedv.file_id=draft.file_id AND proposedv.version_id=draft.current_version_id
         JOIN project_files target
           ON target.tenant_id=draft.tenant_id AND target.project_id=draft.project_id
          AND target.file_id=draft.target_file_id AND target.kind='published'
          AND target.trashed_at IS NULL
         JOIN project_file_versions latestv
           ON latestv.tenant_id=target.tenant_id AND latestv.project_id=target.project_id
          AND latestv.file_id=target.file_id AND latestv.version_id=target.current_version_id
         JOIN project_file_versions basev
           ON basev.tenant_id=draft.tenant_id AND basev.project_id=draft.project_id
          AND basev.file_id=target.file_id AND basev.version_id=draft.base_version_id
         WHERE draft.tenant_id=$1 AND draft.project_id=$2 AND draft.file_id=$3
           AND draft.kind='draft' AND draft.trashed_at IS NULL`,
        [input.actor.tenantId, input.actor.projectId, input.draftId],
      );
      const found = result.rows[0];
      if (!found) throw missing();
      if (found.base_version_id_actual !== found.base_version_id) throw missing();
      if (found.latest_version_id === found.base_version_id_actual) {
        throw new ProjectFileError(
          "project_conflict_not_found",
          "The published file has not changed since this draft was created.",
          409,
        );
      }
      return found;
    });

  }

  private validateConflictMime(row: Row): string {
    const mimeType = String(row.latest_mime_type).toLowerCase().split(";")[0]?.trim() ?? "";
    const mimeTypes = [row.base_mime_type, row.proposed_mime_type, row.latest_mime_type]
      .map((value) => String(value).toLowerCase().split(";")[0]?.trim() ?? "");
    if (!mimeTypes.every((value) => isTextReadableArtifact(value)) || mimeTypes.some((value) => value !== mimeType)) {
      throw new ProjectFileError(
        "project_conflict_unsupported",
        "This conflict needs manual recovery. Agent resolution supports matching text-based file formats only.",
        422,
      );
    }
    return mimeType;
  }

  private conflictMetadata(row: Row, mimeType: string): ProjectConflictMetadata {
    return {
      draftId: String(row.draft_file_id),
      targetFileId: String(row.target_file_id),
      name: String(row.draft_name),
      folderId: row.draft_folder_id ? String(row.draft_folder_id) : null,
      mimeType,
      baseVersionId: String(row.base_version_id_actual),
      baseVersionNumber: Number(row.base_version_number),
      latestVersionId: String(row.latest_version_id),
      latestVersionNumber: Number(row.latest_version_number),
    };
  }

  private async auditConflictRead(input: {
    actor: ProjectFileActor;
    sessionId: string;
    messageId: string | null;
  }, row: Row): Promise<void> {
    await withTenantScope(this.db, input.actor.tenantId, (db) => db.query(
      `INSERT INTO audit_events (tenant_id, user_id, session_id, event_type, payload)
       VALUES ($1, $2, $3, 'project_file_read', $4::jsonb)`,
      [input.actor.tenantId, input.actor.userId, input.sessionId,
        JSON.stringify({
          projectId: input.actor.projectId,
          draftId: String(row.draft_file_id),
          fileIds: [String(row.target_file_id), String(row.draft_file_id)],
          versionIds: [String(row.base_version_id_actual), String(row.latest_version_id), String(row.proposed_version_id)],
          purpose: "conflict_resolution",
          messageId: input.messageId,
        })],
    ));
  }

  async readConflictMetadata(input: {
    actor: ProjectFileActor;
    draftId: string;
    sessionId: string;
    messageId: string | null;
  }): Promise<ProjectConflictMetadata> {
    const row = await this.loadConflictRow(input);
    const mimeType = this.validateConflictMime(row);
    await this.auditConflictRead(input, row);
    return this.conflictMetadata(row, mimeType);
  }

  /**
   * Load the three immutable text versions needed for an explicit conflict
   * resolution request. The database query pins the draft, its base version,
   * and the current published version together. Access is checked again when
   * the bytes are read, and the eventual draft write repeats the latest-version
   * check, so this context never grants a stale overwrite.
   */
  async readConflictContext(input: {
    actor: ProjectFileActor;
    draftId: string;
    sessionId: string;
    messageId: string | null;
    storage: Pick<ArtifactStorage, "openReadStream">;
  }): Promise<ProjectConflictContext> {
    const row = await this.loadConflictRow(input);
    const mimeType = this.validateConflictMime(row);

    const readVersion = async (storageKey: string): Promise<string> => {
      const content = await input.storage.openReadStream(storageKey);
      const bounded = await readStreamAsBoundedText(content.stream, MAX_PROJECT_RECONCILIATION_CHARS);
      if (bounded.truncated) {
        throw new ProjectFileError(
          "project_conflict_too_large",
          "This conflict is too large for agent resolution. Download the versions and recover it manually.",
          413,
        );
      }
      return bounded.text;
    };
    const [proposedContent, baseContent, latestContent] = await Promise.all([
      readVersion(String(row.proposed_storage_key)),
      readVersion(String(row.base_storage_key)),
      readVersion(String(row.latest_storage_key)),
    ]);
    await this.auditConflictRead(input, row);
    const metadata = this.conflictMetadata(row, mimeType);
    return {
      ...metadata,
      proposedContent,
      baseContent,
      latestContent,
    };
  }
  async createFolder(
    actor: ProjectFileActor,
    name: string,
    parentId: string | null,
  ) {
    name = parseInput(ProjectEntryNameSchema, name);
    return this.scoped(actor, true, async (db) => {
      await this.destination(db, actor, parentId);
      await this.freePath(db, actor, name, parentId);
      const result = await db.query(
        `INSERT INTO project_folders (tenant_id, project_id, folder_id, name, parent_id)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [actor.tenantId, actor.projectId, uuidv7(), name, parentId],
      );
      await this.audit(db, actor, "project_folder_created", {
        folderId: result.rows[0].folder_id,
      });
      return folder(result.rows[0]);
    });
  }
  async renameFolder(actor: ProjectFileActor, folderId: string, name: string) {
    name = parseInput(ProjectEntryNameSchema, name);
    return this.scoped(actor, true, async (db) => {
      await this.destination(db, actor, folderId);
      const current = await db.query(
        `SELECT parent_id FROM project_folders WHERE tenant_id=$1 AND project_id=$2 AND folder_id=$3`,
        [actor.tenantId, actor.projectId, folderId],
      );
      await this.freePath(db, actor, name, current.rows[0].parent_id, folderId);
      await db.query(
        `UPDATE project_folders SET name=$4 WHERE tenant_id=$1 AND project_id=$2 AND folder_id=$3`,
        [actor.tenantId, actor.projectId, folderId, name],
      );
      await this.audit(db, actor, "project_folder_renamed", { folderId });
    });
  }
  async removeFolder(actor: ProjectFileActor, folderId: string) {
    return this.scoped(actor, true, async (db) => {
      await this.destination(db, actor, folderId);
      const children = await db.query(
        `SELECT 1 FROM project_folders WHERE tenant_id=$1 AND project_id=$2 AND parent_id=$3 AND deleted_at IS NULL
        UNION ALL SELECT 1 FROM project_files WHERE tenant_id=$1 AND project_id=$2 AND folder_id=$3 AND trashed_at IS NULL AND kind <> 'promoted'`,
        [actor.tenantId, actor.projectId, folderId],
      );
      if (children.rowCount)
        throw new ProjectFileError(
          "project_folder_not_empty",
          "Move or trash this folder's contents before removing it.",
        );
      await db.query(
        `UPDATE project_folders SET deleted_at=NOW() WHERE tenant_id=$1 AND project_id=$2 AND folder_id=$3`,
        [actor.tenantId, actor.projectId, folderId],
      );
      await this.audit(db, actor, "project_folder_removed", { folderId });
    });
  }
  async createFromArtifact(
    actor: ProjectFileActor,
    input: ProjectFileCreate,
    storage: Pick<ArtifactStorage, "openReadStream" | "put" | "delete">,
    maxBytes: number,
  ) {
    input = parseInput(ProjectFileCreateSchema, input);
    const readSource = async (db: PoolClient) => {
      const source = await db.query(
        `SELECT a.* FROM artifacts a JOIN sessions s
          ON s.tenant_id=a.tenant_id AND s.session_id=a.session_id
          WHERE a.tenant_id=$1 AND s.project_id=$2 AND a.artifact_id=$3
          AND s.status <> 'deleted' AND a.status='ready' AND a.artifact_type <> 'derived'
          AND COALESCE(a.detail_json->'pii'->>'status', 'scanned') IN ('scanned','transformed') FOR SHARE OF a, s`,
        [actor.tenantId, actor.projectId, input.artifactId],
      );
      const artifact = source.rows[0];
      if (!artifact)
        throw new ProjectFileError(
          "project_source_unavailable",
          "Wait for the source file to finish its checks, then try again.",
          404,
        );
      if (!ALLOWED_ARTIFACT_MIME_TYPES.has(artifact.mime_type))
        throw new ProjectFileError(
          "unsupported_media_type",
          "This file type is not supported.",
          415,
        );
      if (Number(artifact.file_size_bytes) > maxBytes)
        throw new ProjectFileError(
          "artifact_too_large",
          "This file exceeds the upload size limit.",
          413,
        );
      return artifact;
    };
    // Authorize before copying, then release the connection during storage I/O.
    // Recheck the source and project in the insertion transaction below.
    const original = await this.scoped(actor, true, readSource);
    let stored: StoredArtifact | undefined;
    try {
      const handle = await storage.openReadStream(original.storage_key);
      async function* boundedBytes() {
        let bytes = 0;
        for await (const chunk of handle.stream) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          if (bytes > maxBytes)
            throw new ProjectFileError(
              "artifact_too_large",
              "This file exceeds the upload size limit.",
              413,
            );
          yield data;
        }
      }
      stored = await storage.put({
        storageKey: `project-files/${actor.projectId}/${uuidv7()}`,
        stream: Readable.from(boundedBytes()),
      });
      if (
        stored.fileSizeBytes !== Number(original.file_size_bytes) ||
        stored.checksumSha256 !== original.checksum_sha256
      )
        throw new ProjectFileError(
          "project_source_changed",
          "The source file changed during copying. Select it again and retry.",
        );
      const copied = stored;
      return await this.scoped(actor, true, async (db) => {
        await this.destination(db, actor, input.folderId);
        if (input.kind === "published")
          await this.freePath(db, actor, input.name, input.folderId);
        if (input.targetFileId) {
          const target = await this.entry(db, actor, input.targetFileId);
          if (target.kind !== "published") throw missing();
          const base = await db.query(
            `SELECT version_id FROM project_file_versions
            WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3 AND version_id=$4`,
            [
              actor.tenantId,
              actor.projectId,
              input.targetFileId,
              input.baseVersionId,
            ],
          );
          if (!base.rows[0])
            throw new ProjectFileError(
              "project_base_missing",
              "Choose a version of the target file as the base.",
            );
        }
        const artifact = await readSource(db);
        if (
          [
            "storage_backend",
            "storage_key",
            "mime_type",
            "file_size_bytes",
            "checksum_sha256",
          ].some((key) => artifact[key] !== original[key])
        )
          throw new ProjectFileError(
            "project_source_changed",
            "The source file changed during copying. Select it again and retry.",
          );
        const fileId = uuidv7(),
          versionId = uuidv7();
        await db.query(
          `INSERT INTO project_files (tenant_id, project_id, file_id, folder_id, name, kind, current_version_id, target_file_id, base_version_id, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            actor.tenantId,
            actor.projectId,
            fileId,
            input.folderId,
            input.name,
            input.kind,
            versionId,
            input.targetFileId,
            input.baseVersionId,
            actor.userId,
          ],
        );
        await db.query(
          `INSERT INTO project_file_versions (tenant_id, project_id, file_id, version_id, version_number,
          storage_backend, storage_key, mime_type, file_size_bytes, checksum_sha256, source_artifact_id, created_by)
          VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11)`,
          [
            actor.tenantId,
            actor.projectId,
            fileId,
            versionId,
            copied.storageBackend,
            copied.storageKey,
            artifact.mime_type,
            copied.fileSizeBytes,
            copied.checksumSha256,
            input.artifactId,
            actor.userId,
          ],
        );
        await this.audit(db, actor, "project_file_created", {
          fileId,
          versionId,
          kind: input.kind,
          sourceArtifactId: input.artifactId,
        });
        return file(await this.entry(db, actor, fileId));
      });
    } catch (error) {
      if (stored) {
        try {
          await storage.delete(stored.storageKey);
        } catch (cleanupError) {
          this.logger.warn(
            {
              err: cleanupError,
              tenantId: actor.tenantId,
              projectId: actor.projectId,
              storageKey: stored.storageKey,
            },
            "Failed to remove an uncommitted project file copy",
          );
        }
      }
      throw error;
    }
  }
  async relocate(
    actor: ProjectFileActor,
    fileId: string,
    name: string,
    folderId: string | null,
  ) {
    ({ name, folderId } = parseInput(ProjectFileLocationSchema, {
      name,
      folderId,
    }));
    return this.scoped(actor, true, async (db) => {
      const current = await this.entry(db, actor, fileId);
      await this.destination(db, actor, folderId);
      if (current.kind === "published")
        await this.freePath(db, actor, name, folderId, fileId);
      await db.query(
        `UPDATE project_files SET name=$4, folder_id=$5, updated_at=NOW() WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3`,
        [actor.tenantId, actor.projectId, fileId, name, folderId],
      );
      await this.audit(db, actor, "project_file_moved", {
        fileId,
        folderId,
        name,
      });
    });
  }
  private async appendVersion(
    db: PoolClient,
    actor: ProjectFileActor,
    target: Row,
    source: Row,
    restored: boolean,
  ) {
    const versionId = uuidv7();
    await db.query(
      `INSERT INTO project_file_versions (tenant_id,project_id,file_id,version_id,version_number,
      storage_backend,storage_key,mime_type,file_size_bytes,checksum_sha256,source_artifact_id,restored_from_version_id,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        actor.tenantId,
        actor.projectId,
        target.file_id,
        versionId,
        Number(target.version_number) + 1,
        source.storage_backend,
        source.storage_key,
        source.mime_type,
        source.file_size_bytes,
        source.checksum_sha256,
        source.source_artifact_id,
        restored ? source.version_id : null,
        actor.userId,
      ],
    );
    await db.query(
      `UPDATE project_files SET current_version_id=$4, updated_at=NOW() WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3`,
      [actor.tenantId, actor.projectId, target.file_id, versionId],
    );
    return versionId;
  }
  async promote(actor: ProjectFileActor, draftId: string) {
    return this.scoped(actor, true, async (db) => {
      const draft = await this.entry(db, actor, draftId);
      if (draft.kind !== "draft")
        throw new ProjectFileError(
          "project_not_draft",
          "Only drafts can be promoted.",
        );
      await this.destination(db, actor, draft.folder_id);
      let fileId: string, versionId: string;
      if (draft.target_file_id) {
        const target = await this.entry(db, actor, draft.target_file_id, true);
        if (target.kind !== "published") throw missing();
        if (target.trashed_at)
          throw new ProjectFileError(
            "project_target_trashed",
            "The draft's published target is in Trash. Restore the target before promoting this draft.",
            409,
          );
        if (target.current_version_id !== draft.base_version_id)
          throw new ProjectFileError(
            "project_version_conflict",
            "The published file changed. Your draft is preserved. Compare versions or save it as a separate file.",
          );
        if (
          target.folder_id !== draft.folder_id ||
          target.name !== draft.name
        ) {
          throw new ProjectFileError(
            "project_destination_changed",
            "The target file has a different name or folder. Update the draft destination before promoting it.",
          );
        }
        await this.destination(db, actor, target.folder_id);
        fileId = target.file_id;
        versionId = await this.appendVersion(db, actor, target, draft, false);
        await db.query(
          `UPDATE project_files SET kind='promoted', updated_at=NOW() WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3`,
          [actor.tenantId, actor.projectId, draftId],
        );
      } else {
        await this.freePath(db, actor, draft.name, draft.folder_id, draftId);
        fileId = draftId;
        versionId = draft.current_version_id;
        await db.query(
          `UPDATE project_files SET kind='published', updated_at=NOW() WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3`,
          [actor.tenantId, actor.projectId, draftId],
        );
      }
      await this.audit(db, actor, "project_draft_promoted", {
        draftId,
        fileId,
        versionId,
      });
      return file(await this.entry(db, actor, fileId));
    });
  }
  async saveDraftAsNew(
    actor: ProjectFileActor,
    fileId: string,
    name: string,
    folderId: string | null,
  ) {
    ({ name, folderId } = parseInput(ProjectFileLocationSchema, {
      name,
      folderId,
    }));
    return this.scoped(actor, true, async (db) => {
      const draft = await this.entry(db, actor, fileId);
      if (draft.kind !== "draft")
        throw new ProjectFileError(
          "project_not_draft",
          "Only drafts can be saved as a new file.",
        );
      await this.destination(db, actor, folderId);
      await this.freePath(db, actor, name, folderId);
      await db.query(
        `UPDATE project_files SET name=$4,folder_id=$5,target_file_id=NULL,base_version_id=NULL,updated_at=NOW()
        WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3`,
        [actor.tenantId, actor.projectId, fileId, name, folderId],
      );
      await this.audit(db, actor, "project_draft_retargeted", {
        fileId,
        folderId,
        name,
      });
    });
  }
  async history(actor: ProjectFileActor, fileId: string) {
    return this.scoped(actor, false, async (db) => {
      await this.entry(db, actor, fileId);
      const rows = await db.query(
        `SELECT * FROM project_file_versions WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3 ORDER BY version_number DESC`,
        [actor.tenantId, actor.projectId, fileId],
      );
      return rows.rows.map(version);
    });
  }
  async restoreVersion(
    actor: ProjectFileActor,
    fileId: string,
    versionId: string,
    expectedVersionId: string,
  ) {
    return this.scoped(actor, true, async (db) => {
      const target = await this.entry(db, actor, fileId);
      if (
        target.kind !== "published" ||
        target.current_version_id !== expectedVersionId
      )
        throw new ProjectFileError(
          "project_version_conflict",
          "The published file changed. Reload its history before restoring.",
        );
      const result = await db.query(
        `SELECT * FROM project_file_versions WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3 AND version_id=$4`,
        [actor.tenantId, actor.projectId, fileId, versionId],
      );
      if (!result.rows[0]) throw missing();
      const newVersionId = await this.appendVersion(
        db,
        actor,
        target,
        result.rows[0],
        true,
      );
      await this.audit(db, actor, "project_file_version_restored", {
        fileId,
        versionId: newVersionId,
        restoredFromVersionId: versionId,
      });
      return file(await this.entry(db, actor, fileId));
    });
  }
  async trash(actor: ProjectFileActor, fileId: string) {
    return this.scoped(actor, true, async (db) => {
      const current = await this.entry(db, actor, fileId, true);
      if (current.trashed_at) return;
      await db.query(
        `UPDATE project_files SET trashed_at=NOW(),updated_at=NOW() WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3`,
        [actor.tenantId, actor.projectId, fileId],
      );
      await this.audit(db, actor, "project_file_trashed", { fileId });
    });
  }
  async restoreTrash(
    actor: ProjectFileActor,
    fileId: string,
    name: string,
    folderId: string | null,
  ) {
    ({ name, folderId } = parseInput(ProjectFileLocationSchema, {
      name,
      folderId,
    }));
    return this.scoped(actor, true, async (db) => {
      const current = await this.entry(db, actor, fileId, true);
      if (!current.trashed_at)
        throw new ProjectFileError(
          "project_file_not_trashed",
          "This file is already available.",
        );
      const eligible = await db.query(
        `SELECT 1 FROM project_files WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3 AND trashed_at > NOW() - INTERVAL '30 days'`,
        [actor.tenantId, actor.projectId, fileId],
      );
      if (!eligible.rows[0])
        throw new ProjectFileError(
          "project_trash_expired",
          "The 30-day recovery period has ended.",
          410,
        );
      await this.destination(db, actor, folderId);
      if (current.kind === "published")
        await this.freePath(db, actor, name, folderId, fileId);
      await db.query(
        `UPDATE project_files SET trashed_at=NULL, name=$4,folder_id=$5,updated_at=NOW() WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3`,
        [actor.tenantId, actor.projectId, fileId, name, folderId],
      );
      await this.audit(db, actor, "project_file_restored", { fileId });
    });
  }
  async content(actor: ProjectFileActor, fileId: string, versionId: string) {
    return this.scoped(actor, false, async (db) => {
      const current = await this.entry(db, actor, fileId);
      const result = await db.query(
        `SELECT * FROM project_file_versions WHERE tenant_id=$1 AND project_id=$2 AND file_id=$3 AND version_id=$4`,
        [actor.tenantId, actor.projectId, fileId, versionId],
      );
      if (!result.rows[0]) throw missing();
      return {
        ...version(result.rows[0]),
        name: String(current.name),
        storageKey: String(result.rows[0].storage_key),
      };
    });
  }
}
