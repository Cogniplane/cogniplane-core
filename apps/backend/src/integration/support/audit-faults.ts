import { randomUUID } from "node:crypto";

import { superuserPool } from "./database.js";

/** A SQL text literal for a value that the test chose (an id it seeded). */
export function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Makes each audit insert that matches `when` (a SQL condition on `NEW`) fail
 * inside Postgres, as a failed insert in production would. The fault is a
 * trigger on `audit_events`; integration files run one at a time, and `when`
 * names rows that only the calling test writes. Returns the function that
 * removes the fault.
 */
export async function failAuditInserts(when: string): Promise<() => Promise<void>> {
  const name = `audit_fault_${randomUUID().replaceAll("-", "")}`;
  const db = superuserPool();
  await db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected audit insert failure'; END $$`);
  await db.query(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_events
    FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`);
  return async () => {
    await db.query(`DROP TRIGGER IF EXISTS ${name} ON audit_events`);
    await db.query(`DROP FUNCTION IF EXISTS ${name}()`);
  };
}

/** The audit rows of a tenant, oldest first. */
export async function auditRows(tenantId: string, filter: { type?: string; approvalId?: string } = {}) {
  const result = await superuserPool().query<{
    event_type: string; user_id: string | null; session_id: string | null; approval_id: string | null;
    payload: Record<string, unknown>;
  }>(
    `SELECT event_type, user_id, session_id, approval_id, payload FROM audit_events
     WHERE tenant_id = $1 AND ($2::text IS NULL OR event_type = $2) AND ($3::text IS NULL OR approval_id = $3)
     ORDER BY id`,
    [tenantId, filter.type ?? null, filter.approvalId ?? null]
  );
  return result.rows;
}
