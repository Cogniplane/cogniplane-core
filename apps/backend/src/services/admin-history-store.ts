import { createHash } from "node:crypto";
import { z } from "zod";
import { AdminHistoryIdSchema, type AdminHistoryDetailResponse, type AdminHistoryListQuery, type AdminHistoryListResponse } from "@cogniplane/shared-types";
import { type Pool, withTenantScope } from "../lib/db.js";
import { utcMicrosText } from "../lib/db-mappers.js";
import { HISTORY_EVENTS, HISTORY_EVENT_TYPES, SETTINGS_EVENT, isHistoryEventType, projectHistoryEvent, type HistoryRow } from "./admin-history-projection.js";
import { compareSettings } from "./admin-settings-comparison.js";

export class HistoryInputError extends Error {}
const CursorSchema = z.object({
  id: AdminHistoryIdSchema,
  at: z.string().datetime({ precision: 6 }),
  scope: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const COLUMNS = `a.id::text AS id, a.event_type, a.payload, a.user_id, u.display_name,
  ${utcMicrosText("a.created_at")} AS created_at`;
const FROM = "FROM audit_events a LEFT JOIN users u ON u.user_id=a.user_id";

function eventTypes(query: AdminHistoryListQuery): string[] {
  if (query.type && !isHistoryEventType(query.type)) throw new HistoryInputError("Unknown history type.");
  return HISTORY_EVENT_TYPES.filter((type) => (!query.type || type === query.type)
    && (!query.category || HISTORY_EVENTS[type].category === query.category)
    && (!query.section || (query.section === "agent" ? type === SETTINGS_EVENT
      : type === SETTINGS_EVENT || type.startsWith("admin.policy_rule."))));
}
function scopeHash(tenantId: string, types: string[]): string {
  return createHash("sha256").update(JSON.stringify([tenantId, types])).digest("hex");
}
function decodeCursor(text: string, scope: string) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(text, "base64url").toString("utf8")));
    if (parsed.scope !== scope || !Number.isFinite(Date.parse(parsed.at))) throw new Error();
    return parsed;
  } catch { throw new HistoryInputError("This history cursor is invalid for the selected filter."); }
}

export class AdminHistoryStore {
  constructor(private readonly db: Pool) {}

  async list(tenantId: string, query: AdminHistoryListQuery): Promise<AdminHistoryListResponse> {
    const types = eventTypes(query), scope = scopeHash(tenantId, types);
    const cursor = query.cursor ? decodeCursor(query.cursor, scope) : null;
    return withTenantScope(this.db, tenantId, async (db) => {
      const result = await db.query<HistoryRow>(`SELECT ${COLUMNS} ${FROM}
        WHERE a.tenant_id=$1 AND a.event_type=ANY($2::text[])
          AND ($3::timestamptz IS NULL OR (a.created_at,a.id)<($3::timestamptz,$4::bigint))
        ORDER BY a.created_at DESC,a.id DESC LIMIT $5`,
      [tenantId, types, cursor?.at ?? null, cursor?.id ?? null, query.limit + 1]);
      const rows = result.rows.slice(0, query.limit), last = rows.at(-1);
      return { items: rows.map(projectHistoryEvent), nextCursor: result.rows.length > query.limit && last
        ? Buffer.from(JSON.stringify({ id: last.id, at: last.created_at, scope })).toString("base64url") : null };
    });
  }

  async detail(tenantId: string, eventId: string, compareTo?: string): Promise<AdminHistoryDetailResponse | null> {
    return withTenantScope(this.db, tenantId, async (db) => {
      const get = async (id: string) => (await db.query<HistoryRow>(`SELECT ${COLUMNS} ${FROM}
        WHERE a.tenant_id=$1 AND a.id=$2::bigint AND a.event_type=ANY($3::text[])`, [tenantId, id, HISTORY_EVENT_TYPES])).rows[0];
      const row = await get(eventId);
      if (!row) return null;
      if (row.event_type !== SETTINGS_EVENT) {
        if (compareTo) throw new HistoryInputError("Only recorded settings can be compared.");
        return { event: projectHistoryEvent(row), comparison: null };
      }
      let other: HistoryRow | undefined;
      if (compareTo) {
        if (compareTo === eventId) throw new HistoryInputError("Choose two different settings records.");
        other = await get(compareTo);
        if (!other || other.event_type !== SETTINGS_EVENT) return null;
      } else {
        other = (await db.query<HistoryRow>(`SELECT ${COLUMNS} ${FROM}
          WHERE a.tenant_id=$1 AND a.event_type=$2 AND (a.created_at,a.id)<($3::timestamptz,$4::bigint)
          ORDER BY a.created_at DESC,a.id DESC LIMIT 1`, [tenantId, SETTINGS_EVENT, row.created_at, row.id])).rows[0];
      }
      // Timestamp strings have the same UTC format and six digits of precision.
      const rowFirst = other && (row.created_at < other.created_at ||
        (row.created_at === other.created_at && BigInt(row.id) < BigInt(other.id)));
      return { event: projectHistoryEvent(row), comparison: other
        ? rowFirst ? compareSettings(row, other) : compareSettings(other, row) : null };
    });
  }
}
