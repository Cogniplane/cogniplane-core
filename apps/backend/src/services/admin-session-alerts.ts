import type { PoolClient } from "pg";

export type AdminSessionAlertKind =
  | "pii-blocked"
  | "pii-transformed"
  | "pii-detected"
  | "approval-rejected"
  | "approval-pending"
  | "errored";

export type AdminSessionAlert = {
  kind: AdminSessionAlertKind;
  count: number;
};

const BADGE_ORDER: Record<AdminSessionAlertKind, number> = {
  "pii-blocked": 0,
  "pii-transformed": 1,
  "pii-detected": 2,
  "approval-rejected": 3,
  "approval-pending": 4,
  errored: 5
};

function pushBadge(
  map: Map<string, AdminSessionAlert[]>,
  sessionId: string,
  kind: AdminSessionAlertKind,
  count: number
): void {
  if (count <= 0) return;
  const existing = map.get(sessionId) ?? [];
  existing.push({ kind, count });
  map.set(sessionId, existing);
}

export async function deriveSessionAlerts(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  sessionIds: string[]
): Promise<Map<string, AdminSessionAlert[]>> {
  const result = new Map<string, AdminSessionAlert[]>();
  if (sessionIds.length === 0) {
    return result;
  }

  const [piiResult, approvalResult, errorResult] = await Promise.all([
    client.query(
      `
        SELECT source_session_id, kind, SUM(count)::int AS count
        FROM (
          SELECT
            source_session_id,
            CASE
              WHEN status = 'blocked'     THEN 'pii-blocked'
              WHEN status = 'transformed' THEN 'pii-transformed'
              WHEN status = 'completed' AND jsonb_array_length(findings_json) > 0 THEN 'pii-detected'
            END AS kind,
            COUNT(*)::int AS count
          FROM pii_scan_runs
          WHERE tenant_id = $1
            AND source_session_id = ANY($2::text[])
            AND (
              status IN ('blocked', 'transformed')
              OR (status = 'completed' AND jsonb_array_length(findings_json) > 0)
            )
          GROUP BY source_session_id, status, (jsonb_array_length(findings_json) > 0)
        ) buckets
        WHERE kind IS NOT NULL
        GROUP BY source_session_id, kind
      `,
      [tenantId, sessionIds]
    ),
    client.query(
      `
        SELECT session_id, kind, SUM(count)::int AS count
        FROM (
          SELECT
            session_id,
            CASE
              WHEN status = 'rejected' THEN 'approval-rejected'
              WHEN status = 'pending'  THEN 'approval-pending'
            END AS kind,
            COUNT(*)::int AS count
          FROM approvals
          WHERE tenant_id = $1
            AND session_id = ANY($2::text[])
            AND status IN ('rejected', 'pending')
          GROUP BY session_id, status
        ) buckets
        WHERE kind IS NOT NULL
        GROUP BY session_id, kind
      `,
      [tenantId, sessionIds]
    ),
    client.query(
      `
        SELECT session_id, COUNT(*)::int AS count
        FROM messages
        WHERE tenant_id = $1
          AND session_id = ANY($2::text[])
          AND status IN ('failed', 'error')
        GROUP BY session_id
      `,
      [tenantId, sessionIds]
    )
  ]);

  for (const row of piiResult.rows) {
    if (!row.kind) continue;
    pushBadge(
      result,
      String(row.source_session_id),
      row.kind as AdminSessionAlertKind,
      Number(row.count ?? 0)
    );
  }

  for (const row of approvalResult.rows) {
    if (!row.kind) continue;
    pushBadge(
      result,
      String(row.session_id),
      row.kind as AdminSessionAlertKind,
      Number(row.count ?? 0)
    );
  }

  for (const row of errorResult.rows) {
    pushBadge(
      result,
      String(row.session_id),
      "errored",
      Number(row.count ?? 0)
    );
  }

  for (const badges of result.values()) {
    badges.sort((a, b) => BADGE_ORDER[a.kind] - BADGE_ORDER[b.kind]);
  }

  return result;
}
