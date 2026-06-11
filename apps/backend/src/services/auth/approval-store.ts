import { type Pool, withTenantScope } from "../../lib/db.js";
import { isoTimestamp, isoTimestampOrNull } from "../../lib/db-mappers.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalKind = "command_execution" | "file_change" | "permissions";

export type ApprovalRecord = {
  approvalId: string;
  tenantId: string;
  sessionId: string;
  userId: string;
  runtimeId: string;
  turnId: string;
  itemId: string;
  requestMethod: string;
  requestId: string;
  kind: ApprovalKind;
  title: string;
  summary: string;
  status: ApprovalStatus;
  decision: "approve" | "reject" | null;
  requestPayload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  expiresAt: string;
};

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    approvalId: String(row.approval_id),
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    runtimeId: String(row.runtime_id),
    turnId: String(row.turn_id),
    itemId: String(row.item_id),
    requestMethod: String(row.request_method),
    requestId: String(row.request_id),
    kind:
      row.kind === "file_change" || row.kind === "permissions" ? row.kind : "command_execution",
    title: String(row.title),
    summary: String(row.summary),
    status:
      row.status === "approved" || row.status === "rejected" || row.status === "expired"
        ? row.status
        : "pending",
    decision: row.decision === "approve" || row.decision === "reject" ? row.decision : null,
    requestPayload:
      row.request_payload && typeof row.request_payload === "object"
        ? (row.request_payload as Record<string, unknown>)
        : {},
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    resolvedAt: isoTimestampOrNull(row.resolved_at),
    expiresAt: isoTimestamp(row.expires_at)
  };
}

export class ApprovalStore {
  constructor(private readonly db: Pool) {}

  async create(input: Omit<ApprovalRecord, "createdAt" | "updatedAt" | "resolvedAt"> & { tenantId: string }): Promise<ApprovalRecord> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO approvals (
            tenant_id,
            approval_id,
            session_id,
            user_id,
            runtime_id,
            turn_id,
            item_id,
            request_method,
            request_id,
            kind,
            title,
            summary,
            status,
            decision,
            request_payload,
            expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
          RETURNING *
        `,
        [
          input.tenantId,
          input.approvalId,
          input.sessionId,
          input.userId,
          input.runtimeId,
          input.turnId,
          input.itemId,
          input.requestMethod,
          input.requestId,
          input.kind,
          input.title,
          input.summary,
          input.status,
          input.decision,
          JSON.stringify(input.requestPayload),
          input.expiresAt
        ]
      );

      return mapApproval(result.rows[0]);
    });
  }

  async listPending(tenantId: string, sessionId: string, userId: string): Promise<ApprovalRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM approvals
          WHERE tenant_id = $1 AND session_id = $2 AND user_id = $3 AND status = 'pending'
          ORDER BY created_at ASC
        `,
        [tenantId, sessionId, userId]
      );

      return result.rows.map(mapApproval);
    });
  }

  async resolve(
    tenantId: string,
    approvalId: string,
    userId: string,
    decision: "approve" | "reject"
  ): Promise<ApprovalRecord | null> {
    const status = decision === "approve" ? "approved" : "rejected";
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE approvals
          SET status = $4, decision = $5, resolved_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1 AND approval_id = $2 AND user_id = $3 AND status = 'pending'
          RETURNING *
        `,
        [tenantId, approvalId, userId, status, decision]
      );

      return result.rows[0] ? mapApproval(result.rows[0]) : null;
    });
  }

  async expire(tenantId: string, approvalId: string): Promise<ApprovalRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE approvals
          SET status = 'expired', resolved_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1 AND approval_id = $2 AND status = 'pending'
          RETURNING *
        `,
        [tenantId, approvalId]
      );

      return result.rows[0] ? mapApproval(result.rows[0]) : null;
    });
  }

  /**
   * DB-level backstop for the in-process TTL timers: atomically move every
   * `pending` approval whose `expires_at` deadline has passed to `expired` and
   * return the affected rows so the caller can write `approval.expired` audit
   * events. Runs across ALL tenants in one statement, so it MUST be given the
   * privileged (BYPASSRLS) pool — RLS would otherwise scope it to whatever
   * tenant context happens to be set. This recovers rows orphaned when a crash
   * or restart killed the in-memory timer before it could fire.
   *
   * `limit` bounds the batch so a large backlog can't lock the table or balloon
   * the audit write; the caller loops until a sweep returns fewer than `limit`.
   */
  async sweepExpired(limit = 500): Promise<ApprovalRecord[]> {
    const result = await this.db.query(
      `
        UPDATE approvals
        SET status = 'expired', resolved_at = NOW(), updated_at = NOW()
        WHERE approval_id IN (
          SELECT approval_id
          FROM approvals
          WHERE status = 'pending' AND expires_at <= NOW()
          ORDER BY expires_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `,
      [limit]
    );

    return result.rows.map(mapApproval);
  }
}
