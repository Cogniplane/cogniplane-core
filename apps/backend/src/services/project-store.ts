import { escapeLikePattern, type Pool, withTenantScope } from "../lib/db.js";
import { AuditEventStore } from "./audit-event-store.js";
import { uuidv7 } from "../lib/uuid.js";
import { isoTimestamp } from "../lib/db-mappers.js";
import { ProjectAccessError, projectRoleSql, requireProjectAccess } from "./project-access.js";
import type { PoolClient } from "pg";
import { ProjectApprovalModeSchema, type Project, type ProjectAgentFileMode, type ProjectApprovalMode } from "@cogniplane/shared-types";

// Conversation activity and new files count as project activity, without
// touching a project row on every message or scan-progress write.
const activity = `GREATEST(p.updated_at,
  (SELECT MAX(s.updated_at) FROM sessions s WHERE s.project_id = p.project_id AND s.tenant_id = p.tenant_id),
  (SELECT MAX(a.created_at) FROM artifacts a JOIN sessions s ON s.session_id = a.session_id AND s.tenant_id = a.tenant_id
   WHERE s.project_id = p.project_id AND s.tenant_id = p.tenant_id))`;
const projection = `p.project_id, p.name, p.instructions, p.instructions_revision, p.approval_mode, p.agent_file_mode, p.archived_at, p.created_at, ${activity} AS updated_at, r.session_id AS reference_session_id`;
const referenceJoin = `JOIN sessions r ON r.project_id = p.project_id AND r.tenant_id = p.tenant_id
  AND r.user_id = p.user_id AND r.purpose = 'project_reference'`;
function map(row: Record<string, unknown>): Project {
  const approvalMode = ProjectApprovalModeSchema.safeParse(row.approval_mode);
  return {
    projectId: String(row.project_id),
    name: String(row.name),
    instructions: String(row.instructions ?? ""),
    instructionsRevision: Number(row.instructions_revision ?? 0),
    approvalMode: approvalMode.success ? approvalMode.data : "organization_default",
    agentFileMode: row.agent_file_mode === "create-only" || row.agent_file_mode === "read-write"
      ? row.agent_file_mode
      : "read-only",
    archivedAt: row.archived_at ? isoTimestamp(row.archived_at) : null,
    referenceSessionId: String(row.reference_session_id),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}
export class ProjectStore {
  constructor(private readonly db: Pool) {}

  private async authorize(db: PoolClient, tenantId: string, userId: string,
    projectId: string, minimum: "owner" | "editor", active = true) {
    // The project lock serializes archive and explicit role changes. Organization
    // departure can still delete tenant_memberships. The SQL role predicates below
    // also catch a departure committed after this check.
    return requireProjectAccess(db, { tenantId, userId, projectId }, minimum, { lock: true, active });
  }

  private async assertNoActiveTurns(db: PoolClient, tenantId: string, projectId: string, message: string) {
    const running = await db.query(`SELECT 1 FROM session_executions
      WHERE tenant_id=$1 AND project_id=$2 AND status='active' AND expires_at>clock_timestamp() LIMIT 1`,
    [tenantId, projectId]);
    if (running.rowCount) throw new ProjectAccessError("project_busy", message, 409);
  }

  async list(tenantId: string, userId: string, options: { archived?: boolean; q?: string } = {}) {
    const query = options.q?.trim();
    return withTenantScope(this.db, tenantId, async (db) => {
      const values: unknown[] = [tenantId, userId, options.archived ?? false];
      if (query) values.push(`%${escapeLikePattern(query)}%`);
      const rows = await db.query(
        `SELECT ${projection} FROM projects p ${referenceJoin}
        WHERE p.tenant_id = $1 AND ${projectRoleSql("p", "$2")} IS NOT NULL AND (p.archived_at IS NOT NULL) = $3
          ${query ? `AND (p.name ILIKE $4 OR EXISTS (
            SELECT 1 FROM artifacts a JOIN sessions s ON s.session_id = a.session_id
              AND s.tenant_id = a.tenant_id
            WHERE s.project_id = p.project_id AND s.tenant_id = $1
              AND s.status <> 'deleted' AND a.status <> 'deleted' AND a.artifact_type <> 'derived'
              AND a.artifact_name ILIKE $4))` : ""}
        ORDER BY updated_at DESC, p.project_id`,
        values
      );
      return rows.rows.map(map);
    });
  }
  async getInstructionsStatus(tenantId: string, userId: string, projectId: string) {
    return withTenantScope(this.db, tenantId, async (db) => {
      const result = await db.query(
        `SELECT project_id, instructions <> '' AS has_instructions, instructions_revision
         FROM projects p WHERE tenant_id = $1 AND ${projectRoleSql("p", "$2")} IS NOT NULL AND project_id = $3`,
        [tenantId, userId, projectId]
      );
      const row = result.rows[0];
      return row ? { projectId: String(row.project_id), hasInstructions: Boolean(row.has_instructions),
        instructionsRevision: Number(row.instructions_revision) } : null;
    });
  }
  async getReadable(tenantId: string, userId: string, projectId: string): Promise<(Project & { canManage: boolean; canEdit: boolean }) | null> {
    return withTenantScope(this.db, tenantId, async (db) => {
      const result = await db.query(
        `SELECT ${projection}, (${projectRoleSql("p", "$2")} = 'owner') AS can_manage,
          (${projectRoleSql("p", "$2")} IN ('owner', 'editor')) AS can_edit
         FROM projects p ${referenceJoin}
         WHERE p.tenant_id = $1 AND ${projectRoleSql("p", "$2")} IS NOT NULL AND p.project_id = $3`,
        [tenantId, userId, projectId]
      );
      return result.rows[0]
        ? {
          ...map(result.rows[0]),
          canManage: result.rows[0].can_manage === true,
          canEdit: result.rows[0].can_edit === true,
        }
        : null;
    });
  }

  async getOwned(tenantId: string, userId: string, projectId: string) {
    return withTenantScope(this.db, tenantId, async (db) => {
      const rows = await db.query(
        `SELECT ${projection} FROM projects p ${referenceJoin}
        WHERE p.tenant_id = $1 AND ${projectRoleSql("p", "$2")} = 'owner' AND p.project_id = $3`,
        [tenantId, userId, projectId]
      );
      return rows.rows[0] ? map(rows.rows[0]) : null;
    });
  }
  async getEditable(tenantId: string, userId: string, projectId: string): Promise<Project | null> {
    return withTenantScope(this.db, tenantId, async db => {
      const rows = await db.query(`SELECT ${projection} FROM projects p ${referenceJoin}
        WHERE p.tenant_id=$1 AND p.project_id=$3 AND ${projectRoleSql("p", "$2")} IN ('owner','editor')`,
      [tenantId, userId, projectId]);
      return rows.rows[0] ? map(rows.rows[0]) : null;
    });
  }
  async create(tenantId: string, userId: string, name: string) {
    return withTenantScope(this.db, tenantId, async (db) => {
      const projectId = uuidv7();
      const referenceSessionId = uuidv7();
      const result = await db.query(
        `INSERT INTO projects (tenant_id, user_id, project_id, name)
        VALUES ($1, $2, $3, $4) RETURNING *`,
        [tenantId, userId, projectId, name]
      );
      await db.query(
        `INSERT INTO project_memberships (tenant_id, project_id, user_id, role) VALUES ($1,$2,$3,'owner')`,
        [tenantId, projectId, userId]
      );
      await db.query(
        `INSERT INTO sessions (tenant_id, user_id, session_id, session_name, purpose, project_id)
        VALUES ($1, $2, $3, $4, 'project_reference', $5)`,
        [tenantId, userId, referenceSessionId, name, projectId]
      );
      return map({ ...result.rows[0], reference_session_id: referenceSessionId });
    });
  }
  async updateInstructions(tenantId: string, userId: string, projectId: string,
    instructions: string, expectedRevision: number) {
    return withTenantScope(this.db, tenantId, async (db) => {
      await this.authorize(db, tenantId, userId, projectId, "owner", true);
      const result = await db.query(
        `UPDATE projects p SET instructions = $4,
          instructions_revision = instructions_revision + 1, updated_at = NOW()
         WHERE tenant_id = $1 AND ${projectRoleSql("p", "$2")} = 'owner' AND project_id = $3 AND instructions_revision = $5
         RETURNING instructions_revision`,
        [tenantId, userId, projectId, instructions, expectedRevision]
      );
      // Distinguish organization departure since authorization from a stale revision.
      // We already hold the project lock, so only the membership read must repeat.
      if (result.rowCount !== 1) await requireProjectAccess(db, { tenantId, userId, projectId }, "owner", { active: true });
      return result.rowCount === 1;
    });
  }
  async setApprovalMode(
    tenantId: string,
    userId: string,
    projectId: string,
    approvalMode: ProjectApprovalMode
  ): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (db) => {
      await this.authorize(db, tenantId, userId, projectId, "owner", true);
      const result = await db.query(
        `UPDATE projects p SET approval_mode = $4, updated_at = NOW()
         WHERE tenant_id = $1 AND ${projectRoleSql("p", "$2")} = 'owner' AND project_id = $3
         RETURNING p.project_id`,
        [tenantId, userId, projectId, approvalMode]
      );
      if (result.rowCount === 1) {
        await AuditEventStore.createInTransaction(db, {
          tenantId,
          userId,
          sessionId: null,
          type: "project_approval_mode_changed",
          payload: { projectId, approvalMode },
        });
      }
      return result.rowCount === 1;
    });
  }
  async setAgentFileMode(
    tenantId: string,
    userId: string,
    projectId: string,
    agentFileMode: ProjectAgentFileMode
  ): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (db) => {
      await this.authorize(db, tenantId, userId, projectId, "owner", true);
      const result = await db.query(
        `UPDATE projects p SET agent_file_mode = $4, updated_at = NOW()
         WHERE tenant_id = $1 AND ${projectRoleSql("p", "$2")} = 'owner' AND project_id = $3
         RETURNING p.project_id`,
        [tenantId, userId, projectId, agentFileMode]
      );
      if (result.rowCount === 1) {
        await AuditEventStore.createInTransaction(db, {
          tenantId,
          userId,
          sessionId: null,
          type: "project_agent_file_mode_changed",
          payload: { projectId, agentFileMode },
        });
      }
      return result.rowCount === 1;
    });
  }
  async setArchived(tenantId: string, userId: string, projectId: string, archived: boolean) {
    return withTenantScope(this.db, tenantId, async (db) => {
      await this.authorize(db, tenantId, userId, projectId, "owner", false);
      if (archived) {
        await this.assertNoActiveTurns(db, tenantId, projectId,
          "Finish or cancel active turns before archiving this project.");
      }
      const result = await db.query(
        `UPDATE projects p SET archived_at = CASE WHEN $4 THEN COALESCE(archived_at, NOW()) ELSE NULL END,
          updated_at = NOW() WHERE tenant_id = $1 AND ${projectRoleSql("p", "$2")} = 'owner' AND project_id = $3
          RETURNING project_id`,
        [tenantId, userId, projectId, archived]
      );
      if (result.rowCount !== 1) return false;
      await AuditEventStore.createInTransaction(db, {
        tenantId, userId, sessionId: null,
        type: archived ? "project_archived" : "project_restored",
        payload: { projectId },
      });
      return true;
    });
  }

  // Whole-project deletion is intentionally not part of the current product
  // surface. Projects can be archived; individual sessions and files use
  // their own recovery and retention flows.
  async rename(tenantId: string, userId: string, projectId: string, name: string) {
    return withTenantScope(this.db, tenantId, async (db) => {
      await this.authorize(db, tenantId, userId, projectId, "owner", true);
      const result = await db.query(
        `UPDATE projects p SET name = $4, updated_at = NOW()
        FROM sessions r WHERE p.tenant_id = $1 AND ${projectRoleSql("p", "$2")} = 'owner' AND p.project_id = $3
          AND r.project_id = p.project_id AND r.tenant_id = p.tenant_id AND r.user_id = p.user_id
          AND r.purpose = 'project_reference'
        RETURNING p.project_id, p.name, p.instructions, p.instructions_revision, p.approval_mode, p.agent_file_mode, p.archived_at, p.created_at, p.updated_at, r.session_id AS reference_session_id`,
        [tenantId, userId, projectId, name]
      );
      return result.rows[0] ? map(result.rows[0]) : null;
    });
  }
  async setSession(
    tenantId: string,
    userId: string,
    projectId: string,
    sessionId: string
  ) {
    return withTenantScope(this.db, tenantId, async (db) => {
      await this.authorize(db, tenantId, userId, projectId, "editor");
      const previous = await db.query(
        `SELECT project_id FROM sessions
         WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3
           AND status = 'active' AND purpose = 'normal' FOR UPDATE`,
        [tenantId, userId, sessionId]
      );
      if (!previous.rows[0]) return false;
      // Repeating the same assignment is harmless; moving or detaching is forbidden.
      if (previous.rows[0].project_id !== null) {
        return previous.rows[0].project_id === projectId;
      }
      const result = await db.query(
        `UPDATE sessions SET project_id = $3
         WHERE tenant_id = $1 AND user_id = $2 AND session_id = $4
           AND project_id IS NULL`,
        [tenantId, userId, projectId, sessionId]
      );
      if (result.rowCount === 1) {
        await db.query(
          `UPDATE projects SET updated_at = NOW() WHERE tenant_id = $1 AND project_id = $2`,
          [tenantId, projectId]
        );
      }
      return result.rowCount === 1;
    });
  }

  async createSession(tenantId: string, userId: string, projectId: string, name: string) {
    return withTenantScope(this.db, tenantId, async (db) => {
      await this.authorize(db, tenantId, userId, projectId, "editor", true);
      const sessionId = uuidv7();
      const result = await db.query(
        `INSERT INTO sessions (tenant_id, user_id, session_id, session_name, project_id)
        SELECT $1, $2, $4, $5, p.project_id FROM projects p
        WHERE p.tenant_id = $1 AND ${projectRoleSql("p", "$2")} IN ('owner','editor') AND p.project_id = $3 RETURNING session_id`,
        [tenantId, userId, projectId, sessionId, name]
      );
      return result.rows[0] ? sessionId : null;
    });
  }
}
