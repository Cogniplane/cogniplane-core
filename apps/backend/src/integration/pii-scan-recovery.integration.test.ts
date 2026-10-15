import { describe, expect, test } from "vitest";

import { PiiScanJobStore } from "../services/pii/pii-scan-job-store.js";
import { PiiScanRunStore } from "../services/pii/pii-scan-run-store.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("PII scan acknowledgement recovery", () => {
  test("completes an expired claim whose decision already landed without requeueing it", async () => {
    const { tenantId, userId, sessionId } = await seedTenantGraph();
    const runs = new PiiScanRunStore(appPool());
    const jobs = new PiiScanJobStore(appPool(), maintenancePool());
    const run = await runs.create({
      tenantId, subjectType: "message", subjectId: "subject", sourceUserId: userId,
      sourceSessionId: sessionId, mode: "block", status: "blocked", actionTaken: "block"
    });
    const job = await jobs.create({
      tenantId, scanRunId: run.scanRunId, subjectType: "message", subjectId: "subject", mode: "block"
    });
    await superuserPool().query(
      "UPDATE pii_scan_jobs SET status = 'claimed', attempts = max_attempts, claimed_at = NOW() - INTERVAL '1 hour' WHERE job_id = $1",
      [job.jobId]
    );
    await jobs.sweepStaleClaims(60_000);
    expect(await jobs.getById(tenantId, job.jobId)).toMatchObject({ status: "completed", errorMessage: null });
    const result = await superuserPool().query("SELECT status FROM pii_scan_runs WHERE scan_run_id = $1", [run.scanRunId]);
    expect(result.rows[0].status).toBe("blocked");
  });

  test("lists a job failed by the stale-claim sweep until its scan run is closed", async () => {
    const { tenantId, userId, sessionId } = await seedTenantGraph();
    const runs = new PiiScanRunStore(appPool());
    const jobs = new PiiScanJobStore(appPool(), maintenancePool());
    const run = await runs.create({
      tenantId, subjectType: "message", subjectId: "subject", sourceUserId: userId,
      sourceSessionId: sessionId, mode: "detect", status: "processing"
    });
    const job = await jobs.create({
      tenantId, scanRunId: run.scanRunId, subjectType: "message", subjectId: "subject", mode: "detect"
    });
    await superuserPool().query(
      "UPDATE pii_scan_jobs SET status = 'claimed', attempts = max_attempts, claimed_at = NOW() - INTERVAL '1 hour' WHERE job_id = $1",
      [job.jobId]
    );
    await jobs.sweepStaleClaims(60_000);
    expect(await jobs.getById(tenantId, job.jobId)).toMatchObject({ status: "failed" });

    const listed = (await jobs.listUnfinishedFailures(1000)).map((entry) => entry.jobId);
    expect(listed).toContain(job.jobId);

    await runs.update(tenantId, run.scanRunId, { status: "failed", completedAt: new Date() });
    const after = (await jobs.listUnfinishedFailures(1000)).map((entry) => entry.jobId);
    expect(after).not.toContain(job.jobId);
  });

  test("lists a failed job whose scan run closed while its upload stayed pending", async () => {
    const { tenantId, userId, sessionId, artifactId } = await seedTenantGraph();
    const runs = new PiiScanRunStore(appPool());
    const jobs = new PiiScanJobStore(appPool(), maintenancePool());
    await superuserPool().query(
      "UPDATE artifacts SET status = 'pending' WHERE tenant_id = $1 AND artifact_id = $2",
      [tenantId, artifactId]
    );
    const run = await runs.create({
      tenantId, subjectType: "artifact", subjectId: artifactId, sourceUserId: userId,
      sourceSessionId: sessionId, mode: "detect", status: "failed"
    });
    const job = await jobs.create({
      tenantId, scanRunId: run.scanRunId, subjectType: "artifact", subjectId: artifactId, mode: "detect"
    });
    await superuserPool().query("UPDATE pii_scan_jobs SET status = 'failed' WHERE job_id = $1", [job.jobId]);
    expect((await jobs.listUnfinishedFailures(1000)).map((entry) => entry.jobId)).toContain(job.jobId);

    // A newer queued job owns the subject, so recovery leaves it alone.
    const newerRun = await runs.create({
      tenantId, subjectType: "artifact", subjectId: artifactId, sourceUserId: userId,
      sourceSessionId: sessionId, mode: "detect", status: "pending"
    });
    await jobs.create({
      tenantId, scanRunId: newerRun.scanRunId, subjectType: "artifact", subjectId: artifactId, mode: "detect"
    });
    expect((await jobs.listUnfinishedFailures(1000)).map((entry) => entry.jobId)).not.toContain(job.jobId);
  });
});
