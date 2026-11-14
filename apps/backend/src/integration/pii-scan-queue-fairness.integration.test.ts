// The PII scan queue on PostgreSQL: tenants take turns in the claim, two
// workers that claim at the same time never get the same job, a started
// worker fills free slots without waiting for its tick, and a retry after a
// storage failure (`transient`) does not use the scan budget while the
// claimed attempt stays the fence of each write.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PII_SCAN_TRANSIENT_RETRY_LIMIT, PiiScanJobStore, type PiiScanJobRecord } from "../services/pii/pii-scan-job-store.js";
import { SchedulerWorker, type SchedulerWorkerDeps } from "../services/scheduler-worker.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedMembership, seedPiiScanRun, seedSession, seedTenant, seedUser } from "./support/fixtures.js";

type Owner = { tenantId: string; userId: string; sessionId: string };

async function seedOwner(): Promise<Owner> {
  const tenantId = await seedTenant();
  const userId = await seedUser();
  await seedMembership(tenantId, userId);
  return { tenantId, userId, sessionId: await seedSession(tenantId, userId) };
}

/** Queues `count` due jobs; the first is the oldest (`ageSeconds` ago, then one second newer each). */
async function queueJobs(owner: Owner, count: number, ageSeconds: number): Promise<string[]> {
  const scanRunId = await seedPiiScanRun(owner);
  const ids = Array.from({ length: count }, () => `piijob_${randomUUID()}`);
  await superuserPool().query(
    `INSERT INTO pii_scan_jobs
       (tenant_id, job_id, scan_run_id, subject_type, subject_id, source_session_id, source_user_id, mode, status, run_after)
     SELECT $1, job_id, $2, 'message', 'subject_' || job_id, $3, $4, 'detect', 'queued',
            NOW() - (($5::int - ord + 1) * INTERVAL '1 second')
     FROM unnest($6::text[]) WITH ORDINALITY AS jobs(job_id, ord)`,
    [owner.tenantId, scanRunId, owner.sessionId, owner.userId, ageSeconds, ids]
  );
  return ids;
}

async function jobRow(jobId: string) {
  const result = await superuserPool().query(
    `SELECT status, attempts, transient_retries, max_attempts, error_message,
            run_after > NOW() AS deferred, EXTRACT(EPOCH FROM (run_after - NOW())) AS delay_seconds
     FROM pii_scan_jobs WHERE job_id = $1`,
    [jobId]
  );
  return result.rows[0];
}

const claimStore = () => new PiiScanJobStore(appPool(), maintenancePool());

describe.skipIf(!adminDatabaseUrl())("PII scan queue", () => {
  beforeEach(async () => {
    // Earlier files can leave due jobs; the claim reads all tenants.
    await superuserPool().query(
      "UPDATE pii_scan_jobs SET run_after = NOW() + INTERVAL '1 day' WHERE status = 'queued'"
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a tenant with one new job is claimed in the first batch behind a backlog of 50 older jobs", async () => {
    const tenantA = await seedOwner();
    const tenantB = await seedOwner();
    const backlog = await queueJobs(tenantA, 50, 600);
    const [late] = await queueJobs(tenantB, 1, 1);

    const first = await claimStore().claimDueJobs(2);
    expect(first.map((job) => job.jobId).sort()).toEqual([backlog[0], late].sort());

    // A worker that claims one job at a time: A has a job running now, so a
    // newer job of a third tenant still goes first.
    const tenantC = await seedOwner();
    const [newest] = await queueJobs(tenantC, 1, 1);
    expect((await claimStore().claimDueJobs(1)).map((job) => job.jobId)).toEqual([newest]);
    // With no other tenant waiting, A's backlog continues oldest first.
    // (RETURNING has no order, so compare sorted.)
    expect((await claimStore().claimDueJobs(2)).map((job) => job.jobId).sort()).toEqual([backlog[1], backlog[2]].sort());
  });

  test("two workers that claim at the same time get different jobs and no more than they asked for", async () => {
    const owners = await Promise.all([seedOwner(), seedOwner(), seedOwner()]);
    const queued = (await Promise.all(owners.map((owner) => queueJobs(owner, 8, 60)))).flat();

    const [left, right] = await Promise.all([claimStore().claimDueJobs(10), new PiiScanJobStore(appPool(), superuserPool()).claimDueJobs(10)]);

    expect(left.length).toBeLessThanOrEqual(10);
    expect(right.length).toBeLessThanOrEqual(10);
    const ids = [...left, ...right].map((job) => job.jobId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((jobId) => queued.includes(jobId))).toBe(true);
    // Rows that one claim skipped stay queued for a later claim.
    const claimed = await superuserPool().query(
      "SELECT count(*)::int AS count FROM pii_scan_jobs WHERE job_id = ANY($1::text[]) AND status = 'claimed' AND attempts = 1",
      [queued]
    );
    expect(claimed.rows[0].count).toBe(ids.length);
  });

  test("a started worker fills a free slot within seconds, not at its next tick", async () => {
    const tenantA = await seedOwner();
    const tenantB = await seedOwner();
    const jobs = new PiiScanJobStore(appPool(), maintenancePool());
    await queueJobs(tenantA, 6, 600);
    const [late] = await queueJobs(tenantB, 1, 1);
    const started: Array<{ jobId: string; tenantId: string; at: number }> = [];
    const begin = Date.now();
    const deps = {
      piiScanJobs: jobs,
      piiScanJobHandler: {
        async finishFailedJob() {},
        async execute(job: PiiScanJobRecord) {
          started.push({ jobId: job.jobId, tenantId: job.tenantId, at: Date.now() - begin });
          await new Promise((resolve) => setTimeout(resolve, 300));
          await jobs.markCompleted(job);
        }
      },
      logger: { info() {}, warn() {}, error() {} }
    } as unknown as SchedulerWorkerDeps;
    const worker = new SchedulerWorker(deps, {
      schedulingEnabled: false, maxConcurrentJobs: 1, maxConcurrentPiiJobs: 2, jobTimeoutMs: 60_000
    });
    // The tick interval is longer than the test: only the PII interval claims.
    worker.start(10 * 60_000);
    try {
      await vi.waitFor(() => expect(started.length).toBeGreaterThanOrEqual(4), { timeout: 15_000, interval: 100 });
    } finally {
      worker.stop();
      await worker.drain(5_000);
    }
    expect(started[0]!.at).toBeLessThan(5_000);
    // B's one job is in the first or second claim of two.
    expect(started.slice(0, 4).map((entry) => entry.jobId)).toContain(late);
    // The slots refill while the queue has work, well before a 30-second tick.
    expect(started[3]!.at).toBeLessThan(12_000);
  });

  test("storage retries do not use the scan budget, and a stale attempt cannot finish a later claim", async () => {
    const owner = await seedOwner();
    const [jobId] = await queueJobs(owner, 1, 60);
    const jobs = claimStore();
    const claimNext = async () => {
      await superuserPool().query("UPDATE pii_scan_jobs SET run_after = NOW() WHERE job_id = $1 AND status = 'queued'", [jobId]);
      const [job] = (await jobs.claimDueJobs(5)).filter((claimed) => claimed.jobId === jobId);
      if (!job) throw new Error("the job was not claimed");
      return job;
    };

    const first = await claimNext();
    expect(first.attempts).toBe(1);
    const deferred = await jobs.recordFailure(first, "pii_storage_unavailable: slow bucket", { transient: true });
    expect(deferred).toMatchObject({ status: "queued", attempts: 1, transientRetries: 1 });
    expect(await jobRow(jobId!)).toMatchObject({ deferred: true });
    expect(Number((await jobRow(jobId!)).delay_seconds)).toBeGreaterThan(25);

    // Ten more storage failures: the job is still queued, with its budget.
    let latest = first;
    for (let round = 0; round < 10; round += 1) {
      latest = await claimNext();
      expect(await jobs.recordFailure(latest, "pii_storage_unavailable", { transient: true })).toMatchObject({ status: "queued" });
    }
    expect(await jobRow(jobId!)).toMatchObject({ status: "queued", attempts: 11, transient_retries: 11 });
    // The delay grows, and stops at ten minutes.
    expect(Number((await jobRow(jobId!)).delay_seconds)).toBeGreaterThan(590);
    expect(Number((await jobRow(jobId!)).delay_seconds)).toBeLessThanOrEqual(600);

    // The fence: the claim count only goes up. The attempt of an earlier
    // claim cannot complete or fail the job that a later claim holds.
    const current = await claimNext();
    expect(current.attempts).toBe(12);
    expect(await jobs.markCompleted(first)).toBe(false);
    expect(await jobs.markCompleted(latest)).toBe(false);
    expect(await jobs.recordFailure(latest, "late failure", { permanent: true })).toBeNull();
    expect(await jobs.recordFailure(latest, "late storage failure", { transient: true })).toBeNull();
    expect(await jobRow(jobId!)).toMatchObject({ status: "claimed", attempts: 12, transient_retries: 11 });

    // Errors that a retry does not fix still use the budget: three, then failed.
    expect(await jobs.recordFailure(current, "pii_job_failed: provider 500")).toMatchObject({ status: "queued" });
    expect(await jobs.recordFailure((await claimNext()), "pii_job_failed")).toMatchObject({ status: "queued" });
    const last = await claimNext();
    expect(await jobs.recordFailure(last, "pii_job_failed")).toMatchObject({ status: "failed" });
    expect(await jobRow(jobId!)).toMatchObject({ status: "failed", attempts: 14, transient_retries: 11 });
  });

  test("after the storage retry cap a storage failure uses the budget, so an outage cannot keep a job forever", async () => {
    const owner = await seedOwner();
    const [jobId] = await queueJobs(owner, 1, 60);
    const jobs = claimStore();
    await superuserPool().query(
      "UPDATE pii_scan_jobs SET attempts = $2, transient_retries = $2 WHERE job_id = $1",
      [jobId, PII_SCAN_TRANSIENT_RETRY_LIMIT]
    );
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await superuserPool().query("UPDATE pii_scan_jobs SET run_after = NOW() WHERE job_id = $1", [jobId]);
      const [job] = (await jobs.claimDueJobs(5)).filter((claimed) => claimed.jobId === jobId);
      const outcome = await jobs.recordFailure(job!, "pii_storage_unavailable", { transient: true });
      expect(outcome).toMatchObject({ status: attempt < 3 ? "queued" : "failed", transientRetries: PII_SCAN_TRANSIENT_RETRY_LIMIT });
    }
  });

  test("the stale-claim sweep counts only budget attempts, and the database refuses more retries than claims", async () => {
    const owner = await seedOwner();
    const [jobId] = await queueJobs(owner, 1, 60);
    // Five claims, four of them storage retries: one budget attempt used.
    await superuserPool().query(
      `UPDATE pii_scan_jobs SET status = 'claimed', attempts = 5, transient_retries = 4,
         claimed_at = NOW() - INTERVAL '1 hour' WHERE job_id = $1`,
      [jobId]
    );
    expect(await claimStore().sweepStaleClaims(60_000)).toBeGreaterThanOrEqual(1);
    expect(await jobRow(jobId!)).toMatchObject({ status: "queued", attempts: 5, transient_retries: 4 });

    await expect(superuserPool().query(
      "UPDATE pii_scan_jobs SET transient_retries = attempts + 1 WHERE job_id = $1", [jobId]
    )).rejects.toMatchObject({ constraint: "pii_scan_jobs_transient_retries_check" });
  });
});
