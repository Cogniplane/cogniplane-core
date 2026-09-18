import { withTenantScope, type Pool } from "../lib/db.js";
import { uuidv7 } from "../lib/uuid.js";
import { requireProjectAccess } from "./project-access.js";
import { sessionUploadAccessSql } from "./session-upload-access.js";
import { AuditEventStore } from "./audit-event-store.js";

export type ExecutionActor = { tenantId: string; sessionId: string; userId: string };
export type SessionExecution = ExecutionActor & {
  executionId: string;
  projectId: string | null;
  /** Database-issued lease expiry used by the local watchdog. */
  expiresAt: string;
};

export class SessionExecutionError extends Error {
  constructor(readonly code: "session_unavailable" | "session_busy" | "execution_stopped", readonly statusCode: number) {
    super(code === "session_busy" ? "A turn is already running in this session."
      : code === "execution_stopped" ? "This turn stopped because its execution permission is no longer valid."
        : "This session is unavailable for execution.");
  }
}

// Shared by admission and every dispatch check. Reference sessions hold files
// and cannot run an agent. Upload authorization has the same active editor rule.
export function sessionExecutionAccessSql(session: string, user: string): string {
  return `(${session}.purpose <> 'project_reference' AND ${sessionUploadAccessSql(session, user)})`;
}

// Standalone contexts keep their existing lifecycle. Project contexts must name
// the exact admitted execution; TTL alone never authorizes a shared turn.
export function projectContextExecutionSql(context: string): string {
  return `EXISTS (SELECT 1 FROM sessions execution_session
    WHERE execution_session.tenant_id=${context}.tenant_id AND execution_session.session_id=${context}.session_id
      AND (execution_session.project_id IS NULL OR EXISTS (
        SELECT 1 FROM session_executions execution
        WHERE execution.tenant_id=${context}.tenant_id AND execution.session_id=${context}.session_id
          AND execution.user_id=${context}.user_id AND execution.runtime_id=${context}.runtime_id
          AND execution.execution_id=${context}.metadata->>'executionId'
          AND execution.status='active' AND execution.expires_at>clock_timestamp()
          AND ${sessionExecutionAccessSql("execution_session", `${context}.user_id`)}
      )))`;
}

export class SessionExecutionStore {
  constructor(private readonly pool: Pool) {}

  async acquire(actor: ExecutionActor, leaseMs: number): Promise<SessionExecution> {
    return withTenantScope(this.pool, actor.tenantId, async (db) => {
      const initial = await db.query("SELECT project_id FROM sessions WHERE tenant_id=$1 AND session_id=$2",
        [actor.tenantId, actor.sessionId]);
      if (!initial.rows[0]) throw new SessionExecutionError("session_unavailable", 404);
      const projectId = initial.rows[0].project_id as string | null;
      if (projectId) await requireProjectAccess(db, { ...actor, projectId }, "editor", { lock: true, active: true });
      // Project-before-session matches assignment and project mutations.
      const session = await db.query("SELECT project_id FROM sessions WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE",
        [actor.tenantId, actor.sessionId]);
      if (!session.rows[0] || session.rows[0].project_id !== projectId)
        throw new SessionExecutionError("session_unavailable", 409);
      // Departure must wait until the new execution is visible to its trigger.
      const member = await db.query("SELECT user_id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE",
        [actor.tenantId, actor.userId]);
      if (!member.rows[0]) throw new SessionExecutionError("session_unavailable", 404);
      const allowed = await db.query(`SELECT session_id FROM sessions s WHERE tenant_id=$1 AND session_id=$2
        AND ${sessionExecutionAccessSql("s", "$3")}`, [actor.tenantId, actor.sessionId, actor.userId]);
      if (!allowed.rows[0]) throw new SessionExecutionError("session_unavailable", 404);
      const current = await db.query(`SELECT execution_id FROM session_executions
        WHERE tenant_id=$1 AND session_id=$2 AND status='active' AND expires_at>clock_timestamp()`,
      [actor.tenantId, actor.sessionId]);
      if (current.rows[0]) throw new SessionExecutionError("session_busy", 409);
      // Fire approval expiry before replacing an expired generation.
      await db.query(`UPDATE session_executions SET status='stopped', stop_reason='lease_expired', updated_at=NOW()
        WHERE tenant_id=$1 AND session_id=$2 AND status='active'`, [actor.tenantId, actor.sessionId]);
      const executionId = uuidv7();
      const inserted = await db.query(`INSERT INTO session_executions
        (tenant_id,session_id,execution_id,user_id,project_id,status,expires_at)
        VALUES ($1,$2,$3,$4,$5,'active',clock_timestamp()+$6*INTERVAL '1 millisecond')
        ON CONFLICT (tenant_id,session_id) DO UPDATE SET execution_id=EXCLUDED.execution_id,
          user_id=EXCLUDED.user_id, project_id=EXCLUDED.project_id, runtime_id=NULL, status='active',
          stop_reason=NULL, expires_at=EXCLUDED.expires_at, started_at=NOW(), updated_at=NOW()
        RETURNING expires_at`,
      [actor.tenantId, actor.sessionId, executionId, actor.userId, projectId, leaseMs]);
      return { ...actor, executionId, projectId, expiresAt: new Date(inserted.rows[0].expires_at).toISOString() };
    });
  }

  async bindRuntime(execution: SessionExecution, runtimeId: string): Promise<void> {
    const updated = await withTenantScope(this.pool, execution.tenantId, (db) => db.query(
      `UPDATE session_executions SET runtime_id=$4, updated_at=NOW()
       WHERE tenant_id=$1 AND execution_id=$2 AND user_id=$3 AND status='active'
         AND expires_at>clock_timestamp() AND (runtime_id IS NULL OR runtime_id=$4) RETURNING execution_id`,
      [execution.tenantId, execution.executionId, execution.userId, runtimeId]));
    if (!updated.rows[0]) throw new SessionExecutionError("execution_stopped", 403);
  }

  async isCurrent(execution: SessionExecution, runtimeId?: string): Promise<boolean> {
    return withTenantScope(this.pool, execution.tenantId, async (db) => {
      const result = await db.query(`SELECT e.execution_id FROM session_executions e JOIN sessions s
        ON s.tenant_id=e.tenant_id AND s.session_id=e.session_id
        WHERE e.tenant_id=$1 AND e.session_id=$2 AND e.user_id=$3 AND e.execution_id=$4
          AND e.status='active' AND e.expires_at>clock_timestamp()
          AND ($5::text IS NULL OR e.runtime_id=$5) AND s.project_id IS NOT DISTINCT FROM e.project_id
          AND ${sessionExecutionAccessSql("s", "e.user_id")}
          AND EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id=e.tenant_id AND tm.user_id=e.user_id)`,
      [execution.tenantId, execution.sessionId, execution.userId, execution.executionId, runtimeId ?? null]);
      return Boolean(result.rows[0]);
    });
  }

  async heartbeat(execution: SessionExecution, leaseMs: number): Promise<boolean> {
    return withTenantScope(this.pool, execution.tenantId, async (db) => {
      const result = await db.query(`UPDATE session_executions e
        SET expires_at=clock_timestamp()+$5*INTERVAL '1 millisecond', updated_at=NOW()
        FROM sessions s WHERE s.tenant_id=e.tenant_id AND s.session_id=e.session_id
          AND e.tenant_id=$1 AND e.session_id=$2 AND e.user_id=$3 AND e.execution_id=$4
          AND e.status='active' AND e.expires_at>clock_timestamp()
          AND s.project_id IS NOT DISTINCT FROM e.project_id
          AND ${sessionExecutionAccessSql("s", "e.user_id")}
          AND EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id=e.tenant_id AND tm.user_id=e.user_id)
        RETURNING e.execution_id`,
      [execution.tenantId, execution.sessionId, execution.userId, execution.executionId, leaseMs]);
      return Boolean(result.rows[0]);
    });
  }

  async release(execution: SessionExecution): Promise<void> {
    await withTenantScope(this.pool, execution.tenantId, (db) => db.query(
      `UPDATE session_executions SET status='finished', updated_at=NOW()
        WHERE tenant_id=$1 AND execution_id=$2 AND user_id=$3 AND status='active'`,
      [execution.tenantId, execution.executionId, execution.userId]));
  }

  async stop(actor: ExecutionActor): Promise<boolean> {
    return withTenantScope(this.pool, actor.tenantId, async (db) => {
      const result = await db.query(`UPDATE session_executions e
        SET status='stopped', stop_reason='cancelled', updated_at=NOW()
        FROM sessions s WHERE s.tenant_id=e.tenant_id AND s.session_id=e.session_id
          AND e.tenant_id=$1 AND e.session_id=$2 AND e.status='active'
          AND ${sessionExecutionAccessSql("s", "$3")}
        RETURNING e.execution_id, e.user_id, e.runtime_id`, [actor.tenantId, actor.sessionId, actor.userId]);
      const stopped = result.rows[0];
      if (!stopped) return false;
      await AuditEventStore.createInTransaction(db, {
        ...actor, type: "turn.interrupted",
        payload: { executionId: stopped.execution_id, initiatorUserId: stopped.user_id, runtimeId: stopped.runtime_id }
      });
      return true;
    });
  }
}
