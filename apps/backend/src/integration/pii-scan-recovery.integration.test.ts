import { describe, expect, test } from "vitest";

import { PiiScanJobStore } from "../services/pii/pii-scan-job-store.js";
import { PiiScanRunStore } from "../services/pii/pii-scan-run-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

describe.skipIf(!adminDatabaseUrl())("PII scan acknowledgement recovery", () => {
  test("completes an expired claim whose decision already landed without requeueing it", async () => {
    const { tenantId, userId, sessionId } = await seedTenantGraph();
    const runs = new PiiScanRunStore(appPool());
    const jobs = new PiiScanJobStore(appPool(), superuserPool());
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
});
