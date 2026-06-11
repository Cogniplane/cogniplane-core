import type { FastifyInstance } from "fastify";

import { AdminSessionDetailResponseSchema } from "@cogniplane/shared-types";

import { withTenantScope } from "../../lib/db.js";
import { notFoundError } from "../../lib/http-errors.js";
import { parseRequestInput } from "../../lib/route-validation.js";
import { sessionIdParams } from "../../lib/route-schemas.js";
import { serialize } from "../../lib/serialize-response.js";
import { withAdmin } from "./admin-route-helpers.js";
import { isoTimestamp } from "../../lib/db-mappers.js";

export type AdminSessionDetailOverview = {
  sessionId: string;
  userId: string;
  userEmail: string | null;
  tenantId: string;
  sessionName: string;
  status: "active" | "completed" | "errored";
  runtimeProvider: "codex" | "claude-code" | null;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  totalCostUsd: number;
  totalTokens: number;
};

export type AdminSessionDetailMessage = {
  messageId: string;
  role: string;
  status: string;
  contentText: string;
  reasoningContent: string;
  planContent: string;
  modelName: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  detailJson: unknown;
  createdAt: string;
};

export type AdminSessionDetailApproval = {
  approvalId: string;
  turnId: string;
  itemId: string;
  requestMethod: string;
  kind: string;
  title: string;
  summary: string;
  status: string;
  decision: string | null;
  requestPayload: unknown;
  createdAt: string;
  resolvedAt: string | null;
};

export type AdminSessionDetailPiiRun = {
  scanRunId: string;
  subjectType: "message" | "artifact";
  subjectId: string;
  sourceUserId: string | null;
  mode: string;
  providerType: string | null;
  providerModel: string | null;
  status: string;
  findings: unknown[];
  summaryText: string | null;
  actionTaken: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type AdminSessionDetailAuditEvent = {
  eventType: string;
  userId: string;
  approvalId: string | null;
  payload: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
};

export type AdminSessionDetailToolEvent = {
  toolCallId: string;
  messageId: string | null;
  approvalId: string | null;
  kind: string;
  title: string;
  phase: string;
  status: string;
  durationMs: number | null;
  payload: unknown;
  createdAt: string;
};

export type AdminSessionDetailMessageToolResult = {
  toolResultId: string;
  messageId: string;
  kind: string;
  title: string;
  status: string;
  serverName: string;
  toolName: string;
  commandText: string;
  inputText: string;
  cwd: string;
  outputText: string;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string;
};

export type AdminSessionDetailArtifact = {
  artifactId: string;
  artifactType: string;
  artifactName: string;
  mimeType: string;
  fileSizeBytes: number;
  status: string;
  createdAt: string;
};

export type AdminSessionDetailResourceUsage = {
  resourceId: string;
  name: string;
  materialized: boolean;
  invokedCount: number;
};

export type AdminSessionDetailResponse = {
  overview: AdminSessionDetailOverview;
  messages: AdminSessionDetailMessage[];
  approvals: AdminSessionDetailApproval[];
  piiRuns: AdminSessionDetailPiiRun[];
  auditEvents: AdminSessionDetailAuditEvent[];
  toolEvents: AdminSessionDetailToolEvent[];
  messageToolResults: AdminSessionDetailMessageToolResult[];
  artifacts: AdminSessionDetailArtifact[];
  skills: AdminSessionDetailResourceUsage[];
  mcpServers: AdminSessionDetailResourceUsage[];
};

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return isoTimestamp(value);
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  return toIso(value);
}

function toIntOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toFloatOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export async function registerAdminSessionDetailRoute(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/sessions/:sessionId",
    withAdmin(app, async (request, reply) => {
      const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
      if (!paramsResult.ok) {
        return paramsResult.response;
      }

      const { sessionId } = paramsResult.value;
      const { tenantId } = request.auth;

      const detail = await withTenantScope(app.db, tenantId, async (client) => {
        const headerResult = await client.query(
          `
            SELECT
              s.session_id,
              s.user_id,
              u.email AS user_email,
              s.tenant_id,
              s.session_name,
              CASE
                WHEN COALESCE(m.has_error, FALSE) THEN 'errored'
                ELSE 'active'
              END AS admin_status,
              s.created_at,
              rs.runtime_provider,
              COALESCE(m.last_activity_at, s.created_at) AS last_activity_at,
              COALESCE(m.message_count, 0)::int          AS message_count,
              COALESCE(m.total_cost_usd, 0)::float       AS total_cost_usd,
              COALESCE(m.total_tokens, 0)::bigint        AS total_tokens
            FROM sessions s
            LEFT JOIN users u ON u.user_id = s.user_id
            LEFT JOIN LATERAL (
              SELECT runtime_provider
              FROM runtime_sessions
              WHERE session_id = s.session_id
              ORDER BY created_at DESC, id DESC
              LIMIT 1
            ) rs ON TRUE
            LEFT JOIN (
              SELECT
                session_id,
                MAX(created_at)                  AS last_activity_at,
                COUNT(*)                         AS message_count,
                COALESCE(SUM(cost_usd), 0)       AS total_cost_usd,
                COALESCE(SUM(total_tokens), 0)   AS total_tokens,
                BOOL_OR(status IN ('failed', 'error')) AS has_error
              FROM messages
              WHERE tenant_id = $1
              GROUP BY session_id
            ) m ON m.session_id = s.session_id
            WHERE s.tenant_id = $1
              AND s.session_id = $2
            LIMIT 1
          `,
          [tenantId, sessionId]
        );

        if (headerResult.rows.length === 0) {
          return null;
        }

        const [
          messagesResult,
          approvalsResult,
          piiResult,
          auditResult,
          toolEventsResult,
          messageToolResultsResult,
          artifactsResult,
          skillUsageResult,
          mcpUsageResult
        ] = await Promise.all([
          client.query(
            `
              SELECT
                message_id, role, status, content_text, reasoning_content,
                plan_content, model_name, input_tokens, output_tokens,
                total_tokens, cost_usd, detail_json, created_at
              FROM messages
              WHERE tenant_id = $1 AND session_id = $2
              ORDER BY created_at ASC, id ASC
            `,
            [tenantId, sessionId]
          ),
          client.query(
            `
              SELECT
                approval_id, turn_id, item_id, request_method, kind, title,
                summary, status, decision, request_payload,
                created_at, resolved_at
              FROM approvals
              WHERE tenant_id = $1 AND session_id = $2
              ORDER BY created_at ASC, id ASC
            `,
            [tenantId, sessionId]
          ),
          client.query(
            `
              SELECT
                scan_run_id, subject_type, subject_id, source_user_id, mode,
                provider_type, provider_model, status, findings_json,
                summary_text, action_taken, error_message,
                created_at, completed_at
              FROM pii_scan_runs
              WHERE tenant_id = $1 AND source_session_id = $2
              ORDER BY created_at ASC
            `,
            [tenantId, sessionId]
          ),
          client.query(
            `
              SELECT
                event_type, user_id, approval_id, payload,
                ip_address::text AS ip_address, user_agent, created_at
              FROM audit_events
              WHERE tenant_id = $1 AND session_id = $2
              ORDER BY created_at ASC, id ASC
            `,
            [tenantId, sessionId]
          ),
          client.query(
            `
              SELECT
                tool_call_id, message_id, approval_id, kind, title, phase,
                status, duration_ms, payload, created_at
              FROM tool_events
              WHERE tenant_id = $1 AND session_id = $2
              ORDER BY created_at ASC, id ASC
            `,
            [tenantId, sessionId]
          ),
          client.query(
            `
              SELECT
                tool_result_id, message_id, kind, title, status,
                server_name, tool_name, command_text, input_text, cwd,
                output_text, exit_code, duration_ms, created_at
              FROM message_tool_results
              WHERE tenant_id = $1 AND session_id = $2
              ORDER BY created_at ASC, id ASC
            `,
            [tenantId, sessionId]
          ),
          client.query(
            `
              SELECT
                artifact_id, artifact_type, artifact_name, mime_type,
                file_size_bytes, status, created_at
              FROM artifacts
              WHERE tenant_id = $1 AND session_id = $2
              ORDER BY created_at ASC, id ASC
            `,
            [tenantId, sessionId]
          ),
          client.query(
            `
              SELECT
                ra.resource_id,
                COALESCE(s.skill_name, ra.resource_id) AS name,
                BOOL_OR(ra.event_type = 'materialized')                       AS materialized,
                COUNT(*) FILTER (WHERE ra.event_type = 'invoked')::int        AS invoked_count
              FROM resource_activations ra
              LEFT JOIN admin_skills s
                ON s.tenant_id = ra.tenant_id AND s.skill_id = ra.resource_id
              WHERE ra.tenant_id = $1
                AND ra.session_id = $2
                AND ra.resource_type = 'skill'
              GROUP BY ra.resource_id, s.skill_name
              ORDER BY name ASC
            `,
            [tenantId, sessionId]
          ),
          client.query(
            `
              SELECT
                ra.resource_id,
                COALESCE(m.server_name, ra.resource_id) AS name,
                BOOL_OR(ra.event_type = 'materialized')                       AS materialized,
                COUNT(*) FILTER (WHERE ra.event_type = 'invoked')::int        AS invoked_count
              FROM resource_activations ra
              LEFT JOIN admin_mcp_servers m
                ON m.tenant_id = ra.tenant_id AND m.server_id = ra.resource_id
              WHERE ra.tenant_id = $1
                AND ra.session_id = $2
                AND ra.resource_type = 'mcp_server'
              GROUP BY ra.resource_id, m.server_name
              ORDER BY name ASC
            `,
            [tenantId, sessionId]
          )
        ]);

        const headerRow = headerResult.rows[0];

        const overview: AdminSessionDetailOverview = {
          sessionId: String(headerRow.session_id),
          userId: String(headerRow.user_id),
          userEmail: headerRow.user_email == null ? null : String(headerRow.user_email),
          tenantId: String(headerRow.tenant_id),
          sessionName: String(headerRow.session_name ?? ""),
          status: String(headerRow.admin_status) as AdminSessionDetailOverview["status"],
          runtimeProvider:
            headerRow.runtime_provider == null
              ? null
              : (String(headerRow.runtime_provider) as AdminSessionDetailOverview["runtimeProvider"]),
          createdAt: toIso(headerRow.created_at),
          lastActivityAt: toIso(headerRow.last_activity_at),
          messageCount: Number(headerRow.message_count ?? 0),
          totalCostUsd: Number(headerRow.total_cost_usd ?? 0),
          totalTokens: Number(headerRow.total_tokens ?? 0)
        };

        const messages: AdminSessionDetailMessage[] = messagesResult.rows.map((row) => ({
          messageId: String(row.message_id),
          role: String(row.role),
          status: String(row.status),
          contentText: String(row.content_text ?? ""),
          reasoningContent: String(row.reasoning_content ?? ""),
          planContent: String(row.plan_content ?? ""),
          modelName: row.model_name == null ? null : String(row.model_name),
          inputTokens: toIntOrNull(row.input_tokens),
          outputTokens: toIntOrNull(row.output_tokens),
          totalTokens: toIntOrNull(row.total_tokens),
          costUsd: toFloatOrNull(row.cost_usd),
          detailJson: toJson(row.detail_json),
          createdAt: toIso(row.created_at)
        }));

        const approvals: AdminSessionDetailApproval[] = approvalsResult.rows.map((row) => ({
          approvalId: String(row.approval_id),
          turnId: String(row.turn_id),
          itemId: String(row.item_id),
          requestMethod: String(row.request_method),
          kind: String(row.kind),
          title: String(row.title),
          summary: String(row.summary),
          status: String(row.status),
          decision: row.decision == null ? null : String(row.decision),
          requestPayload: toJson(row.request_payload),
          createdAt: toIso(row.created_at),
          resolvedAt: toIsoOrNull(row.resolved_at)
        }));

        const piiRuns: AdminSessionDetailPiiRun[] = piiResult.rows.map((row) => {
          const parsed = toJson(row.findings_json);
          const findings = Array.isArray(parsed) ? (parsed as unknown[]) : [];
          return {
            scanRunId: String(row.scan_run_id),
            subjectType: String(row.subject_type) as AdminSessionDetailPiiRun["subjectType"],
            subjectId: String(row.subject_id),
            sourceUserId: row.source_user_id == null ? null : String(row.source_user_id),
            mode: String(row.mode),
            providerType: row.provider_type == null ? null : String(row.provider_type),
            providerModel: row.provider_model == null ? null : String(row.provider_model),
            status: String(row.status),
            findings,
            summaryText: row.summary_text == null ? null : String(row.summary_text),
            actionTaken: row.action_taken == null ? null : String(row.action_taken),
            errorMessage: row.error_message == null ? null : String(row.error_message),
            createdAt: toIso(row.created_at),
            completedAt: toIsoOrNull(row.completed_at)
          };
        });

        const auditEvents: AdminSessionDetailAuditEvent[] = auditResult.rows.map((row) => ({
          eventType: String(row.event_type),
          userId: String(row.user_id),
          approvalId: row.approval_id == null ? null : String(row.approval_id),
          payload: toJson(row.payload),
          ipAddress: row.ip_address == null ? null : String(row.ip_address),
          userAgent: row.user_agent == null ? null : String(row.user_agent),
          createdAt: toIso(row.created_at)
        }));

        const toolEvents: AdminSessionDetailToolEvent[] = toolEventsResult.rows.map((row) => ({
          toolCallId: String(row.tool_call_id),
          messageId: row.message_id == null ? null : String(row.message_id),
          approvalId: row.approval_id == null ? null : String(row.approval_id),
          kind: String(row.kind),
          title: String(row.title),
          phase: String(row.phase),
          status: String(row.status),
          durationMs: toIntOrNull(row.duration_ms),
          payload: toJson(row.payload),
          createdAt: toIso(row.created_at)
        }));

        const messageToolResults: AdminSessionDetailMessageToolResult[] =
          messageToolResultsResult.rows.map((row) => ({
            toolResultId: String(row.tool_result_id),
            messageId: String(row.message_id),
            kind: String(row.kind),
            title: String(row.title),
            status: String(row.status),
            serverName: String(row.server_name ?? ""),
            toolName: String(row.tool_name ?? ""),
            commandText: String(row.command_text ?? ""),
            inputText: String(row.input_text ?? ""),
            cwd: String(row.cwd ?? ""),
            outputText: String(row.output_text ?? ""),
            exitCode: toIntOrNull(row.exit_code),
            durationMs: toIntOrNull(row.duration_ms),
            createdAt: toIso(row.created_at)
          }));

        const artifacts: AdminSessionDetailArtifact[] = artifactsResult.rows.map((row) => ({
          artifactId: String(row.artifact_id),
          artifactType: String(row.artifact_type),
          artifactName: String(row.artifact_name),
          mimeType: String(row.mime_type),
          fileSizeBytes: Number(row.file_size_bytes ?? 0),
          status: String(row.status),
          createdAt: toIso(row.created_at)
        }));

        const mapResourceUsage = (rows: Array<Record<string, unknown>>): AdminSessionDetailResourceUsage[] =>
          rows.map((row) => ({
            resourceId: String(row.resource_id),
            name: String(row.name ?? row.resource_id),
            materialized: Boolean(row.materialized),
            invokedCount: Number(row.invoked_count ?? 0)
          }));

        const skills = mapResourceUsage(skillUsageResult.rows);
        const mcpServers = mapResourceUsage(mcpUsageResult.rows);

        const response: AdminSessionDetailResponse = {
          overview,
          messages,
          approvals,
          piiRuns,
          auditEvents,
          toolEvents,
          messageToolResults,
          artifacts,
          skills,
          mcpServers
        };
        return response;
      });

      if (!detail) {
        reply.code(404);
        return notFoundError("session_not_found");
      }

      return serialize(AdminSessionDetailResponseSchema, detail);
    })
  );
}
