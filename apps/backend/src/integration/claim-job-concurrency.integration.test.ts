// `claimJob` is the scheduler's atomic gate: two workers polling the same tick
// must not both run one job.
//
// Every test here calls the PRODUCTION `UserSettingsStore.claimJob`. That is
// deliberate: an earlier version inlined a copy of its UPDATE and raced the
// copy, which would have stayed green if claimJob were rewritten as a
// non-atomic SELECT then UPDATE. A concurrency test that races its own SQL
// tests nothing.
//
// Two shapes, because neither alone is enough. `Promise.all` on two
// single-connection pools exercises the real race but cannot guarantee the
// calls overlapped. Holding a row lock open forces the blocking interleaving
// deterministically but is not what production does. Both run.

import { beforeAll, describe, expect, test } from "vitest";
import pg from "pg";

import { UserSettingsStore } from "../services/user-settings-store.js";

import { adminDatabaseUrl, runSuperuserUrl, superuserPool } from "./support/database.js";
import { seedScheduledJob, seedTenantGraph, type TenantFixture } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("claimJob concurrency", () => {
  let tenant: TenantFixture;

  beforeAll(async () => {
    tenant = await seedTenantGraph();
  });

  test("two overlapping claims through claimJob produce exactly one winner", async () => {
    // Calls the PRODUCTION method on two separate single-connection pools, so
    // the two claims really do run on different backends and both go through
    // `UserSettingsStore.claimJob`. An earlier version of this test inlined a
    // copy of claimJob's UPDATE and raced that instead, which would have stayed
    // green if claimJob were rewritten tomorrow as a non-atomic SELECT then
    // UPDATE. Racing the real method is the whole point.
    //
    // `max: 1` per pool is what forces distinct backends: a single shared pool
    // could hand both calls the same connection and serialize them inside one
    // session, which proves nothing about concurrency.
    const jobId = await seedScheduledJob({
      tenantId: tenant.tenantId,
      userId: tenant.userId
    });
    const nextRun = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const poolA = new pg.Pool({
      connectionString: runSuperuserUrl(),
      max: 1,
      // Bound the row-lock wait. Without it a stalled database turns a blocked
      // claim into a hang that outlives Vitest's own timeout and then blocks
      // pool teardown until the CI job timeout.
      statement_timeout: 10_000,
      application_name: "cogniplane-integration-claim-a"
    });
    const poolB = new pg.Pool({
      connectionString: runSuperuserUrl(),
      max: 1,
      statement_timeout: 10_000,
      application_name: "cogniplane-integration-claim-b"
    });

    try {
      const storeA = new UserSettingsStore(poolA, poolA);
      const storeB = new UserSettingsStore(poolB, poolB);

      const [first, second] = await Promise.all([
        storeA.claimJob(tenant.tenantId, jobId, nextRun),
        storeB.claimJob(tenant.tenantId, jobId, nextRun)
      ]);

      // Exactly one winner. Which one is nondeterministic, so the assertion is
      // on the count rather than on a particular side.
      const winners = [first, second].filter((claim) => claim !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.jobId).toBe(jobId);
    } finally {
      await Promise.all([poolA.end(), poolB.end()]);
    }
  });

  test("a blocked claim loses once the winner commits", async () => {
    // The deterministic companion to the race above. Holding the first
    // transaction open forces the second claim to block on the row lock, which
    // is the interleaving the Promise.all version cannot guarantee.
    //
    // Mechanism, for whoever reads this next: claimJob's WHERE includes
    // `next_run_at <= NOW()`. Under READ COMMITTED the second updater blocks on
    // the first's row lock, then re-evaluates its WHERE against the committed
    // row. The winner set next_run_at into the future, so the predicate is now
    // false and the loser matches nothing.
    const jobId = await seedScheduledJob({
      tenantId: tenant.tenantId,
      userId: tenant.userId
    });
    const nextRun = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const blocker = await superuserPool().connect();
    const loserPool = new pg.Pool({
      connectionString: runSuperuserUrl(),
      max: 1,
      // Two independent bounds on the blocked claim. `lock_timeout` caps the
      // row-lock wait specifically; `statement_timeout` caps the statement
      // overall. Without them a stalled database turns this into a hang that
      // outlives Vitest's own 30s timeout, and `pool.end()` then waits on the
      // still-live query until the 20-minute CI job timeout. Both are far above
      // the microseconds this actually needs.
      lock_timeout: 10_000,
      statement_timeout: 15_000,
      application_name: "cogniplane-integration-claim-loser"
    });

    let loser: ReturnType<UserSettingsStore["claimJob"]> | undefined;
    try {
      // Take the row lock by hand, without claiming: `FOR UPDATE` blocks the
      // other claim while leaving the row still due, so the loser's failure
      // must come from claimJob's own predicate re-check, not from us.
      await blocker.query("BEGIN");
      await blocker.query(`SELECT 1 FROM scheduled_jobs WHERE job_id = $1 FOR UPDATE`, [jobId]);

      const { rows: [{ pid: blockerPid }] } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const loserConnection = await loserPool.connect();
      const { rows: [{ pid: loserPid }] } = await loserConnection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      loserConnection.release();

      loser = new UserSettingsStore(loserPool, loserPool).claimJob(
        tenant.tenantId,
        jobId,
        nextRun
      );

      await expect.poll(async () => {
        const { rows: [{ blocked }] } = await superuserPool().query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [blockerPid, loserPid]
        );
        return blocked;
      }, { timeout: 5_000, interval: 10 }).toBe(true);

      // Claim it inside the lock-holding transaction, then release. The loser
      // unblocks, re-checks, and finds next_run_at in the future.
      await blocker.query(
        `UPDATE scheduled_jobs SET last_run_at = NOW(), next_run_at = $2 WHERE job_id = $1`,
        [jobId, nextRun]
      );
      await blocker.query("COMMIT");

      expect(await loser).toBeNull();
    } finally {
      // Roll back before release: a client returned mid-transaction would carry
      // it to the next borrower.
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await loser?.catch(() => {});
      await loserPool.end();
    }
  });

  test("a claimed job is not claimable again through the store", async () => {
    // The same invariant at the level callers actually use, so a refactor of
    // claimJob's SQL that broke the gate would fail here too.
    const store = new UserSettingsStore(superuserPool(), superuserPool());
    const jobId = await seedScheduledJob({
      tenantId: tenant.tenantId,
      userId: tenant.userId
    });
    const nextRun = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    expect((await store.claimJob(tenant.tenantId, jobId, nextRun))?.jobId).toBe(jobId);
    expect(await store.claimJob(tenant.tenantId, jobId, nextRun)).toBeNull();
  });

  test("a job whose owner lost tenant membership cannot be claimed", async () => {
    // claimJob re-checks membership rather than trusting listDueJobs, so a tick
    // that listed a job just before its owner was removed cannot still run it.
    const store = new UserSettingsStore(superuserPool(), superuserPool());
    const departing = await seedTenantGraph();
    const jobId = await seedScheduledJob({
      tenantId: departing.tenantId,
      userId: departing.userId
    });

    await superuserPool().query(
      `DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [departing.tenantId, departing.userId]
    );

    expect(await store.claimJob(departing.tenantId, jobId, null)).toBeNull();
  });
});
