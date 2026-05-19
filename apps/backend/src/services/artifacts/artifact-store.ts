import { randomBytes } from "node:crypto";
import { uuidv7 } from "../../lib/uuid.js";

import { type Pool, withTenantScope } from "../../lib/db.js";

export type ArtifactPiiDetail = {
  status?: "pending" | "scanning" | "scanned" | "blocked" | "transformed" | "failed";
  modeApplied?: "off" | "detect" | "block" | "transform";
  scanRunId?: string;
  summaryText?: string;
  findingsCount?: number;
  blockReason?: string;
};

export type ArtifactDetail = {
  pii?: ArtifactPiiDetail;
  [key: string]: unknown;
};

export type ArtifactRecord = {
  id: number;
  artifactId: string;
  sessionId: string;
  userId: string;
  artifactType: "upload" | "derived" | "generated";
  sourceArtifactId: string | null;
  artifactName: string;
  mimeType: string;
  storageBackend: "local" | "bucket";
  storageKey: string;
  fileSizeBytes: number;
  checksumSha256: string;
  status: "pending" | "processing" | "ready" | "failed" | "deleted";
  createdByType: "user" | "tool" | "job" | "system";
  createdByRef: string | null;
  detail: ArtifactDetail;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactDownloadTokenRecord = {
  token: string;
  tenantId: string;
  artifactId: string;
  sessionId: string;
  userId: string;
  storageBackend: "local" | "bucket";
  storageKey: string;
  fileName: string;
  contentType: string;
  expiresAt: string;
  createdAt: string;
};

function mapArtifact(row: Record<string, unknown>): ArtifactRecord {
  return {
    id: Number(row.id),
    artifactId: String(row.artifact_id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    artifactType:
      row.artifact_type === "derived" || row.artifact_type === "generated"
        ? row.artifact_type
        : "upload",
    sourceArtifactId: row.source_artifact_id ? String(row.source_artifact_id) : null,
    artifactName: String(row.artifact_name),
    mimeType: String(row.mime_type),
    storageBackend: row.storage_backend === "bucket" ? "bucket" : "local",
    storageKey: String(row.storage_key),
    fileSizeBytes: Number(row.file_size_bytes ?? 0),
    checksumSha256: String(row.checksum_sha256 ?? ""),
    status:
      row.status === "processing" ||
      row.status === "ready" ||
      row.status === "failed" ||
      row.status === "deleted"
        ? row.status
        : "pending",
    createdByType:
      row.created_by_type === "tool" ||
      row.created_by_type === "job" ||
      row.created_by_type === "system"
        ? row.created_by_type
        : "user",
    createdByRef: row.created_by_ref ? String(row.created_by_ref) : null,
    detail:
      row.detail_json && typeof row.detail_json === "object"
        ? (row.detail_json as ArtifactDetail)
        : {},
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

const ARTIFACT_COLUMNS = `
  id,
  artifact_id,
  session_id,
  user_id,
  artifact_type,
  source_artifact_id,
  artifact_name,
  mime_type,
  storage_backend,
  storage_key,
  file_size_bytes,
  checksum_sha256,
  status,
  created_by_type,
  created_by_ref,
  detail_json,
  created_at,
  updated_at
`.trim();

function mapDownloadToken(row: Record<string, unknown>): ArtifactDownloadTokenRecord {
  return {
    token: String(row.token),
    tenantId: String(row.tenant_id),
    artifactId: String(row.artifact_id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    storageBackend: row.storage_backend === "bucket" ? "bucket" : "local",
    storageKey: String(row.storage_key),
    fileName: String(row.file_name),
    contentType: String(row.content_type),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

export class ArtifactStore {
  constructor(
    private readonly db: Pool,
    private readonly privilegedDb: Pool = db
  ) {}

  async create(input: {
    tenantId: string;
    artifactType: ArtifactRecord["artifactType"];
    sessionId: string;
    userId: string;
    sourceArtifactId?: string | null;
    artifactName: string;
    mimeType: string;
    storageBackend: ArtifactRecord["storageBackend"];
    storageKey: string;
    fileSizeBytes: number;
    checksumSha256: string;
    status: ArtifactRecord["status"];
    createdByType: ArtifactRecord["createdByType"];
    createdByRef?: string | null;
    detail?: ArtifactDetail;
  }): Promise<ArtifactRecord> {
    const artifactId = uuidv7();
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const insertedArtifact = await client.query(
        `
          INSERT INTO artifacts (
            artifact_id,
            tenant_id,
            session_id,
            user_id,
            artifact_type,
            source_artifact_id,
            artifact_name,
            mime_type,
            storage_backend,
            storage_key,
            file_size_bytes,
            checksum_sha256,
            status,
            created_by_type,
            created_by_ref,
            detail_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
          RETURNING ${ARTIFACT_COLUMNS}
        `,
        [
          artifactId,
          input.tenantId,
          input.sessionId,
          input.userId,
          input.artifactType,
          input.sourceArtifactId ?? null,
          input.artifactName,
          input.mimeType,
          input.storageBackend,
          input.storageKey,
          input.fileSizeBytes,
          input.checksumSha256,
          input.status,
          input.createdByType,
          input.createdByRef ?? null,
          JSON.stringify(input.detail ?? {})
        ]
      );
      return mapArtifact(insertedArtifact.rows[0]);
    });
  }

  async listBySession(tenantId: string, sessionId: string, userId: string): Promise<ArtifactRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const artifactRows = await client.query(
        `
          SELECT ${ARTIFACT_COLUMNS}
          FROM artifacts
          WHERE tenant_id = $1 AND session_id = $2 AND user_id = $3 AND status <> 'deleted'
          ORDER BY created_at ASC, id ASC
        `,
        [tenantId, sessionId, userId]
      );
      return artifactRows.rows.map(mapArtifact);
    });
  }

  async getOwned(tenantId: string, artifactId: string, userId: string): Promise<ArtifactRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const artifactRows = await client.query(
        `
          SELECT ${ARTIFACT_COLUMNS}
          FROM artifacts
          WHERE tenant_id = $1 AND artifact_id = $2 AND user_id = $3
          LIMIT 1
        `,
        [tenantId, artifactId, userId]
      );
      return artifactRows.rows[0] ? mapArtifact(artifactRows.rows[0]) : null;
    });
  }

  /**
   * Retrieves an artifact by ID within a tenant scope.
   * Intended for background processing paths that already know the tenant.
   */
  async get(tenantId: string, artifactId: string): Promise<ArtifactRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const artifactRows = await client.query(
        `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE tenant_id = $1 AND artifact_id = $2 LIMIT 1`,
        [tenantId, artifactId]
      );
      return artifactRows.rows[0] ? mapArtifact(artifactRows.rows[0]) : null;
    });
  }

  async findLatestReadableDerived(
    tenantId: string,
    sourceArtifactId: string,
    userId: string
  ): Promise<ArtifactRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const derivedRows = await client.query(
        `
          SELECT ${ARTIFACT_COLUMNS}
          FROM artifacts
          WHERE
            tenant_id = $1
            AND source_artifact_id = $2
            AND user_id = $3
            AND status = 'ready'
            AND mime_type LIKE 'text/%'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
        [tenantId, sourceArtifactId, userId]
      );
      return derivedRows.rows[0] ? mapArtifact(derivedRows.rows[0]) : null;
    });
  }

  async update(
    tenantId: string,
    artifactId: string,
    input: {
      status?: ArtifactRecord["status"];
      detail?: ArtifactDetail;
    }
  ): Promise<ArtifactRecord | null> {
    const assignments: string[] = [];
    const values: unknown[] = [];

    if (input.status !== undefined) {
      values.push(input.status);
      assignments.push(`status = $${values.length}`);
    }

    if (input.detail !== undefined) {
      values.push(JSON.stringify(input.detail));
      assignments.push(`detail_json = $${values.length}::jsonb`);
    }

    if (!assignments.length) {
      throw new Error("ArtifactStore.update requires at least one field to update.");
    }

    values.push(tenantId);
    values.push(artifactId);
    return withTenantScope(this.db, tenantId, async (client) => {
      const updatedArtifact = await client.query(
        `
          UPDATE artifacts
          SET
            ${assignments.join(", ")},
            updated_at = NOW()
          WHERE tenant_id = $${values.length - 1} AND artifact_id = $${values.length}
          RETURNING ${ARTIFACT_COLUMNS}
        `,
        values
      );
      return updatedArtifact.rows[0] ? mapArtifact(updatedArtifact.rows[0]) : null;
    });
  }

  async setPiiDetail(
    tenantId: string,
    artifactId: string,
    pii: ArtifactPiiDetail
  ): Promise<void> {
    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `
          UPDATE artifacts
          SET detail_json = jsonb_set(
                COALESCE(detail_json, '{}'::jsonb),
                '{pii}',
                COALESCE(detail_json->'pii', '{}'::jsonb) || $3::jsonb,
                true
              ),
              updated_at = NOW()
          WHERE tenant_id = $1 AND artifact_id = $2
        `,
        [tenantId, artifactId, JSON.stringify(pii)]
      );
    });
  }

  async listPendingProcessingUploads(tenantId: string): Promise<ArtifactRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const pendingUploadRows = await client.query(
        `
          SELECT ${ARTIFACT_COLUMNS}
          FROM artifacts
          WHERE
            tenant_id = $1
            AND artifact_type = 'upload'
            AND mime_type = 'application/pdf'
            AND status IN ('pending', 'processing')
          ORDER BY created_at ASC, id ASC
        `,
        [tenantId]
      );
      return pendingUploadRows.rows.map(mapArtifact);
    });
  }

  async createDownloadToken(input: {
    tenantId: string;
    artifactId: string;
    sessionId: string;
    userId: string;
    storageBackend: ArtifactRecord["storageBackend"];
    storageKey: string;
    fileName: string;
    contentType: string;
    ttlMs: number;
  }): Promise<ArtifactDownloadTokenRecord> {
    const token = randomBytes(24).toString("hex");
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const insertedToken = await client.query(
        `
          INSERT INTO artifact_download_tokens (
            token,
            tenant_id,
            artifact_id,
            session_id,
            user_id,
            storage_backend,
            storage_key,
            file_name,
            content_type,
            expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + ($10::text || ' milliseconds')::interval)
          RETURNING
            token,
            tenant_id,
            artifact_id,
            session_id,
            user_id,
            storage_backend,
            storage_key,
            file_name,
            content_type,
            expires_at,
            created_at
        `,
        [
          token,
          input.tenantId,
          input.artifactId,
          input.sessionId,
          input.userId,
          input.storageBackend,
          input.storageKey,
          input.fileName,
          input.contentType,
          String(input.ttlMs)
        ]
      );
      return mapDownloadToken(insertedToken.rows[0]);
    });
  }

  // Single-use: flips `consumed_at` atomically so a leaked token cannot be
  // replayed for the full TTL. The first call wins and returns the row;
  // subsequent calls match no rows and return null.
  //
  // Caller-identity gating happens in SQL so an unauthorized request never
  // burns the token (which would let any same-tenant user DoS the legitimate
  // owner). When `callerIsAdmin` is true the user-equality check is skipped
  // — admin-minted tokens (POST /admin/artifacts/:id/download-token) carry
  // the artifact OWNER's user_id, not the admin's, because the persistence
  // layer joins on (tenant_id, artifact_id, user_id).
  async consumeDownloadToken(input: {
    token: string;
    requesterTenantId: string;
    requesterUserId: string;
    callerIsAdmin: boolean;
  }): Promise<ArtifactDownloadTokenRecord | null> {
    const tokenRows = await this.privilegedDb.query(
      `
        UPDATE artifact_download_tokens AS download
           SET consumed_at = NOW()
          FROM artifacts AS artifact
         WHERE download.token = $1
           AND download.tenant_id = $2
           AND ($4::boolean OR download.user_id = $3)
           AND download.consumed_at IS NULL
           AND artifact.tenant_id   = download.tenant_id
           AND artifact.artifact_id = download.artifact_id
           AND artifact.user_id     = download.user_id
           AND artifact.status     <> 'deleted'
           AND (artifact.artifact_type = 'upload' OR artifact.status = 'ready')
        RETURNING
          download.token,
          download.tenant_id,
          download.artifact_id,
          download.session_id,
          download.user_id,
          download.storage_backend,
          download.storage_key,
          download.file_name,
          download.content_type,
          download.expires_at,
          download.created_at
      `,
      [input.token, input.requesterTenantId, input.requesterUserId, input.callerIsAdmin]
    );
    return tokenRows.rows[0] ? mapDownloadToken(tokenRows.rows[0]) : null;
  }
}
