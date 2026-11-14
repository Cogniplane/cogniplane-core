
import { type Pool, withTenantScope } from "../../lib/db.js";
import { uuidv7 } from "../../lib/uuid.js";
import { isoTimestamp } from "../../lib/db-mappers.js";
import { toolContextExecutionSql } from "../session-execution-store.js";
import { ownerSecurityVersionSql } from "./security-change.js";

/**
 * Thrown when a `require`/`requireOwned` lookup finds no live tool context
 * (missing row, wrong tenant, wrong owner, expired TTL, or a security change
 * of the owner's local account). Carries a stable
 * machine-readable `code` so callers and tests can branch on the contract
 * instead of matching prose in the message.
 */
export class ToolContextUnavailableError extends Error {
  readonly code = "TOOL_CONTEXT_UNAVAILABLE" as const;

  constructor(public readonly toolContextId: string) {
    super(`Tool context ${toolContextId} was not found, expired, or ended by a security change.`);
    this.name = "ToolContextUnavailableError";
  }
}

/**
 * The state of a tool context for the runtime loop (`liveness`):
 * - `live`: a lookup returns the context.
 * - `security_change`: the owner's local account has another security version.
 * - `ended`: no row, or the TTL expired, or the execution of the turn ended.
 */
export type ToolContextLiveness = "live" | "security_change" | "ended";

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
    expiresAt: isoTimestamp(row.expires_at),
    createdAt: isoTimestamp(row.created_at)
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
    /**
     * The owner's security version that admitted the turn: the session's
     * for an interactive turn, the job's for a scheduled turn. Null for a
     * WorkOS owner. A different version later refuses every lookup.
     */
    ownerSecurityVersion: number | null;
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
            owner_security_version,
            expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $11, NOW() + ($10 * INTERVAL '1 millisecond'))
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
          input.ttlMs,
          input.ownerSecurityVersion
        ]
      );

      return mapContext(result.rows[0]);
    });
  }

  /**
   * Returns the most recent non-expired tool context for a session, if any.
   *
   * Used by the MCP gateway as a fallback when a tool call names no tool
   * context (no `_meta`, argument, or URL value). The active turn's context is
   * always the most recent row for the session. This keeps full fidelity
   * (selectedArtifactIds, runtimePolicy snapshot, messageId attribution). It
   * does not synthesize partial context from the runtime token.
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
            AND ${toolContextExecutionSql("tool_execution_contexts")}
            AND ${ownerSecurityVersionSql("tool_execution_contexts")}
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [tenantId, sessionId]
      );

      return result.rows[0] ? mapContext(result.rows[0]) : null;
    });
  }

  /**
   * Push a live context's expiry out to `now + ttlMs`, turning the wall-clock
   * TTL into an idle timeout. The approval round loop is unbounded, so a turn's
   * real length is `working budget + N x APPROVAL_REQUEST_TTL_MS`.
   * No finite TTL validated at config time can bound that, and a turn that
   * outlives its context loses all managed MCP tool access mid-turn.
   *
   * The resume path calls this after each approval decision. It only extends.
   * The WHERE clause requires a live row, so an expired context stays expired.
   * This cannot resurrect a context that the gateway has already rejected.
   * Returns the new expiry, or null when there was no live row to extend.
   */
  async extend(tenantId: string, toolContextId: string, ttlMs: number): Promise<string | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          UPDATE tool_execution_contexts
          SET expires_at = NOW() + ($3 * INTERVAL '1 millisecond')
          WHERE tenant_id = $1 AND tool_context_id = $2 AND expires_at > NOW()
            AND ${toolContextExecutionSql("tool_execution_contexts")}
            AND ${ownerSecurityVersionSql("tool_execution_contexts")}
          RETURNING expires_at
        `,
        [tenantId, toolContextId, ttlMs]
      );

      return result.rows[0] ? isoTimestamp(result.rows[0].expires_at) : null;
    });
  }

  /**
   * Tells the runtime if its turn can continue. The runtime calls this at
   * each model start and before each native tool, so it must stay cheap:
   * one read of the context by its unique id, with the same conditions as
   * `get` (TTL, execution lease, owner's security version) as columns,
   * so that a dead context also gives its reason. It reads no JSON column.
   */
  async liveness(tenantId: string, toolContextId: string): Promise<ToolContextLiveness> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query<{ owner_current: boolean; usable: boolean }>(
        `
          SELECT ${ownerSecurityVersionSql("tool_execution_contexts")} AS owner_current,
            (expires_at > NOW() AND ${toolContextExecutionSql("tool_execution_contexts")}) AS usable
          FROM tool_execution_contexts
          WHERE tenant_id = $1 AND tool_context_id = $2
        `,
        [tenantId, toolContextId]
      );
      const row = result.rows[0];
      if (!row) return "ended";
      if (!row.owner_current) return "security_change";
      return row.usable ? "live" : "ended";
    });
  }

  /**
   * The security version of the user's local account now, or null for a
   * WorkOS user. Only for AUTH_MODE=dev-headers, which has no session to
   * take the version from (requestSecurityVersion).
   */
  async currentOwnerSecurityVersion(tenantId: string, userId: string): Promise<number | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query<{ security_version: number }>(
        `SELECT security_version FROM local_identities WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, userId]
      );
      return result.rows[0] ? Number(result.rows[0].security_version) : null;
    });
  }

  async get(tenantId: string, toolContextId: string): Promise<ToolExecutionContext | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM tool_execution_contexts
          WHERE tenant_id = $1 AND tool_context_id = $2 AND expires_at > NOW()
            AND ${toolContextExecutionSql("tool_execution_contexts")}
            AND ${ownerSecurityVersionSql("tool_execution_contexts")}
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
      throw new ToolContextUnavailableError(toolContextId);
    }

    return context;
  }

  async requireOwned(tenantId: string, toolContextId: string, userId: string): Promise<ToolExecutionContext> {
    const context = await this.getOwned(tenantId, toolContextId, userId);
    if (!context) {
      throw new ToolContextUnavailableError(toolContextId);
    }

    return context;
  }
}
