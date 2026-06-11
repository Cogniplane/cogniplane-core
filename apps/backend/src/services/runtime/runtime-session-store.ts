import { type Pool, withTenantScope } from "../../lib/db.js";
import type { RuntimeManifest } from "../../domain/runtime-manifest.js";
import { isoTimestamp, isoTimestampOrNull } from "../../lib/db-mappers.js";

const RUNTIME_SESSION_COLUMNS = `
  id,
  session_id,
  user_id,
  runtime_id,
  runtime_provider,
  workspace_path,
  codex_version,
  codex_schema_version,
  manifest_path,
  manifest_metadata,
  health_status,
  last_active_at,
  started_at,
  terminated_at,
  lifecycle_metadata,
  status,
  created_at,
  updated_at
`;

export type RuntimeSessionUpsertInput = {
  tenantId: string;
  sessionId: string;
  userId: string;
  runtimeId: string;
  runtimeProvider: string;
  workspacePath: string;
  runtimeVersion: string;
  runtimeSchemaVersion: string;
  manifestPath: string;
  manifestMetadata: RuntimeManifest;
  healthStatus: string;
  lastActiveAt: string | null;
  startedAt: string | null;
  terminatedAt: string | null;
  lifecycleMetadata: Record<string, unknown>;
  status: string;
};

export type RuntimeSessionRecord = {
  id: number;
  sessionId: string;
  userId: string;
  runtimeId: string;
  runtimeProvider: string;
  workspacePath: string;
  runtimeVersion: string;
  runtimeSchemaVersion: string;
  manifestPath: string;
  manifestMetadata: RuntimeManifest;
  healthStatus: string;
  lastActiveAt: string | null;
  startedAt: string | null;
  terminatedAt: string | null;
  lifecycleMetadata: Record<string, unknown>;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function mapRuntimeSession(row: Record<string, unknown>): RuntimeSessionRecord {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    runtimeId: String(row.runtime_id),
    runtimeProvider: String(row.runtime_provider),
    workspacePath: String(row.workspace_path),
    runtimeVersion: String(row.codex_version),
    runtimeSchemaVersion: String(row.codex_schema_version),
    manifestPath: String(row.manifest_path),
    manifestMetadata: row.manifest_metadata as RuntimeManifest,
    healthStatus: String(row.health_status),
    lastActiveAt: isoTimestampOrNull(row.last_active_at),
    startedAt: isoTimestampOrNull(row.started_at),
    terminatedAt: isoTimestampOrNull(row.terminated_at),
    lifecycleMetadata:
      row.lifecycle_metadata && typeof row.lifecycle_metadata === "object"
        ? (row.lifecycle_metadata as Record<string, unknown>)
        : {},
    status: String(row.status),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

export class RuntimeSessionStore {
  constructor(private readonly db: Pool) {}

  async upsert(input: RuntimeSessionUpsertInput): Promise<RuntimeSessionRecord> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      // Try to update the existing row for this runtime_id first
      const updateResult = await client.query(
        `
          UPDATE runtime_sessions
          SET tenant_id = $1,
              user_id = $2,
              workspace_path = $4,
              codex_version = $5,
              codex_schema_version = $6,
              manifest_path = $7,
              manifest_metadata = $8::jsonb,
              health_status = $9,
              last_active_at = $10,
              started_at = $11,
              terminated_at = $12,
              lifecycle_metadata = $13::jsonb,
              status = $14,
              runtime_provider = $15,
              updated_at = NOW()
          WHERE runtime_id = $3
          RETURNING ${RUNTIME_SESSION_COLUMNS}
        `,
        [
          input.tenantId,
          input.userId,
          input.runtimeId,
          input.workspacePath,
          input.runtimeVersion,
          input.runtimeSchemaVersion,
          input.manifestPath,
          JSON.stringify(input.manifestMetadata),
          input.healthStatus,
          input.lastActiveAt,
          input.startedAt,
          input.terminatedAt,
          JSON.stringify(input.lifecycleMetadata),
          input.status,
          input.runtimeProvider
        ]
      );

      if (updateResult.rows[0]) {
        return mapRuntimeSession(updateResult.rows[0]);
      }

      // Terminate any previous runtime for this session before inserting
      await client.query(
        `
          UPDATE runtime_sessions
          SET status = 'terminated',
              terminated_at = COALESCE(terminated_at, NOW()),
              updated_at = NOW()
          WHERE session_id = $1
            AND status NOT IN ('terminated', 'error')
        `,
        [input.sessionId]
      );

      const insertResult = await client.query(
        `
          INSERT INTO runtime_sessions (
            tenant_id,
            session_id,
            user_id,
            runtime_id,
            workspace_path,
            codex_version,
            codex_schema_version,
            manifest_path,
            manifest_metadata,
            health_status,
            last_active_at,
            started_at,
            terminated_at,
            lifecycle_metadata,
            status,
            runtime_provider
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::jsonb, $15, $16)
          RETURNING ${RUNTIME_SESSION_COLUMNS}
        `,
        [
          input.tenantId,
          input.sessionId,
          input.userId,
          input.runtimeId,
          input.workspacePath,
          input.runtimeVersion,
          input.runtimeSchemaVersion,
          input.manifestPath,
          JSON.stringify(input.manifestMetadata),
          input.healthStatus,
          input.lastActiveAt,
          input.startedAt,
          input.terminatedAt,
          JSON.stringify(input.lifecycleMetadata),
          input.status,
          input.runtimeProvider
        ]
      );

      return mapRuntimeSession(insertResult.rows[0]);
    });
  }

  /**
   * Pass `runtimeId` whenever the caller is tearing down a SPECIFIC runtime:
   * teardown can race session recreation, and an unscoped update would mark
   * the replacement's freshly inserted 'active' row as terminated. The
   * unscoped form is for session-level operations with no live runtime.
   */
  async setStatus(
    tenantId: string,
    sessionId: string,
    userId: string,
    status: string,
    runtimeId?: string
  ): Promise<RuntimeSessionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE runtime_sessions
          SET status = $3, updated_at = NOW()
          WHERE tenant_id = $4 AND session_id = $1 AND user_id = $2
            AND ($5::text IS NULL OR runtime_id = $5)
            AND status NOT IN ('terminated', 'error')
          RETURNING ${RUNTIME_SESSION_COLUMNS}
        `,
        [sessionId, userId, status, tenantId, runtimeId ?? null]
      );

      return result.rows[0] ? mapRuntimeSession(result.rows[0]) : null;
    });
  }

  async listRecent(tenantId: string, limit = 100): Promise<RuntimeSessionRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT ${RUNTIME_SESSION_COLUMNS}
          FROM runtime_sessions
          WHERE tenant_id = $1
          ORDER BY updated_at DESC
          LIMIT $2
        `,
        [tenantId, limit]
      );

      return result.rows.map((row) => mapRuntimeSession(row));
    });
  }
}
