import { type Pool, withTenantScope } from "../lib/db.js";
import type { AuditEventType } from "./audit-event-types.js";
import { redactSecrets } from "./redact-secrets.js";

export class AuditEventStore {
  constructor(private readonly db: Pool) {}

  async create(input: {
    tenantId: string;
    sessionId: string | null;
    userId: string;
    approvalId?: string | null;
    type: AuditEventType;
    payload: Record<string, unknown>;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    await withTenantScope(this.db, input.tenantId, async (client) => {
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
    });
  }
}
