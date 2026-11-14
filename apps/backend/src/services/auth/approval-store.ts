import type { PoolClient } from "pg";

import { type Pool, withTenantScope, withTransaction } from "../../lib/db.js";
import { isoTimestamp, isoTimestampOrNull } from "../../lib/db-mappers.js";
import { AuditEventStore } from "../audit-event-store.js";
import { sessionExecutionAccessSql, SessionExecutionError } from "../session-execution-store.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalKind = "command_execution" | "file_change" | "permissions" | "mcp_tool";

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
  rememberForTurn?: boolean;
  /** The ID of the proposed tool call, when the runtime proved the link. */
  toolCallId?: string;
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
      row.kind === "file_change" || row.kind === "permissions" || row.kind === "mcp_tool"
        ? row.kind
        : "command_execution",
    title: String(row.title),
    summary: String(row.summary),
    status:
      row.status === "approved" || row.status === "rejected" || row.status === "expired"
        ? row.status
        : "pending",
    decision: row.decision === "approve" || row.decision === "reject" ? row.decision : null,
    rememberForTurn: row.remember_for_turn === true,
    ...(typeof row.tool_call_id === "string" && row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
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

/**
 * Writes the audit event of an approval's status change on the client of the
 * change. When the insert fails, the status change rolls back with it.
 */
async function auditStatusChange(client: PoolClient, approval: ApprovalRecord,
  type: "approval.approved" | "approval.rejected" | "approval.expired", payload: Record<string, unknown>): Promise<void> {
  await AuditEventStore.createInTransaction(client, {
    tenantId: approval.tenantId, sessionId: approval.sessionId, userId: approval.userId,
    approvalId: approval.approvalId, type, payload
  });
}

export class ApprovalStore {
  constructor(private readonly db: Pool) {}

  async create(input: Omit<ApprovalRecord, "createdAt" | "updatedAt" | "resolvedAt"> & { tenantId: string }): Promise<ApprovalRecord> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const session = await client.query(`SELECT project_id, EXISTS (
        SELECT 1 FROM session_executions e WHERE e.tenant_id=$1 AND e.session_id=$2
      ) AS has_execution FROM sessions WHERE tenant_id=$1 AND session_id=$2`,
        [input.tenantId, input.sessionId]);
      if (session.rows[0]?.project_id || session.rows[0]?.has_execution) {
        const active = await client.query(`SELECT e.execution_id FROM session_executions e JOIN sessions s
          ON s.tenant_id=e.tenant_id AND s.session_id=e.session_id
          WHERE e.tenant_id=$1 AND e.session_id=$2 AND e.user_id=$3 AND e.runtime_id=$4
            AND e.status='active' AND e.expires_at>clock_timestamp()
            AND ${sessionExecutionAccessSql("s", "e.user_id")} FOR SHARE OF e`,
        [input.tenantId, input.sessionId, input.userId, input.runtimeId]);
        if (!active.rows[0]) throw new SessionExecutionError("execution_stopped", 403);
      }
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
            expires_at,
            tool_call_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)
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
          input.expiresAt,
          input.toolCallId ?? null
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

  async get(tenantId: string, approvalId: string, userId: string): Promise<ApprovalRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM approvals
          WHERE tenant_id = $1 AND approval_id = $2 AND user_id = $3
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
    decision: "approve" | "reject",
    rememberForTurn = false
  ): Promise<ApprovalRecord | null> {
    const status = decision === "approve" ? "approved" : "rejected";
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE approvals
          SET status = $4, decision = $5, remember_for_turn = $6,
              resolved_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1 AND approval_id = $2 AND user_id = $3 AND status = 'pending'
            AND expires_at > clock_timestamp()
            AND EXISTS (SELECT 1 FROM sessions s
              WHERE s.tenant_id=approvals.tenant_id AND s.session_id=approvals.session_id
                AND ((s.project_id IS NULL AND NOT EXISTS (SELECT 1 FROM session_executions prior
                  WHERE prior.tenant_id=approvals.tenant_id AND prior.session_id=approvals.session_id))
                  OR EXISTS (
                  SELECT 1 FROM session_executions e WHERE e.tenant_id=approvals.tenant_id
                    AND e.session_id=approvals.session_id AND e.user_id=approvals.user_id
                    AND e.runtime_id=approvals.runtime_id AND e.status='active' AND e.expires_at>clock_timestamp()
                    AND ${sessionExecutionAccessSql("s", "e.user_id")}
                )))
          RETURNING *
        `,
        [tenantId, approvalId, userId, status, decision, rememberForTurn && decision === "approve"]
      );
      if (!result.rows[0]) return null;
      const approval = mapApproval(result.rows[0]);
      await auditStatusChange(client, approval, decision === "approve" ? "approval.approved" : "approval.rejected",
        { itemId: approval.itemId, kind: approval.kind });
      return approval;
    });
  }

  /**
   * Reads the saved decision of an approval, so that a repeated decision request
   * gets the same answer on each replica. Returns null when the approval is not
   * approved or rejected, or when the user cannot run a turn in its session now.
   * It does not check the turn lease or `expires_at`: a retry can arrive after
   * the turn ended.
   */
  async getDecided(tenantId: string, approvalId: string, userId: string): Promise<ApprovalRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT a.*
          FROM approvals a
          JOIN sessions s ON s.tenant_id = a.tenant_id AND s.session_id = a.session_id
          WHERE a.tenant_id = $1 AND a.approval_id = $2 AND a.user_id = $3
            AND ((a.status = 'approved' AND a.decision = 'approve')
              OR (a.status = 'rejected' AND a.decision = 'reject'))
            AND ${sessionExecutionAccessSql("s", "a.user_id")}
        `,
        [tenantId, approvalId, userId]
      );
      return result.rows[0] ? mapApproval(result.rows[0]) : null;
    });
  }

  /**
   * Claim an approved decision for one dispatch. Returns false when the row is
   * not approved or another dispatch already claimed it.
   */
  async consume(tenantId: string, approvalId: string, userId: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE approvals
          SET consumed_at = clock_timestamp(), updated_at = NOW()
          WHERE tenant_id = $1 AND approval_id = $2 AND user_id = $3
            AND status = 'approved' AND decision = 'approve' AND consumed_at IS NULL
          RETURNING approval_id
        `,
        [tenantId, approvalId, userId]
      );
      return result.rowCount === 1;
    });
  }

  /**
   * Expires a pending approval and writes its `approval.expired` event, with
   * `{ reason }`, in the same transaction. Returns null when the row is not
   * pending: a decision committed first and has its own event.
   */
  async expire(tenantId: string, approvalId: string, reason: string): Promise<ApprovalRecord | null> {
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
      if (!result.rows[0]) return null;
      const approval = mapApproval(result.rows[0]);
      await auditStatusChange(client, approval, "approval.expired", { reason });
      return approval;
    });
  }

  /**
   * DB-level backstop for the in-process TTL timers: move every `pending`
   * approval whose `expires_at` deadline has passed to `expired`, and write
   * one `approval.expired` event per row, in one transaction. When an event
   * cannot be written, the whole batch rolls back and stays `pending`, so
   * the next sweep expires it. This recovers rows orphaned when a crash or
   * restart killed the in-memory timer before it could fire.
   *
   * It runs across ALL tenants, so it MUST be given the privileged
   * (BYPASSRLS) pool: RLS would otherwise scope it to whatever tenant
   * context happens to be set. Each audit row takes its tenant from its
   * approval row.
   *
   * `limit` bounds the batch so a large backlog can't lock the table or balloon
   * the audit write; the caller loops until a sweep returns fewer than `limit`.
   */
  async sweepExpired(limit = 500): Promise<ApprovalRecord[]> {
    return withTransaction(this.db, async (client) => {
      const result = await client.query(
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
      const expired = result.rows.map(mapApproval);
      for (const approval of expired) {
        await auditStatusChange(client, approval, "approval.expired",
          { itemId: approval.itemId, kind: approval.kind, reason: "stale_on_sweep" });
      }
      return expired;
    });
  }
}
