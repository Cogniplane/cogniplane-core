import { type Pool, withTenantScope } from "../../lib/db.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalKind = "command_execution" | "file_change" | "permissions";

export type ApprovalRecord = {
  approvalId: string;
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
};

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    approvalId: String(row.approval_id),
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
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)).toISOString() : null
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
            request_payload
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
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
          JSON.stringify(input.requestPayload)
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

  async getOwned(tenantId: string, approvalId: string, userId: string): Promise<ApprovalRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM approvals
          WHERE tenant_id = $1 AND approval_id = $2 AND user_id = $3
          LIMIT 1
        `,
        [tenantId, approvalId, userId]
      );

      return result.rows[0] ? mapApproval(result.rows[0]) : null;
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
}
