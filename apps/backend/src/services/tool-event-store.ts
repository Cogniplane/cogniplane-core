import { type Pool, withTenantScope } from "../lib/db.js";
import { redactSecrets } from "./redact-secrets.js";

export class ToolEventStore {
  constructor(private readonly db: Pool) {}

  async create(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    messageId: string | null;
    runtimeId: string;
    approvalId?: string | null;
    toolCallId: string;
    kind: string;
    title: string;
    phase: "started" | "completed" | "failed";
    status: string;
    payload: Record<string, unknown>;
    durationMs: number | null;
  }): Promise<void> {
    await withTenantScope(this.db, input.tenantId, async (client) => {
      await client.query(
        `
          INSERT INTO tool_events (
            tenant_id,
            session_id,
            user_id,
            message_id,
            runtime_id,
            approval_id,
            tool_call_id,
            kind,
            title,
            phase,
            status,
            payload,
            duration_ms
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
        `,
        [
          input.tenantId,
          input.sessionId,
          input.userId,
          input.messageId,
          input.runtimeId,
          input.approvalId ?? null,
          input.toolCallId,
          input.kind,
          input.title,
          input.phase,
          input.status,
          JSON.stringify(redactSecrets(input.payload)),
          input.durationMs
        ]
      );
    });
  }
}
