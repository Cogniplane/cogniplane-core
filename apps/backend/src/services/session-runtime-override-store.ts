import { type Pool, withTenantScope } from "../lib/db.js";

import type { ApprovalPolicy, RuntimeProvider } from "./admin-config-records.js";
import { parseApprovalPolicy } from "./admin-config-store-mappers.js";

/**
 * Per-session narrowing of the resolved runtime policy. Absence of a row
 * means "use tenant settings as-is". Today this powers the skill-improvement
 * session flow (the improver session is restricted to the corpus-reading and
 * artifact-writing tools); future per-session sandboxes can reuse the same
 * row shape.
 */
export type SessionRuntimeOverrideRecord = {
  tenantId: string;
  sessionId: string;
  runtimeProvider: RuntimeProvider | null;
  enabledToolIds: string[];
  enabledMcpServerIds: string[];
  enabledSkillIds: string[];
  approvalPolicy: ApprovalPolicy;
  autoApproveReadOnlyTools: boolean;
  createdBy: string;
  createdAt: string;
};

export type SessionRuntimeOverrideInput = {
  runtimeProvider?: RuntimeProvider | null;
  enabledToolIds?: string[];
  enabledMcpServerIds?: string[];
  enabledSkillIds?: string[];
  approvalPolicy?: ApprovalPolicy;
  autoApproveReadOnlyTools?: boolean;
  createdBy: string;
};

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseRuntimeProvider(value: unknown): RuntimeProvider | null {
  if (value === "claude-code" || value === "codex") return value;
  return null;
}

function serializeApprovalPolicy(policy: ApprovalPolicy): string {
  if (typeof policy === "string") return policy;
  return JSON.stringify(policy);
}

function mapRow(row: Record<string, unknown>): SessionRuntimeOverrideRecord {
  return {
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    runtimeProvider: parseRuntimeProvider(row.runtime_provider),
    enabledToolIds: toStringArray(row.enabled_tool_ids),
    enabledMcpServerIds: toStringArray(row.enabled_mcp_server_ids),
    enabledSkillIds: toStringArray(row.enabled_skill_ids),
    approvalPolicy: parseApprovalPolicy(row.approval_policy),
    autoApproveReadOnlyTools: Boolean(row.auto_approve_read_only_tools),
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

export class SessionRuntimeOverrideStore {
  constructor(private readonly db: Pool) {}

  async get(tenantId: string, sessionId: string): Promise<SessionRuntimeOverrideRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM session_runtime_overrides WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async upsert(
    tenantId: string,
    sessionId: string,
    input: SessionRuntimeOverrideInput
  ): Promise<SessionRuntimeOverrideRecord> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query(
        `
          INSERT INTO session_runtime_overrides (
            tenant_id,
            session_id,
            runtime_provider,
            enabled_tool_ids,
            enabled_mcp_server_ids,
            enabled_skill_ids,
            approval_policy,
            auto_approve_read_only_tools,
            created_by
          )
          VALUES (
            $1, $2, $3,
            $4::jsonb, $5::jsonb, $6::jsonb,
            $7, $8, $9
          )
          ON CONFLICT (tenant_id, session_id) DO UPDATE SET
            runtime_provider = EXCLUDED.runtime_provider,
            enabled_tool_ids = EXCLUDED.enabled_tool_ids,
            enabled_mcp_server_ids = EXCLUDED.enabled_mcp_server_ids,
            enabled_skill_ids = EXCLUDED.enabled_skill_ids,
            approval_policy = EXCLUDED.approval_policy,
            auto_approve_read_only_tools = EXCLUDED.auto_approve_read_only_tools
          RETURNING *
        `,
        [
          tenantId,
          sessionId,
          input.runtimeProvider ?? null,
          JSON.stringify(input.enabledToolIds ?? []),
          JSON.stringify(input.enabledMcpServerIds ?? []),
          JSON.stringify(input.enabledSkillIds ?? []),
          serializeApprovalPolicy(input.approvalPolicy ?? "never"),
          input.autoApproveReadOnlyTools ?? true,
          input.createdBy
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async delete(tenantId: string, sessionId: string): Promise<void> {
    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `DELETE FROM session_runtime_overrides WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId]
      );
    });
  }
}
