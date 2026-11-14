// A full app pool must not stop the running turns of other tenants. Tenant A
// holds all 20 app connections with 40-second statements. Tenant B's turn
// renews its lease on the turn control pool (createTurnControlDatabase), so
// its lease is still active after 45 seconds, and its tool context checks
// still answer. The control pool is an app_user pool under RLS.

import { describe, expect, test } from "vitest";

import type { AppConfig } from "../config.js";
import { createDatabase, createTurnControlDatabase, type Pool, withTenantScope } from "../lib/db.js";
import { assertApplicationRole } from "../lib/maintenance-db.js";
import { ToolExecutionContextStore } from "../services/auth/tool-execution-context-store.js";
import { startExecutionHeartbeat } from "../services/execution-heartbeat.js";
import { SessionExecutionStore } from "../services/session-execution-store.js";
import { adminDatabaseUrl, runAppUserUrl, superuserPool } from "./support/database.js";
import { seedMembership, seedRuntimeSession, seedSession, seedTenant, seedUser } from "./support/fixtures.js";

const LEASE_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const HOLD_SECONDS = 40;

async function seedTurnOwner() {
  const tenantId = await seedTenant();
  const userId = await seedUser();
  await seedMembership(tenantId, userId);
  const sessionId = await seedSession(tenantId, userId);
  const runtimeId = await seedRuntimeSession(tenantId, userId, sessionId);
  return { tenantId, userId, sessionId, runtimeId };
}

/** Holds every connection of `pool` with a statement of tenant A; resolves when all hold one. */
async function exhaust(pool: Pool, tenantId: string, count: number): Promise<Promise<unknown>[]> {
  const holds = Array.from({ length: count }, () => withTenantScope(pool, tenantId, async (client) => {
    // Longer than the pool's 30-second statement limit, for this test only.
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query(`SELECT pg_sleep(${HOLD_SECONDS})`);
  }));
  const deadline = Date.now() + 15_000;
  for (;;) {
    const running = await superuserPool().query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE application_name = 'cogniplane-backend' AND query LIKE 'SELECT pg_sleep%' AND state = 'active'`
    );
    if (running.rows[0].count >= count) return holds;
    if (Date.now() > deadline) throw new Error(`only ${running.rows[0].count} of ${count} connections hold a statement`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!adminDatabaseUrl())("turn control pool", () => {
  test("tenant B's running turn keeps its lease for 45 seconds while tenant A holds all 20 app connections", async () => {
    const config = { DATABASE_URL: runAppUserUrl() } as AppConfig;
    // The production pools, with their production limits.
    const appDb = createDatabase(config);
    const controlDb = createTurnControlDatabase(config);
    try {
      // Same role rules as the app pool: RLS applies, no BYPASSRLS.
      await assertApplicationRole(controlDb);
      const role = await controlDb.query(
        "SELECT current_user AS name, r.rolbypassrls, current_setting('statement_timeout') AS statement_timeout, current_setting('application_name') AS app FROM pg_roles r WHERE r.rolname = current_user"
      );
      expect(role.rows[0]).toMatchObject({ rolbypassrls: false, statement_timeout: "5s", app: "cogniplane-turn-control" });

      const a = await seedTurnOwner();
      const b = await seedTurnOwner();
      // RLS on the control pool: without a tenant scope it sees no lease rows.
      const executions = new SessionExecutionStore(appDb, "owner-b", controlDb);
      const turn = await executions.acquire({ tenantId: b.tenantId, sessionId: b.sessionId, userId: b.userId }, LEASE_MS);
      await executions.bindRuntime(turn, b.runtimeId);
      const contexts = new ToolExecutionContextStore(controlDb);
      const context = await contexts.create({
        tenantId: b.tenantId, sessionId: b.sessionId, userId: b.userId, runtimeId: b.runtimeId,
        runtimePolicyId: "policy-1", messageId: null, credentialEnvelope: {},
        metadata: { executionId: turn.executionId, turnContext: "interactive" }, ownerSecurityVersion: null, ttlMs: 120_000
      });
      expect((await controlDb.query("SELECT count(*)::int AS count FROM session_executions")).rows[0].count).toBe(0);

      let renewals = 0;
      let lost = false;
      const errors: unknown[] = [];
      const startedAt = performance.now();
      const stop = startExecutionHeartbeat({
        leaseStartedAt: startedAt,
        leaseExpiresAt: startedAt + Math.max(0, new Date(turn.expiresAt).getTime() - Date.now()),
        leaseMs: LEASE_MS,
        intervalMs: HEARTBEAT_MS,
        renew: async () => {
          const current = await executions.heartbeat(turn, LEASE_MS);
          if (current) renewals += 1;
          return current;
        },
        onLost: async () => { lost = true; },
        onError: (error) => { errors.push(error); }
      });

      const holds = await exhaust(appDb, a.tenantId, 20);
      const heldAt = performance.now();
      try {
        // The app pool is full: a tenant query of B waits 10 seconds and fails,
        // and so would a lease renewal on the app pool.
        const appOnly = new SessionExecutionStore(appDb, "owner-b");
        await expect(appOnly.heartbeat(turn, LEASE_MS)).rejects.toThrow(/timeout/i);
        // The tool context check of B's turn still answers.
        expect(await contexts.liveness(b.tenantId, context.toolContextId)).toBe("live");

        // 38 seconds into A's 40-second statements: the pool is still full,
        // and B's lease (30 seconds) lives only through its renewals.
        await new Promise((resolve) => setTimeout(resolve, 38_000 - (performance.now() - heldAt)));
        const held = await superuserPool().query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'cogniplane-backend' AND query LIKE 'SELECT pg_sleep%' AND state = 'active'"
        );
        expect(held.rows[0].count).toBe(20);
        expect(await executions.isCurrent(turn, b.runtimeId)).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 45_000 - (performance.now() - startedAt)));
        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(45_000);
        expect(lost).toBe(false);
        expect(errors).toEqual([]);
        expect(renewals).toBeGreaterThanOrEqual(7);
        expect(await executions.isCurrent(turn, b.runtimeId)).toBe(true);
        const lease = await superuserPool().query(
          "SELECT status, expires_at > clock_timestamp() AS live FROM session_executions WHERE tenant_id = $1 AND session_id = $2",
          [b.tenantId, b.sessionId]
        );
        expect(lease.rows[0]).toEqual({ status: "active", live: true });
      } finally {
        stop();
        await Promise.allSettled(holds);
      }
      await executions.release(turn);
    } finally {
      await Promise.all([appDb.end(), controlDb.end()]);
    }
  }, 120_000);
});
