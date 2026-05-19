
import { type Pool, withTenantScope } from "../../lib/db.js";
import { uuidv7 } from "../../lib/uuid.js";

export type ToolExecutionContext = {
  toolContextId: string;
  tenantId: string;
  sessionId: string;
  userId: string;
  runtimeId: string;
  runtimePolicyId: string;
  messageId: string | null;
  credentialEnvelope: Record<string, unknown>;
  metadata: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
};

function mapContext(row: Record<string, unknown>): ToolExecutionContext {
  return {
    toolContextId: String(row.tool_context_id),
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    runtimeId: String(row.runtime_id),
    runtimePolicyId: String(row.runtime_policy_id),
    messageId: row.message_id ? String(row.message_id) : null,
    credentialEnvelope:
      row.credential_envelope && typeof row.credential_envelope === "object"
        ? (row.credential_envelope as Record<string, unknown>)
        : {},
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

export class ToolExecutionContextStore {
  constructor(private readonly db: Pool) {}

  async create(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
    runtimeId: string;
    runtimePolicyId: string;
    messageId: string | null;
    credentialEnvelope?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    ttlMs: number;
  }): Promise<ToolExecutionContext> {
    const toolContextId = `ctx_${uuidv7()}`;
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO tool_execution_contexts (
            tool_context_id,
            tenant_id,
            session_id,
            user_id,
            runtime_id,
            runtime_policy_id,
            message_id,
            credential_envelope,
            metadata,
            expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, NOW() + ($10 * INTERVAL '1 millisecond'))
          RETURNING *
        `,
        [
          toolContextId,
          input.tenantId,
          input.sessionId,
          input.userId,
          input.runtimeId,
          input.runtimePolicyId,
          input.messageId,
          JSON.stringify(input.credentialEnvelope ?? {}),
          JSON.stringify(input.metadata ?? {}),
          input.ttlMs
        ]
      );

      return mapContext(result.rows[0]);
    });
  }

  /**
   * Returns the most recent non-expired tool context for a session, if any.
   *
   * Used by the MCP gateway as a fallback when an MCP tool call arrives
   * without `toolContextId` in its arguments. The active turn's context is
   * always the most recent row for the session, so this preserves full
   * fidelity (selectedArtifactIds, runtimePolicy snapshot, messageId
   * attribution) without synthesizing partial context from the runtime token.
   */
  async findLatestActiveBySession(
    tenantId: string,
    sessionId: string
  ): Promise<ToolExecutionContext | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM tool_execution_contexts
          WHERE tenant_id = $1 AND session_id = $2 AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [tenantId, sessionId]
      );

      return result.rows[0] ? mapContext(result.rows[0]) : null;
    });
  }

  async get(tenantId: string, toolContextId: string): Promise<ToolExecutionContext | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM tool_execution_contexts
          WHERE tenant_id = $1 AND tool_context_id = $2 AND expires_at > NOW()
          LIMIT 1
        `,
        [tenantId, toolContextId]
      );

      return result.rows[0] ? mapContext(result.rows[0]) : null;
    });
  }

  async getOwned(tenantId: string, toolContextId: string, userId: string): Promise<ToolExecutionContext | null> {
    const context = await this.get(tenantId, toolContextId);
    return context?.userId === userId ? context : null;
  }

  async require(tenantId: string, toolContextId: string): Promise<ToolExecutionContext> {
    const context = await this.get(tenantId, toolContextId);
    if (!context) {
      throw new Error(`Tool context ${toolContextId} was not found or expired.`);
    }

    return context;
  }

  async requireOwned(tenantId: string, toolContextId: string, userId: string): Promise<ToolExecutionContext> {
    const context = await this.getOwned(tenantId, toolContextId, userId);
    if (!context) {
      throw new Error(`Tool context ${toolContextId} was not found or expired.`);
    }

    return context;
  }
}
