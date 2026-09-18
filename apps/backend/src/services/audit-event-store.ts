import { type Pool, withTenantScope } from "../lib/db.js";
import type { PoolClient } from "pg";
import type { AuditEventType } from "./audit-event-types.js";
import { redactSecrets } from "./redact-secrets.js";

export type AuditEventInput = {
  tenantId: string;
  sessionId: string | null;
  userId: string;
  approvalId?: string | null;
  type: AuditEventType;
  payload: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type ProjectActivityEvent = {
  eventId: string;
  type: string;
  userId: string | null;
  createdAt: string;
};

// Project activity is a deliberately narrow projection of the tenant audit
// log, not an exhaustive copy of every event type. Keep administrative,
// policy, and integration events out even when a payload happens to contain a
// projectId. Add new event types here only when they belong in the project UI.
const PROJECT_ACTIVITY_PROJECT_EVENT_TYPES = [
  "project_sharing_changed",
  "project_member_changed",
  "project_owner_recovered",
  "project_archived",
  "project_restored",
  "project_reference_removed",
  "project_reference_storage_deleted",
  "project_reference_storage_deletion_failed",
  "project_approval_mode_changed",
  "project_agent_file_mode_changed",
  "project_file_copied",
  "project_file_read",
  "project_file_created",
  "project_folder_created",
  "project_folder_renamed",
  "project_folder_removed",
  "project_file_moved",
  "project_draft_created",
  "project_draft_rewritten",
  "project_draft_promoted",
  "project_draft_retargeted",
  "project_file_version_restored",
  "project_file_trashed",
  "project_file_restored",
  "project_file_retention_deleted",
] as const satisfies readonly AuditEventType[];

const PROJECT_ACTIVITY_SESSION_EVENT_TYPES = [
  "artifact_uploaded",
  "artifact_generated",
  "artifact_downloaded",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  "approval.auto_approved",
  "session.archived",
  "session.restored",
  "session.deleted",
  "turn.interrupted",
] as const satisfies readonly AuditEventType[];

export class AuditEventStore {
  constructor(private readonly db: Pool) {}

  async create(input: AuditEventInput): Promise<void> {
    await withTenantScope(this.db, input.tenantId,
      (client) => AuditEventStore.createInTransaction(client, input));
  }

  async listProjectActivity(
    tenantId: string,
    projectId: string,
    limit = 50,
  ): Promise<ProjectActivityEvent[]> {
    return withTenantScope(this.db, tenantId, async (db) => {
      const result = await db.query(
        `SELECT a.id, a.event_type, a.user_id, a.created_at
         FROM audit_events a
         WHERE a.tenant_id=$1 AND (
           (a.event_type = ANY($3::text[]) AND a.payload->>'projectId'=$2)
           OR (a.event_type = ANY($4::text[]) AND EXISTS (
             SELECT 1 FROM sessions s
             WHERE s.tenant_id=a.tenant_id AND s.session_id=a.session_id AND s.project_id=$2
           ))
         )
         ORDER BY a.created_at DESC, a.id DESC LIMIT $5`,
        [tenantId, projectId, PROJECT_ACTIVITY_PROJECT_EVENT_TYPES, PROJECT_ACTIVITY_SESSION_EVENT_TYPES, limit],
      );
      return result.rows.map((row) => ({
        eventId: String(row.id),
        type: String(row.event_type),
        userId: row.user_id ? String(row.user_id) : null,
        createdAt: new Date(row.created_at as string | Date).toISOString(),
      }));
    });
  }

  // The caller must supply its tenant-scoped transaction so evidence commits
  // or rolls back with the protected change.
  static async createInTransaction(client: PoolClient, input: AuditEventInput): Promise<void> {
    await client.query(
      `
        INSERT INTO audit_events (
          tenant_id,
          session_id,
          user_id,
          approval_id,
          event_type,
          payload,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::inet, $8)
      `,
      [
        input.tenantId,
        input.sessionId,
        input.userId,
        input.approvalId ?? null,
        input.type,
        JSON.stringify(redactSecrets(input.payload)),
        input.ipAddress ?? null,
        input.userAgent ?? null
      ]
    );
  }
}
