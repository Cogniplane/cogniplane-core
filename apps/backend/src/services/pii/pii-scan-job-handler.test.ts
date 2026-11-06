import { test, expect } from "vitest";

import {
  PiiScanJobHandler,
  type PiiScanJobHandlerDeps,
  type PiiScanSubjectReader
} from "./pii-scan-job-handler.js";
import type { ArtifactRecord } from "../artifacts/artifact-store.js";
import { PiiImportScopeRegistry } from "./pii-import-scopes.js";
import type { PiiAppliedPolicy, PiiDecision, PiiSubject } from "./pii-protection-service.js";
import { PiiProtectionServiceError } from "./pii-protection-service.js";
import type { PiiScanJobRecord } from "./pii-scan-job-store.js";
import type { PiiScanRunDecision, PiiScanRunRecord } from "./pii-scan-run-store.js";

test("missing deployment KEK remains retryable and can complete after configuration repair", async () => {
  const overrides = { evaluateThrows: new PiiProtectionServiceError("pii_kek_missing", "No KEK configured") as Error | undefined };
  const h = buildDeps(overrides);
  const handler = new PiiScanJobHandler(h.deps);
  await handler.execute(sampleJob());
  expect(h.failureCalls).toHaveLength(1);
  expect(h.failureCalls[0].permanent).toBe(false);
  expect(h.updateCalls.some((call) => call.patch.status === "failed")).toBe(false);
  overrides.evaluateThrows = undefined;
  await handler.execute(sampleJob({ attempts: 2 }));
  expect(h.completedCalls).toHaveLength(1);
});

test("acknowledgement failure preserves an applied decision", async () => {
  const h = buildDeps();
  h.deps.piiScanJobs.markCompleted = async () => { throw new Error("database unavailable"); };
  await new PiiScanJobHandler(h.deps).execute(sampleJob());
  expect(h.failureCalls).toEqual([]);
  expect(h.updateCalls.at(-1)?.patch.status).toBe("completed");
});

test("a failed subject update cannot publish a terminal scan run", async () => {
  const h = buildDeps();
  h.deps.artifacts.setPiiDetail = async () => { throw new Error("subject write unavailable"); };
  await new PiiScanJobHandler(h.deps).execute(sampleJob());
  expect(h.updateCalls.map((call) => call.patch.status)).toEqual(["processing"]);
  expect(h.failureCalls).toHaveLength(1);
  expect(h.completedCalls).toEqual([]);
});

test("finishFailedJob marks the subject failed before it closes the scan run", async () => {
  const h = buildDeps();
  await new PiiScanJobHandler(h.deps).finishFailedJob(sampleJob({ status: "failed", errorMessage: "claim expired" }));
  expect(h.artifactPiiCalls.map((call) => call.pii.status)).toEqual(["failed"]);
  expect(h.updateCalls.map((call) => call.patch)).toEqual([
    expect.objectContaining({ status: "failed", errorMessage: "claim expired" })
  ]);
});

test("finishFailedJob leaves the scan run open when the subject write fails", async () => {
  // The worker lists failed jobs with an open scan run, so it tries again.
  const h = buildDeps();
  h.deps.artifacts.setPiiDetail = async () => { throw new Error("subject write unavailable"); };
  await expect(new PiiScanJobHandler(h.deps).finishFailedJob(sampleJob({ status: "failed" })))
    .rejects.toThrow("subject write unavailable");
  expect(h.updateCalls).toEqual([]);
});

function subjectProbe() {
  const h = buildDeps();
  const subjects: PiiSubject[] = [];
  const warnings: Array<{ payload: unknown; message: string }> = [];
  const allow = { decision: { action: "allow", reason: "no_findings" } as const, appliedPolicy: DETECT_POLICY };
  h.deps.piiProtection.evaluateArtifactWithPolicy = async ({ subject }) => {
    subjects.push(subject);
    return allow;
  };
  h.deps.piiProtection.evaluateTextWithPolicy = async ({ subject }) => {
    subjects.push(subject);
    return allow;
  };
  h.deps.logger.warn = (payload, message) => { warnings.push({ payload, message }); };
  const importScopes = new PiiImportScopeRegistry();
  importScopes.register({ subjectKind: "partner_import", scopeKey: "partnerImports", defaultOn: true });
  return { h, subjects, warnings, handler: new PiiScanJobHandler({ ...h.deps, importScopes }) };
}

test("a queued job keeps a registered import kind, so its own scope gates it", async () => {
  const { handler, subjects, warnings } = subjectProbe();
  await handler.execute(sampleJob({ payload: { subjectKind: "partner_import" } }));
  expect(subjects).toEqual([{ kind: "import", subjectKind: "partner_import" }]);
  expect(warnings).toEqual([]);
});

test("a queued job with an unregistered kind keeps its identity, is scanned, and is logged", async () => {
  const { handler, subjects, warnings, h } = subjectProbe();
  await handler.execute(sampleJob({ payload: { subjectKind: "retired_import" } }));
  expect(subjects).toEqual([{ kind: "import", subjectKind: "retired_import" }]);
  expect(warnings).toEqual([{
    payload: { jobId: "job-1", tenantId: "tenant-1", subjectKind: "retired_import" },
    message: "PII scan job has an unregistered subject kind; it is scanned as in scope"
  }]);
  expect(h.completedCalls).toHaveLength(1);
});

test("a queued job without a kind uses its subject type, as before", async () => {
  const { handler, subjects, warnings } = subjectProbe();
  await handler.execute(sampleJob({ payload: {} }));
  await handler.execute(sampleJob({ subjectType: "message", subjectId: "msg-1", scanRunId: "scan-2", payload: {} }));
  expect(subjects).toEqual([{ kind: "upload" }, { kind: "chat_prompt" }]);
  expect(warnings).toEqual([]);
});

test("an invalid policy keeps the queued job retryable, deletes nothing, and writes a configuration-error audit event", async () => {
  const h = buildDeps({
    evaluateThrows: new PiiProtectionServiceError("pii_policy_invalid", "invalid policy", { policyRevision: 4 }),
    withAuditEvents: true
  });
  const job = sampleJob();
  await new PiiScanJobHandler(h.deps).execute(job);
  expect(h.failureCalls).toEqual([expect.objectContaining({ permanent: false, error: "pii_policy_invalid: invalid policy" })]);
  expect(h.deleteCalls).toEqual([]);
  expect(h.artifactPiiCalls).toEqual([]);
  expect(h.auditCalls).toEqual([
    expect.objectContaining({
      type: "pii_policy_invalid",
      payload: {
        jobId: job.jobId, scanRunId: job.scanRunId, subjectType: job.subjectType, subjectId: job.subjectId,
        policyRevision: 4
      }
    })
  ]);
});

type UpdateScanRunCall = { tenantId: string; scanRunId: string; patch: Record<string, unknown> };
type SetMessagePiiCall = { tenantId: string; messageId: string; pii: Record<string, unknown> };
type SetArtifactPiiCall = { tenantId: string; artifactId: string; pii: Record<string, unknown> };

// The policy that the fake evaluation applied. It matches sampleJob's mode
// unless a test sets another one.
const DETECT_POLICY: PiiAppliedPolicy = { mode: "detect", revision: 1 };

function buildDeps(overrides: {
  decision?: PiiDecision;
  appliedPolicy?: PiiAppliedPolicy;
  evaluateThrows?: Error;
  reader?: Partial<PiiScanSubjectReader>;
  withAuditEvents?: boolean;
} = {}) {
  const updateCalls: UpdateScanRunCall[] = [];
  const messagePiiCalls: SetMessagePiiCall[] = [];
  const artifactPiiCalls: SetArtifactPiiCall[] = [];
  const completedCalls: Array<{ tenantId: string; jobId: string }> = [];
  const failureCalls: Array<{ tenantId: string; jobId: string; error: string; permanent: boolean }> = [];
  const auditCalls: Array<Record<string, unknown>> = [];
  const deleteCalls: string[] = [];
  const evaluateCalls: string[] = [];
  // Each scan run row: its recorded decision, and whether it is closed. The
  // fake keeps the store's rules: the first decision wins, only while the run
  // is open, and the terminal update clears it.
  const runs = new Map<string, { pendingDecision: PiiScanRunDecision | null; closed: boolean }>();
  const run = (scanRunId = "scan-1") => {
    const row = runs.get(scanRunId) ?? { pendingDecision: null, closed: false };
    runs.set(scanRunId, row);
    return row;
  };
  const recordDecisionCalls: PiiScanRunDecision[] = [];
  // Audit event types that an earlier attempt wrote for this scan run.
  const existingAuditTypes = new Set<string>();
  let failureReturn: { status: PiiScanJobRecord["status"] } | null = { status: "queued" };
  // Artifact row the handler re-fetches to find the current storage key. Tests
  // override `artifactGet` to model a missing/deleted row or a diverging key.
  let artifactGet: (() => Pick<ArtifactRecord, "storageBackend" | "storageKey" | "status"> | null) =
    () => ({ storageBackend: "local", storageKey: "users/user-1/session-1/art-1.txt", status: "ready" });
  let storageDeleteThrows: Error | null = null;

  const evaluation = async () => {
    evaluateCalls.push("evaluate");
    if (overrides.evaluateThrows) throw overrides.evaluateThrows;
    return {
      decision: overrides.decision ?? ({ action: "allow", reason: "disabled" } as PiiDecision),
      appliedPolicy: overrides.appliedPolicy ?? DETECT_POLICY
    };
  };
  const piiProtection: PiiScanJobHandlerDeps["piiProtection"] = {
    evaluateTextWithPolicy: evaluation,
    evaluateArtifactWithPolicy: evaluation
  };

  const reader: PiiScanSubjectReader = {
    async readMessageText({ tenantId, messageId }) {
      if (overrides.reader?.readMessageText) {
        return overrides.reader.readMessageText({ tenantId, messageId });
      }
      return "my email is user@example.com";
    },
    async readArtifact({ tenantId, artifactId }) {
      if (overrides.reader?.readArtifact) {
        return overrides.reader.readArtifact({ tenantId, artifactId });
      }
      return {
        artifactId,
        contentType: "text/plain",
        entityTypes: [],
        async readContent() {
          return "my email is user@example.com";
        }
      };
    }
  };

  const logger: PiiScanJobHandlerDeps["logger"] = {
    error() {},
    warn() {}
  };

  return {
    deps: {
      piiProtection,
      piiScanRuns: {
        async finishUndecidedFailure(tenantId: string, scanRunId: string, errorMessage: string, writeSubject: () => Promise<void>) {
          const row = run(scanRunId);
          if (row.closed) return null;
          if (row.pendingDecision) return row.pendingDecision;
          await writeSubject();
          updateCalls.push({ tenantId, scanRunId, patch: { status: "failed", errorMessage } });
          row.closed = true;
          return null;
        },
        async update(tenantId: string, scanRunId: string, patch: Record<string, unknown>) {
          updateCalls.push({ tenantId, scanRunId, patch });
          const row = run(scanRunId);
          if (patch.status === "processing" && row.closed) return null;
          if (patch.pendingDecision === null) row.pendingDecision = null;
          if (patch.status !== undefined && patch.status !== "pending" && patch.status !== "processing") row.closed = true;
          return {} as PiiScanRunRecord;
        },
        async recordDecision(_tenantId: string, scanRunId: string, decision: PiiScanRunDecision) {
          recordDecisionCalls.push(decision);
          const row = run(scanRunId);
          if (row.closed || row.pendingDecision) return false;
          row.pendingDecision = decision;
          return true;
        },
        async getPendingDecision(_tenantId: string, scanRunId: string) {
          const row = run(scanRunId);
          return row.closed ? null : row.pendingDecision;
        }
      },
      piiScanJobs: {
        async markCompleted(tenantId: string, jobId: string) {
          completedCalls.push({ tenantId, jobId });
        },
        async recordFailure(
          tenantId: string,
          jobId: string,
          error: string,
          options: { backoffMs?: number; permanent?: boolean } = {}
        ) {
          failureCalls.push({ tenantId, jobId, error, permanent: options.permanent ?? false });
          return failureReturn;
        }
      },
      messages: {
        async setPiiDetail(tenantId: string, messageId: string, pii: Record<string, unknown>) {
          messagePiiCalls.push({ tenantId, messageId, pii });
        }
      },
      artifacts: {
        async setPiiDetail(tenantId: string, artifactId: string, pii: Record<string, unknown>) {
          artifactPiiCalls.push({ tenantId, artifactId, pii });
        },
        async get() {
          return artifactGet();
        }
      },
      storage: {
        async delete(storageKey: string) {
          if (storageDeleteThrows) throw storageDeleteThrows;
          deleteCalls.push(storageKey);
        }
      },
      subjectReader: reader,
      logger,
      ...(overrides.withAuditEvents
        ? {
            auditEvents: {
              async create(input: Record<string, unknown>) {
                auditCalls.push(input);
              },
              async createSystemEvent(input: Record<string, unknown>) {
                auditCalls.push({ ...input, userId: null });
              },
              async hasPiiScanRunEvent(_tenantId: string, type: string) {
                return existingAuditTypes.has(type) || auditCalls.some((call) => call.type === type);
              }
            }
          }
        : {})
    },
    updateCalls,
    messagePiiCalls,
    artifactPiiCalls,
    completedCalls,
    failureCalls,
    auditCalls,
    deleteCalls,
    evaluateCalls,
    run,
    recordDecisionCalls,
    existingAuditTypes,
    setFailureReturn: (value: { status: "queued" | "failed" } | null) => {
      failureReturn = value;
    },
    setArtifactGet: (value: typeof artifactGet) => {
      artifactGet = value;
    },
    setStorageDeleteThrows: (value: Error | null) => {
      storageDeleteThrows = value;
    }
  };
}

function sampleJob(overrides: Partial<PiiScanJobRecord> = {}): PiiScanJobRecord {
  const now = new Date().toISOString();
  return {
    tenantId: "tenant-1",
    jobId: "job-1",
    scanRunId: "scan-1",
    subjectType: "artifact",
    subjectId: "art-1",
    sourceSessionId: null,
    sourceUserId: "user-1",
    mode: "detect",
    payload: { subjectKind: "upload" },
    status: "claimed",
    attempts: 1,
    maxAttempts: 3,
    runAfter: now,
    claimedAt: now,
    completedAt: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("PiiScanJobHandler completes an allow decision and records a scanned detail", async () => {
  const { deps, updateCalls, artifactPiiCalls, completedCalls } = buildDeps({
    decision: { action: "allow", reason: "no_findings" }
  });
  const handler = new PiiScanJobHandler(deps);

  await handler.execute(sampleJob());

  expect(updateCalls[0].patch.status).toBe("processing");
  expect(updateCalls[1].patch.status).toBe("completed");
  expect(updateCalls[1].patch.actionTaken).toBe("allow");
  expect(artifactPiiCalls.length).toBe(1);
  expect(artifactPiiCalls[0].pii.status).toBe("scanned");
  expect(artifactPiiCalls[0].pii.modeApplied).toBe("detect");
  expect(artifactPiiCalls[0].pii.scanRunId).toBe("scan-1");
  expect(completedCalls.length).toBe(1);
});

test.each([
  [{ action: "allow", reason: "no_findings" }, "scanned"],
  [{ action: "transform", findings: [], transformedText: "", providerType: "rules", providerModel: null }, "transformed"]
] as const)("PiiScanJobHandler marks a %j verdict whose PDF images were not scanned", async (decision, status) => {
  const { deps, artifactPiiCalls } = buildDeps({
    decision: decision as unknown as PiiDecision,
    reader: {
      readArtifact: async ({ artifactId }) => ({
        artifactId, contentType: "application/pdf", entityTypes: [],
        readContent: async () => "Quarterly report",
        imagesNotScanned: () => true
      })
    }
  });

  await new PiiScanJobHandler(deps).execute(sampleJob());

  expect(artifactPiiCalls.at(-1)?.pii).toMatchObject({ status, imagesNotScanned: true });
});

test("PiiScanJobHandler persists report findings and attaches findingsCount", async () => {
  const { deps, updateCalls, artifactPiiCalls } = buildDeps({
    decision: {
      action: "report",
      findings: [
        { entityType: "email", value: "a@b.com", start: 0, end: 7, confidence: "high" }
      ],
      providerType: "openai-compatible",
      providerModel: "google/gemini-2.5-flash"
    }
  });
  const handler = new PiiScanJobHandler(deps);

  await handler.execute(sampleJob());

  expect(updateCalls[1].patch.status).toBe("completed");
  expect(updateCalls[1].patch.actionTaken).toBe("report");
  expect((updateCalls[1].patch.findings as unknown[])?.length).toBe(1);
  expect(artifactPiiCalls[0].pii.findingsCount).toBe(1);
});

test("PiiScanJobHandler records a blocked outcome with block reason on the subject", async () => {
  const { deps, updateCalls, messagePiiCalls } = buildDeps({
    decision: {
      action: "block",
      findings: [
        { entityType: "email", value: "a@b.com", start: 0, end: 7, confidence: "high" }
      ],
      blockReason: "email",
      providerType: "openai-compatible",
      providerModel: "google/gemini-2.5-flash"
    }
  });
  const handler = new PiiScanJobHandler(deps);

  await handler.execute(
    sampleJob({ subjectType: "message", subjectId: "msg-1", mode: "block", payload: { subjectKind: "chat_prompt" } })
  );

  expect(updateCalls[1].patch.status).toBe("blocked");
  expect(messagePiiCalls.length).toBe(1);
  expect(messagePiiCalls[0].pii.status).toBe("blocked");
  expect(messagePiiCalls[0].pii.blockReason).toBe("email");
});

test("PiiScanJobHandler records recoverable failure without touching subject detail", async () => {
  const { deps, failureCalls, artifactPiiCalls, updateCalls } = buildDeps({
    evaluateThrows: new PiiProtectionServiceError("pii_provider_unavailable", "timeout")
  });
  const handler = new PiiScanJobHandler(deps);

  await handler.execute(sampleJob());

  expect(failureCalls.length).toBe(1);
  expect(failureCalls[0].error.startsWith("pii_provider_unavailable: ")).toBeTruthy();
  // The only scan-run update issued should be the initial "processing" transition
  // — we do not mark the scan run as failed while the job is still retrying.
  expect(updateCalls.length).toBe(1);
  expect(artifactPiiCalls.length).toBe(0);
});

test("PiiScanJobHandler marks subject failed when the job runs out of attempts", async () => {
  const helper = buildDeps({
    evaluateThrows: new PiiProtectionServiceError("pii_provider_unavailable", "timeout")
  });
  helper.setFailureReturn({ status: "failed" });
  const handler = new PiiScanJobHandler(helper.deps);

  await handler.execute(sampleJob());

  const scanRunUpdates = helper.updateCalls.map((call) => call.patch.status);
  expect(scanRunUpdates).toEqual(["processing", "failed"]);
  expect(helper.artifactPiiCalls.length).toBe(1);
  expect(helper.artifactPiiCalls[0].pii.status).toBe("failed");
});

test("a terminal failure whose subject write fails leaves the scan run open for recovery", async () => {
  const helper = buildDeps({
    evaluateThrows: new PiiProtectionServiceError("pii_provider_unavailable", "timeout")
  });
  helper.setFailureReturn({ status: "failed" });
  helper.deps.artifacts.setPiiDetail = async () => { throw new Error("subject write unavailable"); };

  await new PiiScanJobHandler(helper.deps).execute(sampleJob());

  // The worker lists failed jobs with an open scan run and finishes them.
  expect(helper.updateCalls.map((call) => call.patch.status)).toEqual(["processing"]);
});

test("PiiScanJobHandler emits pii_reported audit event for report decisions", async () => {
  const { deps, auditCalls } = buildDeps({
    decision: {
      action: "report",
      findings: [
        { entityType: "email", value: "", start: 0, end: 7, confidence: "high" }
      ],
      providerType: "openai-compatible",
      providerModel: "google/gemini"
    },
    withAuditEvents: true
  });
  const handler = new PiiScanJobHandler(deps);
  await handler.execute(sampleJob());
  expect(auditCalls.length).toBe(1);
  expect(auditCalls[0].type).toBe("pii_reported");
  const payload = auditCalls[0].payload as Record<string, unknown>;
  expect(payload.subjectType).toBe("artifact");
  expect(payload.findingsCount).toBe(1);
});

test("PiiScanJobHandler emits pii_blocked audit event for block decisions", async () => {
  const { deps, auditCalls } = buildDeps({
    decision: {
      action: "block",
      findings: [],
      providerType: "openai-compatible",
      providerModel: "m",
      blockReason: "email"
    },
    withAuditEvents: true
  });
  const handler = new PiiScanJobHandler(deps);
  await handler.execute(sampleJob());
  expect(auditCalls.length).toBe(1);
  expect(auditCalls[0].type).toBe("pii_blocked");
  const payload = auditCalls[0].payload as Record<string, unknown>;
  expect(payload.blockReason).toBe("email");
  expect(payload.objectDeleted).toBe(true);
});

const blockDecision = {
  action: "block" as const,
  findings: [],
  providerType: "openai-compatible",
  providerModel: "m",
  blockReason: "email"
};

test("PiiScanJobHandler deletes the CURRENT stored key on block (re-fetch, not payload)", async () => {
  const { deps, deleteCalls, setArtifactGet } = buildDeps({ decision: blockDecision });
  // The row's current key differs from what the job payload froze at enqueue —
  // the store's key must win.
  setArtifactGet(() => ({ storageBackend: "bucket", storageKey: "current/rotated-key.txt", status: "ready" }));
  const handler = new PiiScanJobHandler(deps);
  await handler.execute(sampleJob({ payload: { subjectKind: "upload", storageKey: "stale/old-key.txt" } }));
  expect(deleteCalls).toEqual(["current/rotated-key.txt"]);
});

test("PiiScanJobHandler skips delete when the artifact row is missing (idempotent re-run)", async () => {
  const { deps, deleteCalls, setArtifactGet } = buildDeps({ decision: blockDecision });
  setArtifactGet(() => null);
  const handler = new PiiScanJobHandler(deps);
  await handler.execute(sampleJob());
  expect(deleteCalls).toEqual([]);
});

test("PiiScanJobHandler does not delete an object for a message block", async () => {
  const { deps, deleteCalls } = buildDeps({ decision: blockDecision });
  const handler = new PiiScanJobHandler(deps);
  await handler.execute(sampleJob({ subjectType: "message", subjectId: "msg-1" }));
  expect(deleteCalls).toEqual([]);
});

test("PiiScanJobHandler blocks anyway and audits the orphan when delete fails", async () => {
  const { deps, auditCalls, updateCalls, setStorageDeleteThrows } = buildDeps({
    decision: blockDecision,
    withAuditEvents: true
  });
  setStorageDeleteThrows(new Error("s3 down"));
  const handler = new PiiScanJobHandler(deps);
  await handler.execute(sampleJob());

  // The block still lands: scan run flipped to blocked.
  expect(updateCalls.some((c) => c.patch.status === "blocked")).toBe(true);
  // The orphan is queryable, and the pii_blocked payload records objectDeleted:false.
  const orphan = auditCalls.find((a) => a.type === "pii_block_object_orphaned");
  expect(orphan).toBeTruthy();
  const blocked = auditCalls.find((a) => a.type === "pii_blocked");
  expect((blocked!.payload as Record<string, unknown>).objectDeleted).toBe(false);
});

test("PiiScanJobHandler writes a system audit event when sourceUserId is null", async () => {
  const { deps, auditCalls } = buildDeps({
    decision: {
      action: "report",
      findings: [],
      providerType: "openai-compatible",
      providerModel: "m"
    },
    withAuditEvents: true
  });
  const handler = new PiiScanJobHandler(deps);
  await handler.execute(sampleJob({ sourceUserId: null }));
  expect(auditCalls).toEqual([expect.objectContaining({ type: "pii_reported", userId: null })]);
});

test("an invalid policy on a job with no source user still writes the configuration-error audit event", async () => {
  const h = buildDeps({
    evaluateThrows: new PiiProtectionServiceError("pii_policy_invalid", "invalid policy"),
    withAuditEvents: true
  });
  await new PiiScanJobHandler(h.deps).execute(sampleJob({ sourceUserId: null }));
  expect(h.auditCalls).toEqual([expect.objectContaining({ type: "pii_policy_invalid", userId: null })]);
  expect(h.failureCalls).toEqual([expect.objectContaining({ permanent: false })]);
});

test("PiiScanJobHandler does not emit audit on allow decisions", async () => {
  const { deps, auditCalls } = buildDeps({
    decision: { action: "allow", reason: "no_findings" },
    withAuditEvents: true
  });
  const handler = new PiiScanJobHandler(deps);
  await handler.execute(sampleJob());
  expect(auditCalls.length).toBe(0);
});

test("recoverable provider failure is recorded as transient (permanent=false)", async () => {
  const { deps, failureCalls } = buildDeps({
    evaluateThrows: new PiiProtectionServiceError("pii_provider_unavailable", "timeout")
  });
  const handler = new PiiScanJobHandler(deps);
  await handler.execute(sampleJob());
  expect(failureCalls.length).toBe(1);
  expect(failureCalls[0].permanent).toBe(false);
});

test("artifact_not_found is recorded as permanent and does not retry", async () => {
  const { deps, failureCalls } = buildDeps({
    reader: {
      async readArtifact() {
        return null;
      }
    }
  });
  // helper.setFailureReturn defaults to {status: "queued"}, but for permanent
  // failures we expect the SQL would set status='failed' regardless. The store
  // is faked here, so we assert the *flag* the handler passed.
  const handler = new PiiScanJobHandler(deps);
  await handler.execute(sampleJob());
  expect(failureCalls.length).toBe(1);
  expect(failureCalls[0].permanent).toBe(true);
  expect(failureCalls[0].error).toMatch(/not found for scan job/);
});

test("PiiProtectionServiceError with a permanent code is classified as permanent", async () => {
  const { deps, failureCalls } = buildDeps({
    evaluateThrows: new PiiProtectionServiceError("file_too_large", "23MB > 5MB cap")
  });
  const handler = new PiiScanJobHandler(deps);
  await handler.execute(sampleJob());
  expect(failureCalls.length).toBe(1);
  expect(failureCalls[0].permanent).toBe(true);
});

test("removed artifacts finish queued jobs without reading or sending file content", async () => {
  const h = buildDeps({ reader: { readArtifact: async () => { throw new Error("Must not read a removed file"); } } });
  h.setArtifactGet(() => ({ storageBackend: "local", storageKey: "removed", status: "deleted" }));
  await new PiiScanJobHandler(h.deps).execute(sampleJob());
  expect(h.completedCalls).toHaveLength(1);
  expect(h.failureCalls).toEqual([]);
  expect(h.artifactPiiCalls).toEqual([]);
  expect(h.updateCalls[0].patch).toMatchObject({ status: "completed", summaryText: "File removed before scanning." });
});

const reportDecision: PiiDecision = {
  action: "report",
  findings: [{ entityType: "email", value: "", start: 0, end: 7, confidence: "high" }],
  providerType: "rules",
  providerModel: null
};
const transformDecision: PiiDecision = {
  action: "transform",
  transformedText: "[REDACTED:email]",
  findings: [{ entityType: "email", value: "", start: 0, end: 7, confidence: "high" }],
  providerType: "rules",
  providerModel: null
};

// An admin saved another policy (revision 7) after the job was queued and
// before it ran. The job applies and records that policy, not its queued mode.
test.each([
  ["pii_reported", reportDecision, "transform", "detect", "scanned", "completed"],
  ["pii_blocked", { ...blockDecision, findings: reportDecision.findings }, "detect", "block", "blocked", "blocked"],
  ["pii_transformed", transformDecision, "detect", "transform", "transformed", "transformed"]
] as const)(
  "a %s job records the mode and revision of the policy it ran under, not job.mode",
  async (eventType, decision, queuedMode, mode, detailStatus, runStatus) => {
    const h = buildDeps({ decision, appliedPolicy: { mode, revision: 7 }, withAuditEvents: true });
    await new PiiScanJobHandler(h.deps).execute(sampleJob({ mode: queuedMode }));

    expect(h.artifactPiiCalls.at(-1)?.pii).toMatchObject({ status: detailStatus, modeApplied: mode, policyRevision: 7 });
    expect(h.updateCalls.at(-1)?.patch).toMatchObject({ status: runStatus, mode, policyRevision: 7 });
    expect(h.auditCalls).toEqual([
      expect.objectContaining({ type: eventType, payload: expect.objectContaining({ mode, policyRevision: 7 }) })
    ]);
  }
);

test("a job whose policy was turned off before it ran records mode off and the revision", async () => {
  const h = buildDeps({
    decision: { action: "allow", reason: "disabled" },
    appliedPolicy: { mode: "off", revision: 8 }
  });
  await new PiiScanJobHandler(h.deps).execute(sampleJob({ mode: "transform" }));
  expect(h.artifactPiiCalls).toEqual([
    expect.objectContaining({ pii: expect.objectContaining({ status: "scanned", modeApplied: "off", policyRevision: 8 }) })
  ]);
  expect(h.updateCalls.at(-1)?.patch).toMatchObject({ status: "completed", actionTaken: "allow", mode: "off", policyRevision: 8 });
});

test("a message job records the applied mode and revision on the message detail", async () => {
  const h = buildDeps({ decision: blockDecision, appliedPolicy: { mode: "block", revision: 2 } });
  await new PiiScanJobHandler(h.deps).execute(
    sampleJob({ subjectType: "message", subjectId: "msg-1", mode: "detect", payload: { subjectKind: "chat_prompt" } })
  );
  expect(h.messagePiiCalls.map((call) => call.pii)).toEqual([
    { status: "blocked", modeApplied: "block", policyRevision: 2, scanRunId: "scan-1", blockReason: "email" }
  ]);
});

// A block decision as the scan run records it before the job applies it.
const recordedBlock: PiiScanRunDecision = {
  action: "block",
  mode: "block",
  policyRevision: 3,
  findings: reportDecision.findings,
  providerType: "rules",
  providerModel: null,
  blockReason: "email"
};
const STORAGE_KEY = "users/user-1/session-1/art-1.txt";

test("the job records its decision before it deletes the bytes of a blocked file", async () => {
  const h = buildDeps({ decision: { ...blockDecision, findings: reportDecision.findings }, appliedPolicy: { mode: "block", revision: 3 } });
  h.deps.piiScanRuns.recordDecision = async () => { throw new Error("database unavailable"); };
  await new PiiScanJobHandler(h.deps).execute(sampleJob());
  expect(h.deleteCalls).toEqual([]);
  expect(h.artifactPiiCalls).toEqual([]);
  expect(h.failureCalls).toHaveLength(1);

  const recorded = buildDeps({ decision: { ...blockDecision, findings: reportDecision.findings }, appliedPolicy: { mode: "block", revision: 3 } });
  await new PiiScanJobHandler(recorded.deps).execute(sampleJob());
  expect(recorded.recordDecisionCalls).toEqual([{ ...recordedBlock, providerType: "openai-compatible", providerModel: "m" }]);
});

test("a retry after a failed scan run update finishes the recorded block and does not decide again", async () => {
  const overrides: Parameters<typeof buildDeps>[0] = {
    decision: { ...blockDecision, findings: reportDecision.findings },
    appliedPolicy: { mode: "block", revision: 3 },
    withAuditEvents: true
  };
  const h = buildDeps(overrides);
  const update = h.deps.piiScanRuns.update;
  let failBlockedUpdate = true;
  h.deps.piiScanRuns.update = async (tenantId, scanRunId, patch) => {
    if (failBlockedUpdate && patch.status === "blocked") throw new Error("database unavailable");
    return update(tenantId, scanRunId, patch);
  };
  const handler = new PiiScanJobHandler(h.deps);
  await handler.execute(sampleJob());
  expect(h.deleteCalls).toEqual([STORAGE_KEY]);
  expect(h.failureCalls).toHaveLength(1);
  expect(h.completedCalls).toEqual([]);

  // An admin turns protection off before the retry. The bytes are gone, so
  // the retry must not record the file as scanned.
  overrides.decision = { action: "allow", reason: "disabled" };
  overrides.appliedPolicy = { mode: "off", revision: 4 };
  failBlockedUpdate = false;
  await handler.execute(sampleJob({ attempts: 2 }));

  expect(h.evaluateCalls).toHaveLength(1);
  expect(h.deleteCalls).toEqual([STORAGE_KEY, STORAGE_KEY]);
  expect(h.artifactPiiCalls.map((call) => call.pii)).toEqual([
    expect.objectContaining({ status: "blocked", modeApplied: "block", policyRevision: 3 }),
    expect.objectContaining({ status: "blocked", modeApplied: "block", policyRevision: 3 })
  ]);
  expect(h.updateCalls.at(-1)?.patch).toMatchObject({
    status: "blocked", mode: "block", policyRevision: 3, actionTaken: "block", pendingDecision: null
  });
  expect(h.auditCalls.map((call) => call.type)).toEqual(["pii_blocked"]);
  expect(h.completedCalls).toHaveLength(1);
});

test("a resumed decision writes the audit event that the earlier attempt did not write", async () => {
  const h = buildDeps({ withAuditEvents: true });
  h.run().pendingDecision = {
    action: "report", mode: "detect", policyRevision: 5, findings: reportDecision.findings,
    providerType: "rules", providerModel: null
  };
  await new PiiScanJobHandler(h.deps).execute(sampleJob({ attempts: 2 }));
  expect(h.evaluateCalls).toEqual([]);
  expect(h.auditCalls).toEqual([
    expect.objectContaining({ type: "pii_reported", payload: expect.objectContaining({ mode: "detect", policyRevision: 5 }) })
  ]);
  expect(h.updateCalls.map((call) => call.patch.status)).toEqual(["completed"]);
  expect(h.completedCalls).toHaveLength(1);
});

test("a resumed block writes no second orphan event when the delete fails again", async () => {
  const h = buildDeps({ withAuditEvents: true });
  h.run().pendingDecision = recordedBlock;
  h.existingAuditTypes.add("pii_block_object_orphaned");
  h.setStorageDeleteThrows(new Error("s3 down"));
  await new PiiScanJobHandler(h.deps).execute(sampleJob({ attempts: 2 }));
  expect(h.auditCalls).toEqual([
    expect.objectContaining({ type: "pii_blocked", payload: expect.objectContaining({ objectDeleted: false }) })
  ]);
});

test("a failed audit read stops a resumed decision before its event and its terminal update", async () => {
  const h = buildDeps({ withAuditEvents: true });
  h.run().pendingDecision = recordedBlock;
  h.deps.auditEvents!.hasPiiScanRunEvent = async () => { throw new Error("database unavailable"); };
  await new PiiScanJobHandler(h.deps).execute(sampleJob({ attempts: 2 }));
  expect(h.auditCalls).toEqual([]);
  expect(h.updateCalls).toEqual([]);
  expect(h.failureCalls).toHaveLength(1);
  expect(h.evaluateCalls).toEqual([]);
});

test("finishFailedJob finishes a recorded block instead of marking the subject failed", async () => {
  const h = buildDeps({ withAuditEvents: true });
  h.run().pendingDecision = recordedBlock;
  h.existingAuditTypes.add("pii_blocked");
  await new PiiScanJobHandler(h.deps).finishFailedJob(sampleJob({ status: "failed", errorMessage: "claim expired" }));
  expect(h.evaluateCalls).toEqual([]);
  expect(h.deleteCalls).toEqual([STORAGE_KEY]);
  expect(h.artifactPiiCalls.map((call) => call.pii.status)).toEqual(["blocked"]);
  expect(h.updateCalls.map((call) => call.patch)).toEqual([
    expect.objectContaining({ status: "blocked", mode: "block", policyRevision: 3, pendingDecision: null })
  ]);
  expect(h.auditCalls).toEqual([]);
});

test("an attempt that decides after another attempt recorded a decision applies the recorded one", async () => {
  const h = buildDeps({ decision: { action: "allow", reason: "disabled" }, appliedPolicy: { mode: "off", revision: 4 }, withAuditEvents: true });
  // The other attempt recorded a block and wrote its event while this one evaluated.
  h.deps.piiScanRuns.recordDecision = async () => {
    h.run().pendingDecision = recordedBlock;
    return false;
  };
  h.existingAuditTypes.add("pii_blocked");
  await new PiiScanJobHandler(h.deps).execute(sampleJob());
  expect(h.artifactPiiCalls.map((call) => call.pii)).toEqual([
    expect.objectContaining({ status: "blocked", modeApplied: "block", policyRevision: 3 })
  ]);
  expect(h.updateCalls.at(-1)?.patch).toMatchObject({ status: "blocked", mode: "block", policyRevision: 3 });
  expect(h.auditCalls).toEqual([]);
  expect(h.completedCalls).toHaveLength(1);
});

test("an attempt whose scan run closed while it evaluated applies nothing and leaves the job to that run", async () => {
  const h = buildDeps({ decision: { ...blockDecision, findings: reportDecision.findings }, appliedPolicy: { mode: "block", revision: 3 } });
  h.deps.piiScanRuns.recordDecision = async () => {
    h.run().closed = true;
    return false;
  };
  await new PiiScanJobHandler(h.deps).execute(sampleJob());
  expect(h.deleteCalls).toEqual([]);
  expect(h.artifactPiiCalls).toEqual([]);
  expect(h.updateCalls.map((call) => call.patch.status)).toEqual(["processing"]);
  expect(h.completedCalls).toEqual([]);
  expect(h.failureCalls).toEqual([]);
});

test("a PDF that a scan with mode off did not read is not marked as text only", async () => {
  const { deps, artifactPiiCalls } = buildDeps({
    decision: { action: "allow", reason: "disabled" },
    appliedPolicy: { mode: "off", revision: 2 },
    reader: {
      readArtifact: async ({ artifactId }) => ({
        artifactId, contentType: "application/pdf", entityTypes: [],
        readContent: async () => "Quarterly report",
        imagesNotScanned: () => true
      })
    }
  });
  await new PiiScanJobHandler(deps).execute(sampleJob());
  expect(artifactPiiCalls).toEqual([
    expect.objectContaining({ pii: { status: "scanned", modeApplied: "off", policyRevision: 2, scanRunId: "scan-1", findingsCount: 0 } })
  ]);
});


test("an attempt of a closed run reads no subject and applies no new decision", async () => {
  const h = buildDeps({ withAuditEvents: true });
  h.run().closed = true;
  h.deps.subjectReader.readArtifact = async () => { throw new Error("object not found"); };
  await new PiiScanJobHandler(h.deps).execute(sampleJob());
  expect(h.evaluateCalls).toEqual([]);
  expect(h.artifactPiiCalls).toEqual([]);
  expect(h.failureCalls).toEqual([]);
  expect(h.auditCalls).toEqual([]);
});
