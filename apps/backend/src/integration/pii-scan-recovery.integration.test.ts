import { describe, expect, test, vi } from "vitest";

import { PiiScanJobHandler, type PiiScanJobHandlerDeps } from "../services/pii/pii-scan-job-handler.js";
import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { PiiScanJobStore } from "../services/pii/pii-scan-job-store.js";
import { PiiScanRunStore, type PiiScanRunDecision } from "../services/pii/pii-scan-run-store.js";
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

describe.skipIf(!adminDatabaseUrl())("PII scan decision record", () => {
  const block: PiiScanRunDecision = {
    action: "block", mode: "block", policyRevision: 2,
    findings: [{ entityType: "email", value: "", start: 0, end: 7, confidence: "high" }],
    providerType: "rules", providerModel: null, blockReason: "email"
  };
  const allowOff: PiiScanRunDecision = {
    action: "allow", mode: "off", policyRevision: 3, findings: [], providerType: null, providerModel: null
  };

  test("an open scan run keeps the first decision, in its own tenant only", async () => {
    const { tenantId, userId, sessionId } = await seedTenantGraph();
    const other = await seedTenantGraph();
    const runs = new PiiScanRunStore(appPool());
    const run = await runs.create({
      tenantId, subjectType: "message", subjectId: "subject", sourceUserId: userId,
      sourceSessionId: sessionId, mode: "detect", status: "processing"
    });

    expect(await runs.recordDecision(other.tenantId, run.scanRunId, allowOff)).toBe(false);
    expect(await runs.recordDecision(tenantId, run.scanRunId, block)).toBe(true);
    expect(await runs.recordDecision(tenantId, run.scanRunId, allowOff)).toBe(false);
    expect(await runs.getPendingDecision(tenantId, run.scanRunId)).toEqual(block);
    expect(await runs.getPendingDecision(other.tenantId, run.scanRunId)).toBeNull();

    await runs.update(tenantId, run.scanRunId, { status: "blocked", actionTaken: "block", pendingDecision: null, completedAt: new Date() });
    const stored = await superuserPool().query("SELECT pending_decision FROM pii_scan_runs WHERE scan_run_id = $1", [run.scanRunId]);
    expect(stored.rows[0].pending_decision).toBeNull();
    // A late attempt cannot reopen a closed run.
    expect(await runs.update(tenantId, run.scanRunId, { status: "processing" })).toBeNull();
    expect(await runs.getById(tenantId, run.scanRunId)).toMatchObject({ status: "blocked", actionTaken: "block" });
    // A closed run takes no new decision.
    expect(await runs.recordDecision(tenantId, run.scanRunId, allowOff)).toBe(false);
  });

  test("a closed scan run returns no decision to finish", async () => {
    const { tenantId, userId, sessionId } = await seedTenantGraph();
    const runs = new PiiScanRunStore(appPool());
    const run = await runs.create({
      tenantId, subjectType: "message", subjectId: "subject", sourceUserId: userId,
      sourceSessionId: sessionId, mode: "detect", status: "pending"
    });
    expect(await runs.recordDecision(tenantId, run.scanRunId, block)).toBe(true);
    // Closed without the update that clears the decision.
    await runs.update(tenantId, run.scanRunId, { status: "failed", completedAt: new Date() });
    expect(await runs.getPendingDecision(tenantId, run.scanRunId)).toBeNull();
  });

  test("the audit lookup matches the tenant, the type, the scan run and the start time", async () => {
    const { tenantId, userId, sessionId } = await seedTenantGraph();
    const other = await seedTenantGraph();
    const audit = new AuditEventStore(appPool());
    await audit.create({ tenantId, sessionId, userId, type: "pii_blocked", payload: { scanRunId: "run-a" } });
    const before = new Date(Date.now() - 60_000);

    expect(await audit.hasPiiScanRunEvent(tenantId, "pii_blocked", "run-a", before)).toBe(true);
    expect(await audit.hasPiiScanRunEvent(tenantId, "pii_reported", "run-a", before)).toBe(false);
    expect(await audit.hasPiiScanRunEvent(tenantId, "pii_blocked", "run-b", before)).toBe(false);
    expect(await audit.hasPiiScanRunEvent(tenantId, "pii_blocked", "run-a", new Date(Date.now() + 60_000))).toBe(false);
    expect(await audit.hasPiiScanRunEvent(other.tenantId, "pii_blocked", "run-a", before)).toBe(false);
  });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!adminDatabaseUrl())("PII recovery races", () => {
  async function setup() {
    const { tenantId, artifactId } = await seedTenantGraph();
    const runs = new PiiScanRunStore(appPool());
    const jobs = new PiiScanJobStore(appPool(), maintenancePool());
    const artifacts = new ArtifactStore(appPool());
    const run = await runs.create({ tenantId, subjectType: "artifact", subjectId: artifactId, mode: "detect" });
    const job = await jobs.create({ tenantId, scanRunId: run.scanRunId, subjectType: "artifact", subjectId: artifactId, mode: "detect" });
    await superuserPool().query("UPDATE pii_scan_jobs SET status = 'failed' WHERE job_id = $1", [job.jobId]);
    const block: PiiScanRunDecision = {
      action: "block", mode: "block", policyRevision: 2, findings: [],
      providerType: "rules", providerModel: null, blockReason: "email"
    };
    const deps: PiiScanJobHandlerDeps = {
      piiScanRuns: runs, piiScanJobs: jobs, artifacts,
      messages: { setPiiDetail: vi.fn() },
      storage: { delete: vi.fn() },
      piiProtection: { evaluateTextWithPolicy: vi.fn(), evaluateArtifactWithPolicy: vi.fn() },
      subjectReader: { readMessageText: vi.fn(), readArtifact: vi.fn() },
      logger: { error: vi.fn(), warn: vi.fn() }
    };
    const assertBlocked = async () => {
      expect(await runs.getById(tenantId, run.scanRunId)).toMatchObject({
        status: "blocked", mode: "block", policyRevision: 2, actionTaken: "block"
      });
      const result = await superuserPool().query(
        "SELECT detail_json->'pii' AS pii FROM artifacts WHERE tenant_id = $1 AND artifact_id = $2",
        [tenantId, artifactId]
      );
      expect(result.rows[0].pii).toMatchObject({ status: "blocked", modeApplied: "block", policyRevision: 2 });
    };
    return { tenantId, run, job, runs, jobs, deps, block, assertBlocked };
  }

  test("two recoveries holding the same selected failed job preserve a completed block", async () => {
    const h = await setup();
    await h.runs.recordDecision(h.tenantId, h.run.scanRunId, h.block);
    const [selectedA, selectedB] = await Promise.all([
      h.jobs.listUnfinishedFailures(1000), h.jobs.listUnfinishedFailures(1000)
    ]);
    const a = selectedA.find((job) => job.jobId === h.job.jobId)!;
    const b = selectedB.find((job) => job.jobId === h.job.jobId)!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const deleting = gate();
    const releaseDelete = gate();
    h.deps.storage.delete = async () => { deleting.resolve(); await releaseDelete.promise; };
    const handler = new PiiScanJobHandler(h.deps);
    const first = handler.finishFailedJob(a);
    await deleting.promise;
    // B enters recovery with the same selection, but reaches its locked
    // status check after A commits the block.
    const recover = h.runs.finishUndecidedFailure.bind(h.runs);
    const secondEntered = gate();
    vi.spyOn(h.runs, "finishUndecidedFailure").mockImplementationOnce(async (...args) => {
      secondEntered.resolve();
      await first;
      return recover(...args);
    });
    const second = handler.finishFailedJob(b);
    await secondEntered.promise;
    releaseDelete.resolve();
    await Promise.all([first, second]);
    await h.assertBlocked();
  });

  test("a late failing attempt after another completes preserves the closed outcome", async () => {
    const h = await setup();
    const reading = gate();
    const failRead = gate();
    h.deps.subjectReader.readArtifact = async () => {
      reading.resolve();
      await failRead.promise;
      throw new Error("artifact not found for scan job");
    };
    const handler = new PiiScanJobHandler(h.deps);
    const late = handler.execute(h.job);
    await reading.promise;
    await h.runs.recordDecision(h.tenantId, h.run.scanRunId, h.block);
    await handler.finishFailedJob(h.job);
    failRead.resolve();
    await late;
    await h.assertBlocked();
  });

  test("undecided recovery excludes a concurrent decision before writing the subject", async () => {
    const h = await setup();
    const writing = gate();
    const releaseWrite = gate();
    const recovery = h.runs.finishUndecidedFailure(h.tenantId, h.run.scanRunId, "expired", async () => {
      writing.resolve();
      await releaseWrite.promise;
    });
    await writing.promise;
    const decision = h.runs.recordDecision(h.tenantId, h.run.scanRunId, h.block);
    try {
      // Verify contention in Postgres rather than relying on a timer.
      await vi.waitFor(async () => {
        const waiting = await superuserPool().query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SET pending_decision%'"
        );
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
    } finally {
      releaseWrite.resolve();
    }
    await recovery;
    expect(await decision).toBe(false);
    expect(await h.runs.getPendingDecision(h.tenantId, h.run.scanRunId)).toBeNull();
    expect(await h.runs.getById(h.tenantId, h.run.scanRunId)).toMatchObject({ status: "failed" });
  });
});
