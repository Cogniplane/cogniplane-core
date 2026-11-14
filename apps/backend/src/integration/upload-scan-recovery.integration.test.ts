import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "@cogniplane/shared-types";

import { ArtifactStore, UPLOAD_SCAN_PENDING_KEY } from "../services/artifacts/artifact-store.js";
import { UploadAdmission } from "../services/artifacts/upload-admission.js";
import { AuditEventStore } from "../services/audit-event-store.js";
import { PiiArtifactScanEnqueuer, type PiiArtifactScanPlan } from "../services/pii/pii-artifact-scan-enqueuer.js";
import { PiiImportScopeRegistry } from "../services/pii/pii-import-scopes.js";
import { resolvePiiPolicy } from "../services/pii/pii-policy.js";
import type { PiiDecision, PiiPolicyRead } from "../services/pii/pii-protection-service.js";
import { PiiScanJobHandler } from "../services/pii/pii-scan-job-handler.js";
import { PII_SCAN_INTERRUPTED, PiiScanJobStore, type PiiScanJobRecord } from "../services/pii/pii-scan-job-store.js";
import { PiiScanRunStore } from "../services/pii/pii-scan-run-store.js";
import { SchedulerWorker } from "../services/scheduler-worker.js";
import { SessionStore } from "../services/session-store.js";
import { adminDatabaseUrl, appPool, maintenancePool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

const BLOCK: PiiDecision = {
  action: "block",
  findings: [{ entityType: "email", value: "", start: 0, end: 7, confidence: "high" }],
  blockReason: "email",
  providerType: "rules",
  providerModel: null
};
const QUEUED_PLAN: PiiArtifactScanPlan = { kind: "async", mode: "detect", entityTypes: [] };

// The worker tick and the stores under test, with fakes only for the policy
// provider and the object storage. Ticks see rows of every tenant; the
// assertions read this tenant's rows only.
async function setup(mode: PiiProtectionSettings["mode"] = "block") {
  const graph = await seedTenantGraph();
  const { tenantId, userId, sessionId } = graph;
  const artifacts = new ArtifactStore(appPool());
  const runs = new PiiScanRunStore(appPool());
  const jobs = new PiiScanJobStore(appPool(), maintenancePool());
  const auditEvents = new AuditEventStore(appPool());
  const objects = new Map<string, string>();
  const deleted: string[] = [];
  const storage = {
    async put(input: { storageKey: string; stream: Readable }) {
      let body = "";
      for await (const chunk of input.stream) body += String(chunk);
      objects.set(input.storageKey, body);
      return { storageBackend: "local" as const, storageKey: input.storageKey, fileSizeBytes: body.length, checksumSha256: "sum" };
    },
    async delete(storageKey: string) {
      deleted.push(storageKey);
      objects.delete(storageKey);
    }
  };
  const importScopes = new PiiImportScopeRegistry();
  const read: PiiPolicyRead = {
    tenantId,
    policy: resolvePiiPolicy({
      ...DEFAULT_PII_PROTECTION, enabled: mode !== "off", mode,
      scopes: { ...DEFAULT_PII_PROTECTION.scopes, uploads: true }
    }, importScopes),
    revision: 4
  };
  const evaluateArtifactWithPolicy = vi.fn(async () => ({
    decision: BLOCK,
    appliedPolicy: { mode: "block" as const, revision: 4 }
  }));
  const piiProtection = {
    readPolicy: async () => read,
    isSubjectInScope: () => true,
    evaluateArtifactWithPolicy,
    evaluateTextWithPolicy: vi.fn()
  };
  const subjectReader = {
    readMessageText: async () => null,
    readArtifact: async ({ artifactId }: { artifactId: string }) => {
      const artifact = await artifacts.get(tenantId, artifactId);
      if (!artifact) return null;
      return {
        artifactId, contentType: artifact.mimeType, entityTypes: [],
        readContent: async () => objects.get(artifact.storageKey) ?? ""
      };
    }
  };
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const handler = new PiiScanJobHandler({
    piiProtection, piiScanRuns: runs, piiScanJobs: jobs, messages: { setPiiDetail: vi.fn() },
    artifacts, storage, subjectReader, auditEvents, logger, importScopes
  });
  const enqueuer = (runStore: Pick<PiiScanRunStore, "create" | "update" | "recordDecision"> = runs,
    artifactStore: Pick<ArtifactStore, "setPiiDetail" | "update"> = artifacts) =>
    new PiiArtifactScanEnqueuer({
      piiProtection, importScopes, piiScanRuns: runStore, piiScanJobs: jobs,
      artifacts: artifactStore, storage, subjectReader, auditEvents, logger
    });
  const admission = (scanEnqueuer: Pick<PiiArtifactScanEnqueuer, "plan" | "enqueue">) => new UploadAdmission({
    sessions: new SessionStore(appPool()), artifacts, storage, piiScanEnqueuer: scanEnqueuer, logger
  });
  const upload = async (scanEnqueuer: Pick<PiiArtifactScanEnqueuer, "plan" | "enqueue">) => {
    const uploads = admission(scanEnqueuer);
    const ticket = await uploads.begin({ tenantId, sessionId, userId });
    return uploads.admit(ticket, {
      artifactName: "notes.txt", mimeType: "text/plain", source: "upload",
      stream: Readable.from([Buffer.from("jane@example.com")])
    });
  };
  // One worker tick that drains PII work. Other tenants' leftover jobs are
  // claimed by the tick but not run.
  const tick = () => new SchedulerWorker({
    settings: {} as never, sessions: {} as never, messages: {} as never, toolContexts: {} as never,
    runtimeAdapter: {} as never, turnAdmission: {} as never,
    resolveRuntime: async () => ({ kind: "error", message: "unused" }),
    auditEvents, logger,
    piiScanJobs: jobs,
    piiScanJobHandler: {
      execute: (job: PiiScanJobRecord) => job.tenantId === tenantId ? handler.execute(job) : Promise.resolve(),
      finishFailedJob: (job: PiiScanJobRecord) => job.tenantId === tenantId ? handler.finishFailedJob(job) : Promise.resolve()
    }
  }, { schedulingEnabled: false, maxConcurrentJobs: 1, maxConcurrentPiiJobs: 100, jobTimeoutMs: 1_000, abortSettleGraceMs: 0 }).tick();
  // Older than the tick's cutoff (job timeout + grace + 60 s).
  const age = async (artifactId: string) => {
    await superuserPool().query(
      "UPDATE artifacts SET updated_at = NOW() - INTERVAL '1 hour' WHERE tenant_id = $1 AND artifact_id = $2",
      [tenantId, artifactId]
    );
    await superuserPool().query(
      `UPDATE pii_scan_runs SET updated_at = NOW() - INTERVAL '1 hour'
       WHERE tenant_id = $1 AND subject_type = 'artifact' AND subject_id = $2`,
      [tenantId, artifactId]
    );
  };
  const artifactState = async (artifactId: string) => {
    const { rows } = await superuserPool().query(
      "SELECT status, detail_json FROM artifacts WHERE tenant_id = $1 AND artifact_id = $2",
      [tenantId, artifactId]
    );
    return rows[0] as { status: string; detail_json: Record<string, unknown> & { pii?: Record<string, unknown> } };
  };
  const scanState = async (artifactId: string) => {
    const scanRuns = await superuserPool().query(
      `SELECT scan_run_id, status, error_message, pending_decision FROM pii_scan_runs
       WHERE tenant_id = $1 AND subject_type = 'artifact' AND subject_id = $2 ORDER BY created_at`,
      [tenantId, artifactId]
    );
    const scanJobs = await superuserPool().query(
      `SELECT status, attempts FROM pii_scan_jobs
       WHERE tenant_id = $1 AND subject_type = 'artifact' AND subject_id = $2 ORDER BY created_at`,
      [tenantId, artifactId]
    );
    return { runs: scanRuns.rows, jobs: scanJobs.rows };
  };
  const auditCount = async (type: string) => Number((await superuserPool().query(
    "SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = $1 AND event_type = $2",
    [tenantId, type]
  )).rows[0].n);
  const newestArtifactId = async () => (await superuserPool().query(
    "SELECT artifact_id FROM artifacts WHERE tenant_id = $1 AND artifact_name = 'notes.txt' ORDER BY created_at DESC LIMIT 1",
    [tenantId]
  )).rows[0].artifact_id as string;
  return {
    ...graph, artifacts, runs, jobs, storage, deleted, enqueuer, upload, tick, age, artifactState, scanState,
    auditCount, newestArtifactId, evaluateArtifactWithPolicy, logger
  };
}

describe.skipIf(!adminDatabaseUrl())("upload admission state", () => {
  test("an upload that needs no scan commits ready, with its audit event, in one transaction", async () => {
    const h = await setup("off");

    const result = await h.upload(h.enqueuer());

    expect(result).toMatchObject({ kind: "admitted", artifact: { status: "ready" } });
    const state = await h.artifactState(await h.newestArtifactId());
    expect(state.status).toBe("ready");
    expect(state.detail_json[UPLOAD_SCAN_PENDING_KEY]).toBeUndefined();
    expect(await h.auditCount("artifact_uploaded")).toBe(1);
  });

  test("fault: the scan never starts after the pending row commits; one tick after the cutoff fails the upload", async () => {
    const h = await setup();
    // The process or the pool fails between the row commit and the scan state.
    const result = await h.upload({
      plan: async () => QUEUED_PLAN,
      enqueue: async () => { throw new Error("timeout exceeded when trying to connect"); }
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    const artifactId = await h.newestArtifactId();
    expect((await h.artifactState(artifactId)).status).toBe("pending");

    // Not stale yet: a live scan could still own it.
    await h.tick();
    expect((await h.artifactState(artifactId)).status).toBe("pending");

    await h.age(artifactId);
    await h.tick();
    const state = await h.artifactState(artifactId);
    expect(state.status).toBe("failed");
    expect(state.detail_json.pii).toEqual({ status: "failed", summaryText: PII_SCAN_INTERRUPTED });
    // Nothing scanned the bytes, so they stay.
    expect(h.deleted).toEqual([]);
  });
});

describe.skipIf(!adminDatabaseUrl())("queued scan enqueue transaction", () => {
  test("the scan run, the pending detail and the job commit together", async () => {
    const h = await setup("detect");
    const result = await h.upload(h.enqueuer());
    expect(result).toMatchObject({ kind: "admitted", artifact: { status: "pending" } });
    const artifactId = await h.newestArtifactId();
    const { runs, jobs } = await h.scanState(artifactId);
    expect(runs).toMatchObject([{ status: "pending" }]);
    expect(jobs).toMatchObject([{ status: "queued" }]);
    expect((await h.artifactState(artifactId)).detail_json.pii)
      .toEqual({ status: "pending", modeApplied: "detect", scanRunId: runs[0].scan_run_id });
  });

  test("a failed job insert rolls back the scan run and the pending detail", async () => {
    const h = await setup("detect");
    const artifactId = (await h.upload({ plan: async () => QUEUED_PLAN, enqueue: async () => ({ kind: "skipped" }) })
      .then(() => h.newestArtifactId()));
    // `off` passes the scan run check and fails the job check.
    await expect(h.jobs.enqueueArtifactScan({
      tenantId: h.tenantId, artifactId, sourceSessionId: h.sessionId, sourceUserId: h.userId,
      mode: "off" as never, payload: {}
    })).rejects.toThrow(/pii_scan_jobs_mode_check/);
    expect(await h.scanState(artifactId)).toEqual({ runs: [], jobs: [] });
    expect((await h.artifactState(artifactId)).detail_json.pii).toBeUndefined();
  });

  test("a scan run and pending detail with no job are closed by one worker tick", async () => {
    const h = await setup("detect");
    const artifactId = (await h.upload({ plan: async () => QUEUED_PLAN, enqueue: async () => ({ kind: "skipped" }) })
      .then(() => h.newestArtifactId()));
    // The state the earlier three-transaction enqueue could leave.
    const run = await h.runs.create({
      tenantId: h.tenantId, subjectType: "artifact", subjectId: artifactId,
      sourceSessionId: h.sessionId, sourceUserId: h.userId, mode: "detect", status: "pending"
    });
    await h.artifacts.setPiiDetail(h.tenantId, artifactId, { status: "pending", modeApplied: "detect", scanRunId: run.scanRunId });
    await h.age(artifactId);

    await h.tick();

    expect((await h.scanState(artifactId)).runs).toMatchObject([{ status: "failed", error_message: PII_SCAN_INTERRUPTED }]);
    const state = await h.artifactState(artifactId);
    expect(state.status).toBe("failed");
    expect(state.detail_json.pii).toEqual({
      status: "failed", modeApplied: "detect", scanRunId: run.scanRunId, summaryText: PII_SCAN_INTERRUPTED
    });
  });
});

describe.skipIf(!adminDatabaseUrl())("synchronous block decision recovery", () => {
  test("fault: the scan run update throws after the purge; one tick ends the run blocked, not failed", async () => {
    const h = await setup();
    let failed = false;
    const runStore = {
      create: h.runs.create.bind(h.runs),
      recordDecision: h.runs.recordDecision.bind(h.runs),
      update: async (...args: Parameters<PiiScanRunStore["update"]>) => {
        if (args[2].status === "blocked" && !failed) {
          failed = true;
          throw new Error("Connection terminated unexpectedly");
        }
        return h.runs.update(...args);
      }
    };

    const result = await h.upload(h.enqueuer(runStore));

    expect(result).toMatchObject({ kind: "blocked", blockReason: "email" });
    const artifactId = await h.newestArtifactId();
    expect(h.deleted).toHaveLength(1);
    // The verdict is on the upload; the decision waits on the open run.
    expect(await h.artifactState(artifactId)).toMatchObject({ status: "failed", detail_json: { pii: { status: "blocked" } } });
    expect((await h.scanState(artifactId)).runs).toMatchObject([{ status: "processing", pending_decision: { action: "block" } }]);
    expect(await h.auditCount("pii_blocked")).toBe(1);

    await h.age(artifactId);
    await h.tick();

    expect(await h.scanState(artifactId)).toMatchObject({
      runs: [{ status: "blocked", pending_decision: null }],
      jobs: [{ status: "completed", attempts: 1 }]
    });
    expect(await h.artifactState(artifactId)).toMatchObject({ status: "failed", detail_json: { pii: { status: "blocked" } } });
    // The recorded decision is applied, not evaluated again, and audited once.
    expect(h.evaluateArtifactWithPolicy).toHaveBeenCalledTimes(1);
    expect(await h.auditCount("pii_blocked")).toBe(1);
  });

  test("fault: the verdict write throws after the purge; one tick finishes the block on the pending upload", async () => {
    const h = await setup();
    let failed = false;
    const artifactStore = {
      update: h.artifacts.update.bind(h.artifacts),
      setPiiDetail: async (...args: Parameters<ArtifactStore["setPiiDetail"]>) => {
        if (!failed) {
          failed = true;
          throw new Error("Connection terminated unexpectedly");
        }
        return h.artifacts.setPiiDetail(...args);
      }
    };

    const result = await h.upload(h.enqueuer(h.runs, artifactStore));

    expect(result).toMatchObject({ kind: "blocked" });
    const artifactId = await h.newestArtifactId();
    expect((await h.artifactState(artifactId)).status).toBe("pending");
    expect(await h.auditCount("pii_blocked")).toBe(0);

    await h.age(artifactId);
    await h.tick();

    expect(await h.artifactState(artifactId)).toMatchObject({
      status: "failed",
      detail_json: { pii: { status: "blocked", modeApplied: "block", policyRevision: 4, blockReason: "email" } }
    });
    expect((await h.scanState(artifactId)).runs).toMatchObject([{ status: "blocked", pending_decision: null }]);
    expect(await h.auditCount("pii_blocked")).toBe(1);
    expect(h.evaluateArtifactWithPolicy).toHaveBeenCalledTimes(1);
  });

  test("fault: the verdict write of an allow throws; one tick makes the upload ready with the recorded verdict", async () => {
    const h = await setup();
    h.evaluateArtifactWithPolicy.mockResolvedValueOnce({
      decision: { action: "allow", reason: "no_findings" } as never,
      appliedPolicy: { mode: "block", revision: 4 }
    });
    let failed = false;
    const artifactStore = {
      update: h.artifacts.update.bind(h.artifacts),
      setPiiDetail: async (...args: Parameters<ArtifactStore["setPiiDetail"]>) => {
        if (!failed) {
          failed = true;
          throw new Error("Connection terminated unexpectedly");
        }
        return h.artifacts.setPiiDetail(...args);
      }
    };

    const result = await h.upload(h.enqueuer(h.runs, artifactStore));

    expect(result).toMatchObject({ kind: "admitted" });
    const artifactId = await h.newestArtifactId();
    // Not a provider error: the upload stays pending, not failed, and the
    // allow waits on the open run.
    expect((await h.artifactState(artifactId)).status).toBe("pending");
    expect((await h.scanState(artifactId)).runs).toMatchObject([{ status: "processing", pending_decision: { action: "allow" } }]);

    await h.age(artifactId);
    await h.tick();

    expect(await h.artifactState(artifactId)).toMatchObject({
      status: "ready",
      detail_json: { pii: { status: "scanned", modeApplied: "block", policyRevision: 4 } }
    });
    expect(await h.scanState(artifactId)).toMatchObject({
      runs: [{ status: "completed", pending_decision: null }],
      jobs: [{ status: "completed", attempts: 1 }]
    });
    expect(h.evaluateArtifactWithPolicy).toHaveBeenCalledTimes(1);
    expect(h.deleted).toEqual([]);
  });

  test("a synchronous scan stopped before its decision is failed and keeps the bytes", async () => {
    const h = await setup();
    // The provider call never returns: the run stays `processing` with no decision.
    h.evaluateArtifactWithPolicy.mockImplementationOnce(() => new Promise(() => {}));
    void h.upload(h.enqueuer());
    await vi.waitFor(() => expect(h.evaluateArtifactWithPolicy).toHaveBeenCalled());
    const artifactId = await h.newestArtifactId();
    await h.age(artifactId);

    await h.tick();

    expect((await h.scanState(artifactId)).runs).toMatchObject([{ status: "failed", pending_decision: null }]);
    expect(await h.artifactState(artifactId)).toMatchObject({
      status: "failed", detail_json: { pii: { status: "failed", summaryText: PII_SCAN_INTERRUPTED } }
    });
    expect(h.deleted).toEqual([]);
  });
});

describe.skipIf(!adminDatabaseUrl())("stalled upload recovery boundaries", () => {
  test("recovery reads every tenant, and closes an upload only in its own tenant scope", async () => {
    const h = await setup();
    const other = await seedTenantGraph();
    await h.upload({ plan: async () => QUEUED_PLAN, enqueue: async () => ({ kind: "skipped" }) });
    const artifactId = await h.newestArtifactId();
    await h.age(artifactId);

    expect(await h.jobs.listStalledUploads(61_000, 10_000)).toContainEqual({ tenantId: h.tenantId, artifactId });
    expect(await h.jobs.recoverStalledUpload(other.tenantId, artifactId, 61_000)).toBe("skipped");
    expect((await h.artifactState(artifactId)).status).toBe("pending");
    expect(await h.jobs.recoverStalledUpload(h.tenantId, artifactId, 61_000)).toBe("failed");
    expect((await h.artifactState(artifactId)).status).toBe("failed");
    expect(await h.jobs.recoverStalledUpload(h.tenantId, artifactId, 61_000)).toBe("skipped");
  });

  test("an upload with a queued job, or an open run that a failed job owns, is left to that job", async () => {
    const h = await setup("detect");
    await h.upload(h.enqueuer());
    const queued = await h.newestArtifactId();
    await h.age(queued);
    expect(await h.jobs.recoverStalledUpload(h.tenantId, queued, 61_000)).toBe("skipped");

    await superuserPool().query(
      "UPDATE pii_scan_jobs SET status = 'failed' WHERE tenant_id = $1 AND subject_id = $2",
      [h.tenantId, queued]
    );
    expect(await h.jobs.recoverStalledUpload(h.tenantId, queued, 61_000)).toBe("skipped");
    expect((await h.jobs.listStalledUploads(61_000, 10_000)).map((upload) => upload.artifactId)).not.toContain(queued);
    expect((await h.artifactState(queued)).status).toBe("pending");
  });
});

describe.skipIf(!adminDatabaseUrl())("PII job completion is fenced by the claimed attempt", () => {
  async function claimedJob() {
    const h = await setup("detect");
    await h.upload(h.enqueuer());
    const artifactId = await h.newestArtifactId();
    const claim = async () => (await h.jobs.claimDueJobs(10_000)).find((job) => job.subjectId === artifactId)!;
    return { h, claim };
  }

  test("a late recordFailure does not change a completed job", async () => {
    const { h, claim } = await claimedJob();
    const first = await claim();
    expect(first.attempts).toBe(1);
    // Attempt 1 stalls; its claim expires and attempt 2 takes the job.
    await superuserPool().query("UPDATE pii_scan_jobs SET claimed_at = NOW() - INTERVAL '1 hour' WHERE job_id = $1", [first.jobId]);
    await h.jobs.sweepStaleClaims(60_000);
    const second = await claim();
    expect(second).toMatchObject({ jobId: first.jobId, attempts: 2 });

    // Attempt 1 fails while attempt 2 holds the claim: nothing changes.
    expect(await h.jobs.recordFailure(first, "artifact not found for scan job", { permanent: true })).toBeNull();
    expect(await h.jobs.getById(h.tenantId, first.jobId)).toMatchObject({ status: "claimed", attempts: 2 });

    expect(await h.jobs.markCompleted(second)).toBe(true);
    expect(await h.jobs.recordFailure(first, "late", { permanent: true })).toBeNull();
    expect(await h.jobs.recordFailure(second, "late")).toBeNull();
    expect(await h.jobs.markCompleted(first)).toBe(false);
    expect(await h.jobs.getById(h.tenantId, first.jobId)).toMatchObject({ status: "completed", errorMessage: null });
  });

  test("the claimed attempt still records its failure", async () => {
    const { h, claim } = await claimedJob();
    const first = await claim();
    expect(await h.jobs.recordFailure(first, "provider timeout")).toMatchObject({ status: "queued", errorMessage: "provider timeout" });
    expect(await h.jobs.recordFailure({ ...first, tenantId: (await seedTenantGraph()).tenantId }, "other tenant")).toBeNull();
  });
});
