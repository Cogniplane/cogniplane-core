// A queued PII scan applies the policy in force when the job runs, not the
// policy at enqueue time. These tests change the stored policy between the
// enqueue and the run. They check that the subject detail, the scan run, and
// the audit event record the mode and the settings revision that the run
// read, and that the job row keeps the mode at enqueue time. A synchronous
// scan records the revision of the one read that routed the upload. A retry
// after a partial block finishes the recorded decision and does not decide
// again under the newer policy.

import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "@cogniplane/shared-types";
import { describe, expect, test } from "vitest";

import { ArtifactStore } from "../services/artifacts/artifact-store.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { piiPolicyReader } from "../services/pii/build-pii-services.js";
import { PiiArtifactScanEnqueuer } from "../services/pii/pii-artifact-scan-enqueuer.js";
import { PiiProtectionService } from "../services/pii/pii-protection-service.js";
import { PiiScanJobHandler } from "../services/pii/pii-scan-job-handler.js";
import { PiiScanJobStore } from "../services/pii/pii-scan-job-store.js";
import { PiiScanRunStore } from "../services/pii/pii-scan-run-store.js";
import { RuleBasedPiiDetector } from "../services/pii/rule-based-pii-detector.js";
import { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";

import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";
import { PII_SAVE_ALLOWED } from "../test-helpers/data-routes.js";

const ENCRYPTION_SECRET = "pii-scan-applied-policy-integration-secret";

function policy(mode: PiiProtectionSettings["mode"]): PiiProtectionSettings {
  return { ...DEFAULT_PII_PROTECTION, enabled: true, mode, scopes: { ...DEFAULT_PII_PROTECTION.scopes, uploads: true } };
}

async function setup() {
  const fixture = await seedTenantGraph();
  const storageKey = `${fixture.tenantId}/${fixture.artifactId}`;
  // Admin saves use the RLS pool. The scan reads the policy with the
  // privileged pool, as in production.
  const settings = new TenantOrgSettingsStore(appPool(), ENCRYPTION_SECRET);
  const piiProtection = new PiiProtectionService({
    policyReader: piiPolicyReader(new TenantOrgSettingsStore(maintenancePool(), ENCRYPTION_SECRET)),
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000
  });
  const piiScanJobs = new PiiScanJobStore(appPool(), maintenancePool());
  const piiScanRuns = new PiiScanRunStore(appPool());
  const deleted: string[] = [];
  const deps = {
    piiProtection,
    piiScanRuns,
    piiScanJobs,
    artifacts: new ArtifactStore(appPool()),
    storage: { delete: async (key: string) => { deleted.push(key); } },
    subjectReader: {
      readMessageText: async () => null,
      readArtifact: async ({ artifactId }: { artifactId: string }) => ({
        artifactId,
        contentType: "text/plain",
        entityTypes: [],
        // As in storage, a deleted object cannot be read.
        readContent: async () => {
          if (deleted.includes(storageKey)) throw new Error("object not found");
          return "Contact jane.doe@example.com";
        }
      })
    },
    auditEvents: new AuditEventStore(appPool()),
    logger: { error() {}, warn() {} }
  };
  const enqueuer = new PiiArtifactScanEnqueuer(deps);
  // `failBlockedRunUpdate` stops the handler at the terminal update of a
  // block, after the bytes are deleted and the event is written.
  const faults = { failBlockedRunUpdate: false };
  const handler = new PiiScanJobHandler({
    ...deps,
    piiScanRuns: {
      update: async (tenantId, scanRunId, patch) => {
        if (faults.failBlockedRunUpdate && patch.status === "blocked") throw new Error("database unavailable");
        return piiScanRuns.update(tenantId, scanRunId, patch);
      },
      recordDecision: (...args) => piiScanRuns.recordDecision(...args),
      getPendingDecision: (...args) => piiScanRuns.getPendingDecision(...args),
      finishUndecidedFailure: (...args) => piiScanRuns.finishUndecidedFailure(...args)
    },
    messages: { setPiiDetail: async () => {} }
  });
  const enqueue = () => enqueuer.enqueue({
    tenantId: fixture.tenantId,
    artifactId: fixture.artifactId,
    sessionId: fixture.sessionId,
    userId: fixture.userId,
    contentType: "text/plain",
    storageKey,
    source: "upload"
  });
  const rows = async (scanRunId: string, jobId?: string) => {
    const db = superuserPool();
    const [artifact, run, job, audit] = await Promise.all([
      db.query("SELECT detail_json->'pii' AS pii FROM artifacts WHERE artifact_id = $1", [fixture.artifactId]),
      db.query(
        "SELECT mode, policy_revision, status, action_taken, pending_decision FROM pii_scan_runs WHERE scan_run_id = $1",
        [scanRunId]
      ),
      db.query("SELECT mode, status, error_message FROM pii_scan_jobs WHERE job_id = $1", [jobId ?? null]),
      db.query("SELECT event_type, payload FROM audit_events WHERE tenant_id = $1 AND event_type LIKE 'pii_%'", [fixture.tenantId])
    ]);
    return { pii: artifact.rows[0].pii, run: run.rows[0], job: job.rows[0], audit: audit.rows };
  };
  return { ...fixture, storageKey, settings, enqueue, handler, faults, piiScanJobs, rows, deleted };
}

// Queues a scan under detect, at settings revision 1.
async function setupQueued() {
  const h = await setup();
  expect((await h.settings.setPiiProtection(h.tenantId, policy("detect"), PII_SAVE_ALLOWED)).revision).toBe(1);
  const queued = await h.enqueue();
  if (queued.kind !== "queued") throw new Error(`expected a queued scan, got ${queued.kind}`);
  expect(queued.mode).toBe("detect");
  const runQueuedJob = async () => {
    const job = await h.piiScanJobs.getById(h.tenantId, queued.jobId);
    await h.handler.execute(job!);
  };
  return { ...h, queued, runQueuedJob, rows: () => h.rows(queued.scanRunId, queued.jobId) };
}

describe.skipIf(!adminDatabaseUrl())("PII scans record the policy that they applied", () => {
  test("a job queued under detect runs under the block policy saved before it ran, and records it", async () => {
    const h = await setupQueued();
    expect((await h.settings.setPiiProtection(h.tenantId, policy("block"), PII_SAVE_ALLOWED)).revision).toBe(2);

    await h.runQueuedJob();

    const { pii, run, job, audit } = await h.rows();
    // The stricter policy applies to the queued content at once.
    expect(h.deleted).toEqual([h.storageKey]);
    expect(pii).toMatchObject({ status: "blocked", modeApplied: "block", policyRevision: 2, scanRunId: h.queued.scanRunId });
    expect(run).toEqual({ mode: "block", policy_revision: 2, status: "blocked", action_taken: "block", pending_decision: null });
    expect(job).toMatchObject({ mode: "detect", status: "completed" });
    expect(audit).toEqual([{
      event_type: "pii_blocked",
      payload: expect.objectContaining({
        scanRunId: h.queued.scanRunId, mode: "block", policyRevision: 2, findingsCount: 1, objectDeleted: true
      })
    }]);
  });

  test("an invalid policy saved before the job ran records its revision and keeps the job and the file", async () => {
    const h = await setupQueued();
    // Enabled with mode off is not a valid policy.
    expect((await h.settings.setPiiProtection(h.tenantId, policy("off"), PII_SAVE_ALLOWED)).revision).toBe(2);

    await h.runQueuedJob();

    const { pii, run, job, audit } = await h.rows();
    expect(h.deleted).toEqual([]);
    expect(pii).toEqual({ status: "pending", modeApplied: "detect", scanRunId: h.queued.scanRunId });
    expect(run).toMatchObject({ mode: "detect", policy_revision: null, status: "processing" });
    expect(job).toMatchObject({ mode: "detect", status: "queued", error_message: expect.stringMatching(/^pii_policy_invalid: /) });
    expect(audit).toEqual([{
      event_type: "pii_policy_invalid",
      payload: {
        jobId: h.queued.jobId, scanRunId: h.queued.scanRunId, subjectType: "artifact", subjectId: h.artifactId,
        policyRevision: 2
      }
    }]);
  });

  test("a synchronous block records the revision of the read that routed the upload", async () => {
    const h = await setup();
    await h.settings.setPiiProtection(h.tenantId, policy("detect"), PII_SAVE_ALLOWED);
    expect((await h.settings.setPiiProtection(h.tenantId, policy("block"), PII_SAVE_ALLOWED)).revision).toBe(2);

    const result = await h.enqueue();
    if (result.kind !== "blocked") throw new Error(`expected a blocked upload, got ${result.kind}`);

    const { pii, run, audit } = await h.rows(result.scanRunId);
    expect(h.deleted).toEqual([h.storageKey]);
    expect(pii).toMatchObject({ status: "blocked", modeApplied: "block", policyRevision: 2, scanRunId: result.scanRunId });
    expect(run).toEqual({ mode: "block", policy_revision: 2, status: "blocked", action_taken: "block", pending_decision: null });
    expect(audit).toEqual([{
      event_type: "pii_blocked",
      payload: expect.objectContaining({ scanRunId: result.scanRunId, mode: "block", policyRevision: 2 })
    }]);
  });

  test("an invalid policy stops an upload and records the revision that it read", async () => {
    const h = await setup();
    // Enabled with mode off is not a valid policy.
    expect((await h.settings.setPiiProtection(h.tenantId, policy("off"), PII_SAVE_ALLOWED)).revision).toBe(1);

    expect(await h.enqueue()).toMatchObject({ kind: "failed", errorCode: "pii_policy_invalid" });

    const audit = await superuserPool().query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND event_type = 'pii_policy_invalid'", [h.tenantId]
    );
    expect(audit.rows).toEqual([{
      payload: { subjectType: "artifact", subjectId: h.artifactId, source: "upload", policyRevision: 1 }
    }]);
  });
  test.each([
    ["is now off", { ...DEFAULT_PII_PROTECTION, enabled: false }],
    ["still blocks", policy("block")]
  ])("a retry after a failed scan run update finishes the recorded block when protection %s", async (_, retryPolicy) => {
    const h = await setupQueued();
    expect((await h.settings.setPiiProtection(h.tenantId, policy("block"), PII_SAVE_ALLOWED)).revision).toBe(2);
    h.faults.failBlockedRunUpdate = true;

    await h.runQueuedJob();

    // The bytes are gone and the event exists. The scan run is still open
    // and keeps the decision, and the job waits for a retry.
    const partial = await h.rows();
    expect(h.deleted).toEqual([h.storageKey]);
    expect(partial.pii).toMatchObject({ status: "blocked", modeApplied: "block", policyRevision: 2 });
    expect(partial.run).toEqual({
      mode: "detect", policy_revision: null, status: "processing", action_taken: null,
      pending_decision: expect.objectContaining({ action: "block", mode: "block", policyRevision: 2, blockReason: "email" })
    });
    expect(partial.job).toMatchObject({ status: "queued", error_message: "pii_job_failed: database unavailable" });
    expect(partial.audit).toEqual([expect.objectContaining({ event_type: "pii_blocked" })]);

    // An admin saves the policy again before the retry. The retry does not
    // evaluate the file again: its bytes are gone.
    expect((await h.settings.setPiiProtection(h.tenantId, retryPolicy, PII_SAVE_ALLOWED)).revision).toBe(3);
    h.faults.failBlockedRunUpdate = false;
    await h.runQueuedJob();

    const { pii, run, job, audit } = await h.rows();
    expect(pii).toMatchObject({ status: "blocked", modeApplied: "block", policyRevision: 2, scanRunId: h.queued.scanRunId });
    expect(run).toEqual({ mode: "block", policy_revision: 2, status: "blocked", action_taken: "block", pending_decision: null });
    expect(job).toMatchObject({ mode: "detect", status: "completed" });
    // One event: the retry found the event of the first attempt.
    expect(audit).toEqual([{
      event_type: "pii_blocked",
      payload: expect.objectContaining({ scanRunId: h.queued.scanRunId, mode: "block", policyRevision: 2, objectDeleted: true })
    }]);
  });

  test("the failed-job recovery finishes a block that a job recorded before it ran out of attempts", async () => {
    const h = await setupQueued();
    expect((await h.settings.setPiiProtection(h.tenantId, policy("block"), PII_SAVE_ALLOWED)).revision).toBe(2);
    h.faults.failBlockedRunUpdate = true;
    await h.runQueuedJob();
    // The last attempt failed, or the stale-claim sweep failed the job.
    await superuserPool().query("UPDATE pii_scan_jobs SET status = 'failed' WHERE job_id = $1", [h.queued.jobId]);
    await h.settings.setPiiProtection(h.tenantId, { ...DEFAULT_PII_PROTECTION, enabled: false }, PII_SAVE_ALLOWED);

    const failed = (await h.piiScanJobs.listUnfinishedFailures(1000)).find((job) => job.jobId === h.queued.jobId);
    expect(failed).toBeDefined();
    h.faults.failBlockedRunUpdate = false;
    await h.handler.finishFailedJob(failed!);

    const { pii, run, audit } = await h.rows();
    expect(pii).toMatchObject({ status: "blocked", modeApplied: "block", policyRevision: 2 });
    expect(run).toEqual({ mode: "block", policy_revision: 2, status: "blocked", action_taken: "block", pending_decision: null });
    expect(audit.map((row) => row.event_type)).toEqual(["pii_blocked"]);
    expect((await h.piiScanJobs.listUnfinishedFailures(1000)).map((job) => job.jobId)).not.toContain(h.queued.jobId);
  });
});
