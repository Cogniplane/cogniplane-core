import { withTenantScope, type Pool } from "../lib/db.js";
import { uuidv7 } from "../lib/uuid.js";
import { requireProjectAccess } from "./project-access.js";
import { sessionUploadAccessSql } from "./session-upload-access.js";
import { AuditEventStore } from "./audit-event-store.js";

export type ExecutionActor = { tenantId: string; sessionId: string; userId: string };
export type SessionExecution = ExecutionActor & {
  executionId: string;
  projectId: string | null;
  ownerId: string;
  /** Database-issued lease expiry used by the local watchdog. */
  expiresAt: string;
};
export type TurnOwner = { executionId: string; ownerId: string | null };

export class SessionExecutionError extends Error {
  constructor(readonly code: "session_unavailable" | "session_busy" | "execution_stopped" | "running_turn_limit", readonly statusCode: number) {
    super(code === "session_busy" ? "A turn is already running in this session."
      : code === "execution_stopped" ? "This turn stopped because its execution permission is no longer valid."
        : code === "running_turn_limit" ? "Too many turns are running."
        : "This session is unavailable for execution.");
  }
}

// Shared by admission and every dispatch check. Reference sessions hold files
// and cannot run an agent. Upload authorization has the same active editor rule.
export function sessionExecutionAccessSql(session: string, user: string): string {
  return `(${session}.purpose <> 'project_reference' AND ${sessionUploadAccessSql(session, user)})`;
}

// Interactive contexts name the exact admitted execution. Scheduled contexts
// have their own lifecycle and do not use this fence.
export function interactiveContextExecutionSql(context: string): string {
  return `EXISTS (SELECT 1 FROM sessions execution_session
    WHERE execution_session.tenant_id=${context}.tenant_id AND execution_session.session_id=${context}.session_id
      AND ((execution_session.project_id IS NULL AND
        ${context}.metadata->>'turnContext' IS DISTINCT FROM 'interactive') OR EXISTS (
        SELECT 1 FROM session_executions execution
        WHERE execution.tenant_id=${context}.tenant_id AND execution.session_id=${context}.session_id
          AND execution.user_id=${context}.user_id AND execution.runtime_id=${context}.runtime_id
          AND execution.execution_id=${context}.metadata->>'executionId'
          AND execution.status='active' AND execution.expires_at>clock_timestamp()
          AND ${sessionExecutionAccessSql("execution_session", `${context}.user_id`)}
      )))`;
}

export class SessionExecutionStore {
  constructor(private readonly pool: Pool, readonly ownerId = uuidv7()) {}

  /**
   * The sandbox saved for the session, with the hash of the network policy
   * that it was created under. The record of the policy names its sandbox, so
   * it counts only while `sandbox_id` is still that sandbox. An older replica
   * that replaces the sandbox without writing the record leaves one that no
   * longer matches, and the hash then reads as unknown. The hash is for audits.
   * It is never proof of the live network: the runtime reads that from the
   * provider at the start of every turn.
   */
  async sandboxBinding(execution: SessionExecution): Promise<{ sandboxId: string; networkPolicyHash: string | null } | null> {
    return withTenantScope(this.pool, execution.tenantId, async db => {
      const result = await db.query(`SELECT s.sandbox_id, s.sandbox_network_policy FROM sessions s
        JOIN session_executions e ON e.tenant_id=s.tenant_id AND e.session_id=s.session_id
        WHERE s.tenant_id=$1 AND s.session_id=$2 AND e.execution_id=$3
          AND e.owner_id=$4 AND e.user_id=$5 AND e.status='active'
          AND e.expires_at>clock_timestamp() AND s.project_id IS NULL
          AND s.status='active' AND ${sessionExecutionAccessSql("s", "e.user_id")}`,
      [execution.tenantId, execution.sessionId, execution.executionId, execution.ownerId, execution.userId]);
      const row = result.rows[0];
      if (!row) throw new SessionExecutionError("execution_stopped", 403);
      if (!row.sandbox_id) return null;
      const policy = row.sandbox_network_policy as { sandboxId?: unknown; hash?: unknown } | null;
      const networkPolicyHash = policy && policy.sandboxId === row.sandbox_id && typeof policy.hash === "string"
        ? policy.hash : null;
      return { sandboxId: row.sandbox_id, networkPolicyHash };
    });
  }

  async bindSandboxId(
    execution: SessionExecution, previousId: string | null, sandboxId: string, networkPolicyHash: string
  ): Promise<void> {
    await withTenantScope(this.pool, execution.tenantId, async db => {
      const result = await db.query(`UPDATE sessions s SET sandbox_id=$6, sandbox_network_policy=$8::jsonb
        FROM session_executions e WHERE e.tenant_id=s.tenant_id AND e.session_id=s.session_id
          AND s.tenant_id=$1 AND s.session_id=$2 AND e.execution_id=$3
          AND e.owner_id=$4 AND e.user_id=$5 AND e.status='active'
          AND e.expires_at>clock_timestamp() AND s.project_id IS NULL
          AND s.status='active' AND s.sandbox_id IS NOT DISTINCT FROM $7
          AND ${sessionExecutionAccessSql("s", "e.user_id")}
        RETURNING s.session_id`,
      [execution.tenantId, execution.sessionId, execution.executionId, execution.ownerId,
        execution.userId, sandboxId, previousId, JSON.stringify({ sandboxId, hash: networkPolicyHash })]);
      if (!result.rows[0]) throw new SessionExecutionError("execution_stopped", 403);
    });
  }

  /** Run only with the privileged pool. Expired leases cannot belong to a live turn. */
  async sweepExpired(limit = 500): Promise<number> {
    const result = await this.pool.query(`WITH expired AS (
      UPDATE session_executions SET status='stopped', stop_reason='lease_expired', updated_at=NOW()
      WHERE (tenant_id, session_id) IN (
        SELECT tenant_id, session_id FROM session_executions
        WHERE status='active' AND expires_at<=clock_timestamp()
        LIMIT $1 FOR UPDATE SKIP LOCKED
      ) AND status='active' AND expires_at<=clock_timestamp()
      RETURNING tenant_id, session_id, expires_at
    ), interrupted AS (
      UPDATE messages m SET status='interrupted', updated_at=NOW()
      FROM expired e WHERE m.tenant_id=e.tenant_id AND m.session_id=e.session_id
        AND m.role='assistant' AND m.status IN ('pending','streaming')
        AND m.created_at<=e.expires_at
      RETURNING m.tenant_id, m.message_id
    ), stopped_tools AS (
      UPDATE message_tool_results t SET status='failed', updated_at=NOW()
      FROM interrupted i WHERE t.tenant_id=i.tenant_id AND t.message_id=i.message_id
        AND t.status='in_progress'
    ) SELECT count(*)::integer AS count FROM expired`, [limit]);
    return result.rows[0]?.count ?? 0;
  }

  async acquire(actor: ExecutionActor, leaseMs: number, caps?: { perUser: number; perTenant: number }): Promise<SessionExecution> {
    return withTenantScope(this.pool, actor.tenantId, async (db) => {
      // Serialize admissions for this tenant so the two caps are global.
      if (caps) await db.query("SELECT pg_advisory_xact_lock(hashtextextended('turn_admission:' || $1, 0))", [actor.tenantId]);
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
      if (caps) {
        const counts = await db.query(`SELECT count(*)::integer AS tenant_count,
          count(*) FILTER (WHERE user_id=$2)::integer AS user_count
          FROM session_executions WHERE tenant_id=$1 AND status='active' AND expires_at>clock_timestamp()`,
        [actor.tenantId, actor.userId]);
        if (counts.rows[0].tenant_count >= caps.perTenant || counts.rows[0].user_count >= caps.perUser)
          throw new SessionExecutionError("running_turn_limit", 429);
      }
      // Finish the old generation before its only execution row is replaced.
      // The status update also fires approval expiry.
      await db.query(`WITH expired AS (
        UPDATE session_executions SET status='stopped', stop_reason='lease_expired', updated_at=NOW()
        WHERE tenant_id=$1 AND session_id=$2 AND status='active' AND expires_at<=clock_timestamp()
        RETURNING expires_at
      ), interrupted AS (
        UPDATE messages m SET status='interrupted', updated_at=NOW()
        FROM expired e WHERE m.tenant_id=$1 AND m.session_id=$2
          AND m.role='assistant' AND m.status IN ('pending','streaming')
          AND m.created_at<=e.expires_at
        RETURNING m.tenant_id, m.message_id
      ), stopped_tools AS (
        UPDATE message_tool_results t SET status='failed', updated_at=NOW()
        FROM interrupted i WHERE t.tenant_id=i.tenant_id AND t.message_id=i.message_id
          AND t.status='in_progress'
        RETURNING t.tool_result_id
      ) SELECT (SELECT count(*) FROM expired), (SELECT count(*) FROM stopped_tools)`,
      [actor.tenantId, actor.sessionId]);
      const executionId = uuidv7();
      const inserted = await db.query(`INSERT INTO session_executions
        (tenant_id,session_id,execution_id,user_id,project_id,status,expires_at,owner_id,heartbeat_at)
        VALUES ($1,$2,$3,$4,$5,'active',clock_timestamp()+$6*INTERVAL '1 millisecond',$7,clock_timestamp())
        ON CONFLICT (tenant_id,session_id) DO UPDATE SET execution_id=EXCLUDED.execution_id,
          user_id=EXCLUDED.user_id, project_id=EXCLUDED.project_id, runtime_id=NULL, status='active',
          stop_reason=NULL, expires_at=EXCLUDED.expires_at, owner_id=EXCLUDED.owner_id,
          heartbeat_at=EXCLUDED.heartbeat_at, started_at=NOW(), updated_at=NOW()
        RETURNING expires_at`,
      [actor.tenantId, actor.sessionId, executionId, actor.userId, projectId, leaseMs, this.ownerId]);
      return { ...actor, executionId, projectId, ownerId: this.ownerId, expiresAt: new Date(inserted.rows[0].expires_at).toISOString() };
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
        SET expires_at=clock_timestamp()+$5*INTERVAL '1 millisecond', heartbeat_at=clock_timestamp(), updated_at=NOW()
        FROM sessions s WHERE s.tenant_id=e.tenant_id AND s.session_id=e.session_id
          AND e.tenant_id=$1 AND e.session_id=$2 AND e.user_id=$3 AND e.execution_id=$4
          AND e.status='active' AND e.owner_id=$6 AND e.expires_at>clock_timestamp()
          AND s.project_id IS NOT DISTINCT FROM e.project_id
          AND ${sessionExecutionAccessSql("s", "e.user_id")}
          AND EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id=e.tenant_id AND tm.user_id=e.user_id)
        RETURNING e.execution_id`,
      [execution.tenantId, execution.sessionId, execution.userId, execution.executionId, leaseMs, execution.ownerId]);
      return Boolean(result.rows[0]);
    });
  }

  async release(execution: SessionExecution): Promise<void> {
    await withTenantScope(this.pool, execution.tenantId, (db) => db.query(
      `UPDATE session_executions SET status='finished', updated_at=NOW()
        WHERE tenant_id=$1 AND execution_id=$2 AND user_id=$3 AND owner_id=$4 AND status='active'`,
      [execution.tenantId, execution.executionId, execution.userId, execution.ownerId]));
  }

  async stop(actor: ExecutionActor): Promise<boolean> {
    return Boolean(await this.stopAndGetOwner(actor));
  }

  async currentOwner(tenantId: string, sessionId: string): Promise<TurnOwner | null> {
    return withTenantScope(this.pool, tenantId, async db => {
      const result = await db.query(`SELECT execution_id, owner_id FROM session_executions
        WHERE tenant_id=$1 AND session_id=$2 AND status='active' AND expires_at>clock_timestamp()`,
      [tenantId, sessionId]);
      const row = result.rows[0];
      return row ? { executionId: row.execution_id, ownerId: row.owner_id } : null;
    });
  }

  async isStopped(turn: { tenantId: string; sessionId: string; executionId: string; ownerId: string }): Promise<boolean> {
    return withTenantScope(this.pool, turn.tenantId, async db => {
      const result = await db.query(`SELECT 1 FROM session_executions
        WHERE tenant_id=$1 AND session_id=$2 AND execution_id=$3 AND owner_id=$4 AND status='stopped'`,
      [turn.tenantId, turn.sessionId, turn.executionId, turn.ownerId]);
      return Boolean(result.rows[0]);
    });
  }

  async stopAndGetOwner(actor: ExecutionActor): Promise<TurnOwner | null> {
    return withTenantScope(this.pool, actor.tenantId, async (db) => {
      const result = await db.query(`UPDATE session_executions e
        SET status='stopped', stop_reason='cancelled', updated_at=NOW()
        FROM sessions s WHERE s.tenant_id=e.tenant_id AND s.session_id=e.session_id
          AND e.tenant_id=$1 AND e.session_id=$2 AND e.status='active'
          AND e.expires_at>clock_timestamp()
          AND ${sessionExecutionAccessSql("s", "$3")}
        RETURNING e.execution_id, e.owner_id, e.user_id, e.runtime_id`, [actor.tenantId, actor.sessionId, actor.userId]);
      const stopped = result.rows[0];
      if (!stopped) return null;
      await AuditEventStore.createInTransaction(db, {
        ...actor, type: "turn.interrupted",
        payload: { executionId: stopped.execution_id, initiatorUserId: stopped.user_id, runtimeId: stopped.runtime_id }
      });
      return { executionId: stopped.execution_id, ownerId: stopped.owner_id };
    });
  }
}
