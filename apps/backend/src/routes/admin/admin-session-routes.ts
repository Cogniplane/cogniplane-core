import type { FastifyInstance } from "fastify";

import { AdminSessionsListResponseSchema } from "@cogniplane/shared-types";

import { withTenantScope } from "../../lib/db.js";
import { parseRequestInput } from "../../lib/route-validation.js";
import { serialize } from "../../lib/serialize-response.js";
import {
  deriveSessionAlerts,
  type AdminSessionAlert,
  type AdminSessionAlertKind
} from "../../services/admin-session-alerts.js";
import { adminSessionsListQuerySchema } from "./admin-route-schemas.js";
import { withAdmin } from "./admin-route-helpers.js";

export type { AdminSessionAlert, AdminSessionAlertKind };

export type AdminSessionRow = {
  sessionId: string;
  userId: string;
  userEmail: string | null;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  runtimeProvider: "codex" | "claude-code" | null;
  modelName: string | null;
  status: "active" | "completed" | "errored";
  alerts: AdminSessionAlert[];
  skillsUsedCount: number;
  mcpServersUsedCount: number;
};

type CursorPayload = {
  lastActivityAt: string;
  sessionId: string;
};

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<CursorPayload>;
    if (
      typeof parsed.lastActivityAt !== "string" ||
      typeof parsed.sessionId !== "string" ||
      Number.isNaN(Date.parse(parsed.lastActivityAt))
    ) {
      return null;
    }
    return { lastActivityAt: parsed.lastActivityAt, sessionId: parsed.sessionId };
  } catch {
    return null;
  }
}

export async function registerAdminSessionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/sessions",
    withAdmin(app, async (request, reply) => {
      const parsed = parseRequestInput(reply, adminSessionsListQuerySchema, request.query);
      if (!parsed.ok) {
        return parsed.response;
      }

      const { userId, from, to, status, runtime, alert, cursor, limit } = parsed.value;

      const cursorPayload = cursor ? decodeCursor(cursor) : null;
      if (cursor && !cursorPayload) {
        reply.code(400);
        return { error: "invalid_cursor" };
      }

      const { tenantId } = request.auth;

      const { rows, alerts, usage } = await withTenantScope(app.db, tenantId, async (client) => {
        const alertKinds = alert ?? [];
        const result = await client.query(
          `
            SELECT
              s.session_id,
              s.user_id,
              u.email AS user_email,
              s.created_at,
              CASE
                WHEN COALESCE(m.has_error, FALSE) THEN 'errored'
                ELSE 'active'
              END AS admin_status,
              COALESCE(m.last_activity_at, s.created_at) AS last_activity_at,
              COALESCE(m.message_count, 0)::int AS message_count,
              rs.runtime_provider,
              m.last_model_name
            FROM sessions s
            LEFT JOIN users u ON u.user_id = s.user_id
            LEFT JOIN (
              SELECT
                session_id,
                MAX(created_at) AS last_activity_at,
                COUNT(*)        AS message_count,
                BOOL_OR(status IN ('failed', 'error')) AS has_error,
                (ARRAY_AGG(model_name ORDER BY created_at DESC)
                  FILTER (WHERE model_name IS NOT NULL))[1] AS last_model_name
              FROM messages
              WHERE tenant_id = $1
              GROUP BY session_id
            ) m ON m.session_id = s.session_id
            LEFT JOIN LATERAL (
              SELECT runtime_provider
              FROM runtime_sessions
              WHERE session_id = s.session_id
              ORDER BY created_at DESC, id DESC
              LIMIT 1
            ) rs ON TRUE
            WHERE s.tenant_id = $1
              AND s.status <> 'deleted'
              AND ($2::text        IS NULL OR s.user_id = $2)
              AND ($3::timestamptz IS NULL OR s.created_at >= $3)
              AND ($4::timestamptz IS NULL OR s.created_at <= $4)
              AND (
                $5::text IS NULL
                OR ($5 = 'errored' AND COALESCE(m.has_error, FALSE))
                OR ($5 = 'active'  AND NOT COALESCE(m.has_error, FALSE))
              )
              AND ($6::text        IS NULL OR rs.runtime_provider = $6)
              AND (
                $7::timestamptz IS NULL
                OR (COALESCE(m.last_activity_at, s.created_at), s.session_id)
                   < ($7::timestamptz, $8::text)
              )
              AND (
                COALESCE(array_length($10::text[], 1), 0) = 0
                OR (
                  ('pii-blocked' = ANY($10::text[]) AND EXISTS (
                    SELECT 1 FROM pii_scan_runs psr
                    WHERE psr.tenant_id = $1
                      AND psr.source_session_id = s.session_id
                      AND psr.status = 'blocked'
                  ))
                  OR ('pii-transformed' = ANY($10::text[]) AND EXISTS (
                    SELECT 1 FROM pii_scan_runs psr
                    WHERE psr.tenant_id = $1
                      AND psr.source_session_id = s.session_id
                      AND psr.status = 'transformed'
                  ))
                  OR ('pii-detected' = ANY($10::text[]) AND EXISTS (
                    SELECT 1 FROM pii_scan_runs psr
                    WHERE psr.tenant_id = $1
                      AND psr.source_session_id = s.session_id
                      AND psr.status = 'completed'
                      AND jsonb_array_length(psr.findings_json) > 0
                  ))
                  OR ('approval-rejected' = ANY($10::text[]) AND EXISTS (
                    SELECT 1 FROM approvals a
                    WHERE a.tenant_id = $1
                      AND a.session_id = s.session_id
                      AND a.status = 'rejected'
                  ))
                  OR ('approval-pending' = ANY($10::text[]) AND EXISTS (
                    SELECT 1 FROM approvals a
                    WHERE a.tenant_id = $1
                      AND a.session_id = s.session_id
                      AND a.status = 'pending'
                  ))
                  OR ('errored' = ANY($10::text[]) AND EXISTS (
                    SELECT 1 FROM messages me
                    WHERE me.tenant_id = $1
                      AND me.session_id = s.session_id
                      AND me.status IN ('failed', 'error')
                  ))
                )
              )
            ORDER BY last_activity_at DESC, s.session_id DESC
            LIMIT $9
          `,
          [
            tenantId,
            userId ?? null,
            from ?? null,
            to ?? null,
            status ?? null,
            runtime ?? null,
            cursorPayload?.lastActivityAt ?? null,
            cursorPayload?.sessionId ?? null,
            limit + 1,
            alertKinds
          ]
        );
        const fetchedSessionIds = result.rows
          .slice(0, limit)
          .map((row) => String(row.session_id));
        const alertMap = await deriveSessionAlerts(client, tenantId, fetchedSessionIds);

        const usageMap = new Map<
          string,
          { skillsUsedCount: number; mcpServersUsedCount: number }
        >();
        if (fetchedSessionIds.length > 0) {
          const usageResult = await client.query<{
            session_id: string;
            resource_type: string;
            distinct_invoked: string;
          }>(
            `
              SELECT
                session_id,
                resource_type,
                COUNT(DISTINCT resource_id) AS distinct_invoked
              FROM resource_activations
              WHERE tenant_id = $1
                AND session_id = ANY($2::text[])
                AND event_type = 'invoked'
                AND resource_type IN ('skill', 'mcp_server')
              GROUP BY session_id, resource_type
            `,
            [tenantId, fetchedSessionIds]
          );
          for (const row of usageResult.rows) {
            const sessionId = String(row.session_id);
            const entry = usageMap.get(sessionId) ?? {
              skillsUsedCount: 0,
              mcpServersUsedCount: 0
            };
            const count = Number(row.distinct_invoked ?? 0);
            if (row.resource_type === "skill") {
              entry.skillsUsedCount = count;
            } else if (row.resource_type === "mcp_server") {
              entry.mcpServersUsedCount = count;
            }
            usageMap.set(sessionId, entry);
          }
        }

        return { rows: result.rows, alerts: alertMap, usage: usageMap };
      });

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const items: AdminSessionRow[] = pageRows.map((row) => {
        const sessionId = String(row.session_id);
        const usageEntry = usage.get(sessionId);
        return {
          sessionId,
          userId: String(row.user_id),
          userEmail: row.user_email == null ? null : String(row.user_email),
          createdAt: new Date(row.created_at).toISOString(),
          lastActivityAt: new Date(row.last_activity_at).toISOString(),
          messageCount: Number(row.message_count ?? 0),
          runtimeProvider: row.runtime_provider == null ? null : (String(row.runtime_provider) as AdminSessionRow["runtimeProvider"]),
          modelName: row.last_model_name == null ? null : String(row.last_model_name),
          status: String(row.admin_status) as AdminSessionRow["status"],
          alerts: alerts.get(sessionId) ?? [],
          skillsUsedCount: usageEntry?.skillsUsedCount ?? 0,
          mcpServersUsedCount: usageEntry?.mcpServersUsedCount ?? 0
        };
      });

      const nextCursor = hasMore && items.length > 0
        ? encodeCursor({
            lastActivityAt: items[items.length - 1].lastActivityAt,
            sessionId: items[items.length - 1].sessionId
          })
        : null;

      return serialize(AdminSessionsListResponseSchema, { items, nextCursor });
    })
  );
}
