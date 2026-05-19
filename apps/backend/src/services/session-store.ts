
import { type Pool, withTenantScope } from "../lib/db.js";
import { uuidv7 } from "../lib/uuid.js";

export type SessionRecord = {
  sessionId: string;
  userId: string;
  sessionName: string;
  status: "active" | "deleted";
  // Coarse UI bucket; "skill_improvement" lets the chat shell render an
  // improver-specific banner. Defaults to "normal" everywhere it isn't set.
  // Optional so test fakes constructing partial SessionRecord values keep
  // compiling — production rows always carry a value because the column has
  // a NOT NULL DEFAULT 'normal'.
  purpose?: string;
  createdAt: string;
  updatedAt: string;
  hasPendingApprovals?: boolean;
  isRunning?: boolean;
};

function mapSession(row: Record<string, unknown>): SessionRecord {
  const record: SessionRecord = {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    sessionName: String(row.session_name),
    status: row.status === "deleted" ? "deleted" : "active",
    purpose: row.purpose ? String(row.purpose) : "normal",
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
  if (row.has_pending_approvals !== undefined) {
    record.hasPendingApprovals = Boolean(row.has_pending_approvals);
  }
  return record;
}

export class SessionStore {
  constructor(private readonly db: Pool) {}

  /**
   * Lists active sessions for a user. By default only `purpose = 'normal'`
   * sessions are returned — improver runs (`skill_improvement`) and any
   * future special-purpose sessions are hidden from the main chat sidebar
   * unless the caller opts in via `purposes`.
   *
   * Pass `purposes: 'all'` (or an explicit list) to include them. Empty
   * list = same as default.
   */
  async list(
    tenantId: string,
    userId: string,
    options: { purposes?: string[] | "all" } = {}
  ): Promise<SessionRecord[]> {
    const purposes = options.purposes;
    const includeAll = purposes === "all";
    const purposeList = includeAll
      ? null
      : Array.isArray(purposes) && purposes.length > 0
        ? purposes
        : ["normal"];

    return withTenantScope(this.db, tenantId, async (client) => {
      const params: unknown[] = [tenantId, userId];
      let purposeClause = "";
      if (purposeList) {
        params.push(purposeList);
        purposeClause = `AND s.purpose = ANY($${params.length}::text[])`;
      }
      const sessionRows = await client.query(
        `
          SELECT
            s.session_id,
            s.user_id,
            s.session_name,
            s.status,
            s.purpose,
            s.created_at,
            s.updated_at,
            EXISTS (
              SELECT 1
              FROM approvals a
              WHERE a.tenant_id = s.tenant_id
                AND a.session_id = s.session_id
                AND a.user_id = s.user_id
                AND a.status = 'pending'
            ) AS has_pending_approvals
          FROM sessions s
          WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.status = 'active'
            ${purposeClause}
          ORDER BY s.updated_at DESC
        `,
        params
      );
      return sessionRows.rows.map(mapSession);
    });
  }

  async create(
    tenantId: string,
    userId: string,
    sessionName: string,
    options: { purpose?: string } = {}
  ): Promise<SessionRecord> {
    const sessionId = uuidv7();
    const purpose = options.purpose ?? "normal";
    return withTenantScope(this.db, tenantId, async (client) => {
      const insertedSession = await client.query(
        `
          INSERT INTO sessions (session_id, tenant_id, user_id, session_name, purpose)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING session_id, user_id, session_name, status, purpose, created_at, updated_at
        `,
        [sessionId, tenantId, userId, sessionName, purpose]
      );
      return mapSession(insertedSession.rows[0]);
    });
  }

  async getOwned(tenantId: string, sessionId: string, userId: string): Promise<SessionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const sessionRows = await client.query(
        `
          SELECT session_id, user_id, session_name, status, purpose, created_at, updated_at
          FROM sessions
          WHERE tenant_id = $1 AND session_id = $2 AND user_id = $3
          LIMIT 1
        `,
        [tenantId, sessionId, userId]
      );
      return sessionRows.rows[0] ? mapSession(sessionRows.rows[0]) : null;
    });
  }

  async rename(tenantId: string, sessionId: string, userId: string, sessionName: string): Promise<SessionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const renamedSession = await client.query(
        `
          UPDATE sessions
          SET session_name = $4, updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2 AND user_id = $3 AND status = 'active'
          RETURNING session_id, user_id, session_name, status, purpose, created_at, updated_at
        `,
        [tenantId, sessionId, userId, sessionName]
      );
      return renamedSession.rows[0] ? mapSession(renamedSession.rows[0]) : null;
    });
  }

  async renameIfCurrent(
    tenantId: string,
    sessionId: string,
    userId: string,
    expectedCurrentName: string,
    newName: string
  ): Promise<SessionRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const renamedSession = await client.query(
        `
          UPDATE sessions
          SET session_name = $5, updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2 AND user_id = $3 AND status = 'active'
            AND session_name = $4
          RETURNING session_id, user_id, session_name, status, purpose, created_at, updated_at
        `,
        [tenantId, sessionId, userId, expectedCurrentName, newName]
      );
      return renamedSession.rows[0] ? mapSession(renamedSession.rows[0]) : null;
    });
  }

  async remove(tenantId: string, sessionId: string, userId: string): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const removalUpdate = await client.query(
        `
          UPDATE sessions
          SET status = 'deleted', updated_at = NOW()
          WHERE tenant_id = $1 AND session_id = $2 AND user_id = $3 AND status = 'active'
        `,
        [tenantId, sessionId, userId]
      );
      return (removalUpdate.rowCount ?? 0) > 0;
    });
  }
}
