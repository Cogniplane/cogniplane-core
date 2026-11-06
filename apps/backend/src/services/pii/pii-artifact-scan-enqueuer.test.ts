import { test, expect, vi } from "vitest";
import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "@cogniplane/shared-types";

import {
  PiiArtifactScanEnqueuer,
  type EnqueueArtifactPiiScanInput,
  type PiiArtifactSubjectReader
} from "./pii-artifact-scan-enqueuer.js";
import { isPiiSubjectInScope, PiiImportScopeRegistry } from "./pii-import-scopes.js";
import { resolvePiiPolicy } from "./pii-policy.js";
import {
  PiiProtectionService,
  PiiProtectionServiceError,
  type PiiDecision,
  type PiiPolicyRead
} from "./pii-protection-service.js";
import { RuleBasedPiiDetector } from "./rule-based-pii-detector.js";

// A registered import source, as an overlay registers one.
const importScopes = new PiiImportScopeRegistry();
importScopes.register({ subjectKind: "partner_import", scopeKey: "partnerImports", defaultOn: true });

function buildDeps(overrides: {
  settings?: Partial<PiiProtectionSettings>;
  // A raw stored policy, used instead of `settings`.
  stored?: unknown;
  decision?: PiiDecision;
  imagesNotScanned?: boolean;
  evaluateThrows?: Error;
  readerReturnsNull?: boolean;
  readerThrows?: Error;
  scanRunCreateThrows?: Error;
  storageDeleteThrows?: Error;
  withAuditEvents?: boolean;
} = {}) {
  const settings: PiiProtectionSettings = {
    ...DEFAULT_PII_PROTECTION,
    ...overrides.settings,
    scopes: { ...DEFAULT_PII_PROTECTION.scopes, ...(overrides.settings?.scopes ?? {}) },
    detectors: { ...DEFAULT_PII_PROTECTION.detectors, ...(overrides.settings?.detectors ?? {}) }
  };

  const scanRunCreateCalls: Array<Record<string, unknown>> = [];
  const scanRunUpdateCalls: Array<{ scanRunId: string; patch: Record<string, unknown> }> = [];
  const jobCalls: Array<Record<string, unknown>> = [];
  const piiDetailCalls: Array<{ tenantId: string; artifactId: string; pii: Record<string, unknown> }> = [];
  const artifactUpdateCalls: Array<{ tenantId: string; artifactId: string; input: Record<string, unknown> }> = [];
  const logWarnCalls: Array<{ payload: unknown; message: string }> = [];
  const auditCalls: Array<Record<string, unknown>> = [];
  const deleteCalls: string[] = [];
  let scanRunCounter = 0;

  const reader: PiiArtifactSubjectReader = {
    async readArtifact({ tenantId, artifactId }) {
      if (overrides.readerThrows) throw overrides.readerThrows;
      if (overrides.readerReturnsNull) return null;
      return {
        artifactId,
        contentType: "text/plain",
        entityTypes: [],
        async readContent() {
          return `content for ${tenantId}/${artifactId}`;
        },
        imagesNotScanned: () => overrides.imagesNotScanned ?? false
      };
    }
  };

  const deps = {
    piiProtection: {
      async readPolicy(): Promise<PiiPolicyRead> {
        return { tenantId: "tenant-1", policy: resolvePiiPolicy("stored" in overrides ? overrides.stored : settings, importScopes), revision: 3 };
      },
      isSubjectInScope: (policy: ReturnType<typeof resolvePiiPolicy>, subject: Parameters<typeof isPiiSubjectInScope>[1]) =>
        isPiiSubjectInScope(policy.settings, subject, importScopes),
      async evaluateArtifactWithPolicy(_input: unknown, read?: PiiPolicyRead) {
        if (overrides.evaluateThrows) throw overrides.evaluateThrows;
        return {
          decision: overrides.decision ?? ({ action: "allow", reason: "no_findings" } as PiiDecision),
          appliedPolicy: { mode: read!.policy.settings.mode, revision: read!.revision }
        };
      }
    },
    piiScanRuns: {
      async create(input: Record<string, unknown>) {
        scanRunCreateCalls.push(input);
        if (overrides.scanRunCreateThrows) throw overrides.scanRunCreateThrows;
        scanRunCounter += 1;
        return { scanRunId: `scan-${scanRunCounter}`, tenantId: input.tenantId as string } as never;
      },
      async update(tenantId: string, scanRunId: string, patch: Record<string, unknown>) {
        scanRunUpdateCalls.push({ scanRunId, patch });
        return null;
      }
    },
    piiScanJobs: {
      async create(input: Record<string, unknown>) {
        jobCalls.push(input);
        return { jobId: "job-1", scanRunId: input.scanRunId as string } as never;
      }
    },
    artifacts: {
      async setPiiDetail(tenantId: string, artifactId: string, pii: Record<string, unknown>) {
        piiDetailCalls.push({ tenantId, artifactId, pii });
      },
      async update(tenantId: string, artifactId: string, input: Record<string, unknown>) {
        artifactUpdateCalls.push({ tenantId, artifactId, input });
        return null as never;
      }
    },
    storage: {
      async delete(storageKey: string) {
        if (overrides.storageDeleteThrows) throw overrides.storageDeleteThrows;
        deleteCalls.push(storageKey);
      }
    },
    subjectReader: reader,
    importScopes,
    logger: {
      warn(payload: unknown, message: string) {
        logWarnCalls.push({ payload, message });
      },
      error() {}
    },
    ...(overrides.withAuditEvents
      ? {
          auditEvents: {
            async create(input: Record<string, unknown>) {
              auditCalls.push(input);
            }
          }
        }
      : {})
  };

  return {
    deps,
    scanRunCreateCalls,
    scanRunUpdateCalls,
    jobCalls,
    piiDetailCalls,
    artifactUpdateCalls,
    logWarnCalls,
    auditCalls,
    deleteCalls
  };
}

function sampleInput(overrides: Partial<EnqueueArtifactPiiScanInput> = {}): EnqueueArtifactPiiScanInput {
  return {
    tenantId: "tenant-1",
    sessionId: "session-1",
    userId: "user-1",
    artifactId: "art-1",
    contentType: "text/plain",
    storageKey: "users/user-1/session-1/art-1.txt",
    source: "upload",
    ...overrides
  };
}

test("block mode records a failed scan when the subject lookup throws", async () => {
  const h = buildDeps({ settings: { enabled: true, mode: "block" }, readerThrows: new Error("database unavailable") });
  const result = await new PiiArtifactScanEnqueuer(h.deps).enqueue(sampleInput());
  expect(result.kind).toBe("failed");
  expect(h.scanRunUpdateCalls.at(-1)?.patch.status).toBe("failed");
  expect(h.artifactUpdateCalls.at(-1)?.input.status).toBe("failed");
});

test("enqueue returns skipped when PII protection is disabled", async () => {
  const { deps, scanRunCreateCalls } = buildDeps({
    settings: { enabled: false, mode: "detect" }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result).toEqual({ kind: "skipped" });
  expect(scanRunCreateCalls.length).toBe(0);
});

test("an invalid stored policy stops the upload without a scan, a finding, or byte deletion", async () => {
  const h = buildDeps({
    stored: { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "bogus" },
    withAuditEvents: true
  });
  const result = await new PiiArtifactScanEnqueuer(h.deps).enqueue(sampleInput());
  expect(result).toMatchObject({ kind: "failed", errorCode: "pii_policy_invalid" });
  expect(h.scanRunCreateCalls).toEqual([]);
  expect(h.deleteCalls).toEqual([]);
  expect(h.artifactUpdateCalls.at(-1)?.input.status).toBe("failed");
  expect(h.piiDetailCalls.at(-1)?.pii).toEqual({ status: "failed", summaryText: "pii_policy_invalid" });
  expect(h.auditCalls).toEqual([expect.objectContaining({
    type: "pii_policy_invalid",
    payload: { subjectType: "artifact", subjectId: "art-1", source: "upload", policyRevision: 3 }
  })]);
});

test("an invalid stored policy leaves an upload alone when its valid scope is off", async () => {
  const h = buildDeps({
    stored: { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "off", scopes: { chatPrompts: true, uploads: false } }
  });
  expect(await new PiiArtifactScanEnqueuer(h.deps).enqueue(sampleInput())).toEqual({ kind: "skipped" });
});

test("an unregistered import source is scanned as in scope and logged", async () => {
  const h = buildDeps({ settings: { enabled: true, mode: "block", scopes: { chatPrompts: false, uploads: false } } });
  const result = await new PiiArtifactScanEnqueuer(h.deps).enqueue(sampleInput({ source: "unknown_import" }));
  expect(result.kind).toBe("allowed");
  expect(h.logWarnCalls).toEqual([expect.objectContaining({
    payload: expect.objectContaining({ source: "unknown_import" }),
    message: "PII scan source is not registered; it is scanned as in scope"
  })]);
});

test("enqueue returns skipped when the upload scope is disabled", async () => {
  const { deps, scanRunCreateCalls } = buildDeps({
    settings: {
      enabled: true,
      mode: "detect",
      scopes: { chatPrompts: true, uploads: false, partnerImports: true }
    }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput({ source: "upload" }));
  expect(result).toEqual({ kind: "skipped" });
  expect(scanRunCreateCalls.length).toBe(0);
});

test("detect mode stamps pending BEFORE the job is enqueued", async () => {
  const { deps, jobCalls } = buildDeps({ settings: { enabled: true, mode: "detect" } });
  let releasePending!: () => void;
  let pendingEntered!: () => void;
  const gate = new Promise<void>((resolve) => { releasePending = resolve; });
  const entered = new Promise<void>((resolve) => { pendingEntered = resolve; });
  let status = "unscanned";
  deps.artifacts.setPiiDetail = async (_tenant, _artifact, pii) => {
    pendingEntered();
    await gate;
    status = String(pii.status);
  };
  const createJob = deps.piiScanJobs.create;
  deps.piiScanJobs.create = async (input) => {
    const job = await createJob(input);
    // A worker can finish as soon as the queued job is visible.
    status = "completed";
    return job;
  };
  const pending = new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  try {
    await entered;
    expect(jobCalls).toHaveLength(0);
    releasePending();
    await expect(pending).resolves.toMatchObject({ kind: "queued" });
    expect(jobCalls).toHaveLength(1);
    expect(status).toBe("completed");
  } finally {
    releasePending();
    await pending;
  }
});

test("transform mode queues an async job (artifact transform deferred)", async () => {
  const { deps, jobCalls, piiDetailCalls } = buildDeps({
    settings: { enabled: true, mode: "transform" }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("queued");
  if (result.kind !== "queued") return;
  expect(result.mode).toBe("transform");
  expect(jobCalls.length).toBe(1);
  expect(piiDetailCalls[0].pii.modeApplied).toBe("transform");
});

test("block mode evaluates synchronously and allows a clean artifact", async () => {
  const { deps, scanRunUpdateCalls, jobCalls, piiDetailCalls, artifactUpdateCalls } = buildDeps({
    settings: { enabled: true, mode: "block" },
    decision: { action: "allow", reason: "no_findings" }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("allowed");
  expect(jobCalls.length).toBe(0);
  const completed = scanRunUpdateCalls.find((c) => c.patch.status === "completed");
  expect(completed).toBeTruthy();
  expect(piiDetailCalls.at(-1)?.pii.status).toBe("scanned");
  // Artifact status must NOT be flipped to failed when the block check passes.
  expect(artifactUpdateCalls.length).toBe(0);
});

const dirtyBlockDecision: PiiDecision = {
  action: "block",
  findings: [{ entityType: "email", value: "a@b.com", start: 0, end: 7, confidence: "high" }],
  blockReason: "email",
  providerType: "openai-compatible",
  providerModel: "google/gemini-2.5-flash"
};

test("block mode on a dirty artifact marks it failed, deletes the object, and returns blocked", async () => {
  const { deps, scanRunUpdateCalls, piiDetailCalls, artifactUpdateCalls, jobCalls, deleteCalls, auditCalls } =
    buildDeps({
      settings: { enabled: true, mode: "block" },
      decision: dirtyBlockDecision,
      withAuditEvents: true
    });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("blocked");
  if (result.kind !== "blocked") return;
  expect(result.blockReason).toBe("email");
  expect(jobCalls.length).toBe(0);
  const blocked = scanRunUpdateCalls.find((c) => c.patch.status === "blocked");
  expect(blocked).toBeTruthy();
  expect(artifactUpdateCalls.length).toBe(1);
  expect(artifactUpdateCalls[0].input.status).toBe("failed");
  expect(piiDetailCalls.at(-1)?.pii.status).toBe("blocked");
  expect(piiDetailCalls.at(-1)?.pii.blockReason).toBe("email");
  // The stored bytes are purged and the audit records the delete.
  expect(deleteCalls).toEqual(["users/user-1/session-1/art-1.txt"]);
  const blockedAudit = auditCalls.find((a) => a.type === "pii_blocked");
  expect((blockedAudit!.payload as Record<string, unknown>).objectDeleted).toBe(true);
});

test("block still returns blocked and audits an orphan when object delete fails", async () => {
  const { deps, scanRunUpdateCalls, auditCalls } = buildDeps({
    settings: { enabled: true, mode: "block" },
    decision: dirtyBlockDecision,
    storageDeleteThrows: new Error("s3 down"),
    withAuditEvents: true
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  // The block outcome must stand even though cleanup failed.
  expect(result.kind).toBe("blocked");
  expect(scanRunUpdateCalls.some((c) => c.patch.status === "blocked")).toBe(true);
  // The orphan is queryable, and pii_blocked records objectDeleted:false.
  expect(auditCalls.some((a) => a.type === "pii_block_object_orphaned")).toBe(true);
  const blockedAudit = auditCalls.find((a) => a.type === "pii_blocked");
  expect((blockedAudit!.payload as Record<string, unknown>).objectDeleted).toBe(false);
});

test("block mode records that a clean PDF's images were not scanned", async () => {
  const { deps, piiDetailCalls } = buildDeps({ settings: { enabled: true, mode: "block" }, imagesNotScanned: true });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput({ contentType: "application/pdf" }));
  expect(result.kind).toBe("allowed");
  expect(piiDetailCalls.at(-1)?.pii).toMatchObject({ status: "scanned", imagesNotScanned: true });
});

test("block mode fails closed when the provider throws", async () => {
  const { deps, scanRunUpdateCalls, artifactUpdateCalls, piiDetailCalls, deleteCalls } = buildDeps({
    settings: { enabled: true, mode: "block" },
    evaluateThrows: new PiiProtectionServiceError("pii_provider_unavailable", "timeout")
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("failed");
  if (result.kind !== "failed") return;
  expect(result.errorCode).toBe("pii_provider_unavailable");
  expect(artifactUpdateCalls.at(-1)?.input.status).toBe("failed");
  expect(piiDetailCalls.at(-1)?.pii.status).toBe("failed");
  const failed = scanRunUpdateCalls.find((c) => c.patch.status === "failed");
  expect(failed).toBeTruthy();
  // A provider ERROR is not a confirmed block — the content was never scanned,
  // so the object must NOT be deleted (transient-outage safety).
  expect(deleteCalls).toEqual([]);
});

test("detect mode rejects an unscannable type at once and deletes its bytes", async () => {
  const { deps, jobCalls, artifactUpdateCalls, deleteCalls } = buildDeps({
    settings: { enabled: true, mode: "detect" },
    evaluateThrows: new PiiProtectionServiceError("unsupported_mime", "cannot scan image/png files")
  });
  const input = sampleInput({ contentType: "image/png", storageKey: "users/user-1/session-1/art-1.png" });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(input);
  expect(result).toMatchObject({ kind: "failed", errorCode: "unsupported_mime" });
  expect(jobCalls).toEqual([]);
  expect(artifactUpdateCalls.at(-1)?.input.status).toBe("failed");
  expect(deleteCalls).toEqual([input.storageKey]);
});

test("an unscannable type rejected in detect mode records detect, not block", async () => {
  const { deps, scanRunCreateCalls, piiDetailCalls } = buildDeps({
    settings: { enabled: true, mode: "detect" },
    evaluateThrows: new PiiProtectionServiceError("unsupported_mime", "cannot scan image/png files")
  });
  await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput({ contentType: "image/png" }));
  expect(scanRunCreateCalls).toEqual([expect.objectContaining({ mode: "detect" })]);
  expect(piiDetailCalls.at(-1)?.pii).toMatchObject({ status: "failed", modeApplied: "detect" });
});

test.each(["unsupported_mime", "pdf_extraction_failed", "file_too_large"])(
  "block mode deletes the bytes of an upload rejected with %s",
  async (code) => {
    const { deps, deleteCalls } = buildDeps({
      settings: { enabled: true, mode: "block" },
      evaluateThrows: new PiiProtectionServiceError(code, "rejected")
    });
    const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
    expect(result).toMatchObject({ kind: "failed", errorCode: code });
    expect(deleteCalls).toEqual([sampleInput().storageKey]);
  }
);

test("block mode fails closed when the artifact is not found by the reader", async () => {
  const { deps, scanRunUpdateCalls, artifactUpdateCalls } = buildDeps({
    settings: { enabled: true, mode: "block" },
    readerReturnsNull: true
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("failed");
  if (result.kind !== "failed") return;
  expect(result.errorCode).toBe("artifact_not_found");
  expect(artifactUpdateCalls.at(-1)?.input.status).toBe("failed");
  const failed = scanRunUpdateCalls.find((c) => c.patch.status === "failed");
  expect(failed).toBeTruthy();
});

test("async enqueue logs and returns failed when the scan-run insert throws", async () => {
  const { deps, logWarnCalls, piiDetailCalls } = buildDeps({
    settings: { enabled: true, mode: "detect" },
    scanRunCreateThrows: new Error("db is down")
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("failed");
  expect(logWarnCalls.length).toBe(1);
  expect(piiDetailCalls.length).toBe(0);
});

test("a registered import checks its own scope, not uploads", async () => {
  const { deps } = buildDeps({
    settings: {
      enabled: true,
      mode: "block",
      scopes: { chatPrompts: false, uploads: true, partnerImports: false }
    }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(
    sampleInput({ source: "partner_import" })
  );
  expect(result.kind).toBe("skipped");
});

test("a registered import scope that is on scans while uploads are off", async () => {
  const { deps, jobCalls } = buildDeps({
    settings: {
      enabled: true,
      mode: "detect",
      scopes: { chatPrompts: false, uploads: false, partnerImports: true }
    }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(
    sampleInput({ source: "partner_import" })
  );
  expect(result.kind).toBe("queued");
  // The stored job keeps the registered value as its subject kind.
  expect(jobCalls[0]?.payload).toMatchObject({ subjectKind: "partner_import" });
});

test("block mode 'report' decision counts findings and stamps scanned", async () => {
  const { deps, piiDetailCalls, scanRunUpdateCalls } = buildDeps({
    settings: { enabled: true, mode: "block" },
    decision: {
      action: "report",
      providerType: "openai-compatible",
      providerModel: "google/gemini",
      findings: [
        { entityType: "email", value: "a@b", start: 0, end: 3, confidence: "high" },
        { entityType: "phone", value: "555", start: 0, end: 3, confidence: "low" }
      ]
    } as PiiDecision
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("allowed");
  // Stamped 'scanned' with findingsCount=2
  const stamp = piiDetailCalls.at(-1)!.pii as Record<string, unknown>;
  expect(stamp.status).toBe("scanned");
  expect(stamp.findingsCount).toBe(2);
  // Scan run update carries provider info from the report
  const completed = scanRunUpdateCalls.find((c) => c.patch.status === "completed");
  expect(completed).toBeTruthy();
  expect((completed!.patch.providerType as string)).toBe("openai-compatible");
});

test("block mode allow with no provider info: providerType=null on completed run", async () => {
  const { deps, scanRunUpdateCalls } = buildDeps({
    settings: { enabled: true, mode: "block" },
    decision: { action: "allow", reason: "no_findings" } as PiiDecision
  });
  await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  const completed = scanRunUpdateCalls.find((c) => c.patch.status === "completed")!;
  expect(completed.patch.providerType).toBe(null);
});

test("block mode: provider error that's NOT a PiiProtectionServiceError uses generic code", async () => {
  const { deps } = buildDeps({
    settings: { enabled: true, mode: "block" },
    evaluateThrows: new Error("network down")
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("failed");
  if (result.kind === "failed") {
    expect(result.errorCode).toBe("pii_provider_error");
    expect(result.errorMessage).toBe("network down");
  }
});

test("block decision emits pii_blocked audit event with subject metadata", async () => {
  const { deps, auditCalls } = buildDeps({
    settings: { enabled: true, mode: "block" },
    decision: {
      action: "block",
      findings: [],
      providerType: "openai-compatible",
      providerModel: "m",
      blockReason: "email"
    },
    withAuditEvents: true
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("blocked");
  expect(auditCalls.length).toBe(1);
  expect(auditCalls[0].type).toBe("pii_blocked");
  const payload = auditCalls[0].payload as Record<string, unknown>;
  expect(payload.subjectType).toBe("artifact");
  expect(payload.subjectId).toBe("art-1");
  expect(payload.source).toBe("upload");
  expect(payload.blockReason).toBe("email");
});

test("block decision: missing auditEvents store does not block the path", async () => {
  // Default buildDeps does NOT include auditEvents — the enqueuer must still complete.
  const { deps } = buildDeps({
    settings: { enabled: true, mode: "block" },
    decision: {
      action: "block",
      findings: [],
      providerType: "openai-compatible",
      providerModel: "m",
      blockReason: "email"
    }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("blocked");
});

test("allow decision does not emit pii_blocked audit event", async () => {
  const { deps, auditCalls } = buildDeps({
    settings: { enabled: true, mode: "block" },
    decision: { action: "allow", reason: "no_findings" },
    withAuditEvents: true
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("allowed");
  expect(auditCalls.length).toBe(0);
});

// One read routes the upload, makes the decision, and gives the record. An
// admin save between two reads must not give a record that disagrees with the
// decision: here the second read would see detect, so the decision would be
// a report while the record says block.
test("a synchronous scan routes, evaluates, and records from one policy read", async () => {
  const h = buildDeps({ withAuditEvents: true });
  const saves = [
    { stored: { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" }, revision: 4 },
    { stored: { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "detect" }, revision: 5 }
  ];
  const readPiiProtection = vi.fn(async () => saves.shift()!);
  const piiProtection = new PiiProtectionService({
    policyReader: { readPiiProtection },
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000,
    importScopes
  });
  const dirty = {
    async readArtifact({ artifactId }: { artifactId: string }) {
      return { artifactId, contentType: "text/plain", entityTypes: [], readContent: async () => "Contact a@b.co" };
    }
  };

  const result = await new PiiArtifactScanEnqueuer({ ...h.deps, piiProtection, subjectReader: dirty }).enqueue(sampleInput());

  expect(readPiiProtection).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ kind: "blocked", blockReason: "email" });
  expect(h.scanRunCreateCalls).toEqual([expect.objectContaining({ mode: "block", policyRevision: 4 })]);
  expect(h.scanRunUpdateCalls.at(-1)?.patch).toMatchObject({ status: "blocked", actionTaken: "block" });
  expect(h.piiDetailCalls.at(-1)?.pii).toMatchObject({ status: "blocked", modeApplied: "block", policyRevision: 4 });
  expect(h.auditCalls).toEqual([
    expect.objectContaining({ type: "pii_blocked", payload: expect.objectContaining({ mode: "block", policyRevision: 4 }) })
  ]);
});

test("a synchronous allow and a synchronous failure record the revision of the read", async () => {
  const clean = buildDeps({ settings: { enabled: true, mode: "block" } });
  await new PiiArtifactScanEnqueuer(clean.deps).enqueue(sampleInput());
  expect(clean.piiDetailCalls.at(-1)?.pii).toMatchObject({ status: "scanned", modeApplied: "block", policyRevision: 3 });

  const failed = buildDeps({ settings: { enabled: true, mode: "block" }, evaluateThrows: new Error("provider down") });
  await new PiiArtifactScanEnqueuer(failed.deps).enqueue(sampleInput());
  expect(failed.piiDetailCalls.at(-1)?.pii).toMatchObject({ status: "failed", modeApplied: "block", policyRevision: 3 });
});

test("a synchronous scan records the policy that the evaluation applied", async () => {
  const { deps, scanRunUpdateCalls, piiDetailCalls, auditCalls } = buildDeps({
    settings: { enabled: true, mode: "block" },
    decision: { action: "block", findings: [], providerType: "openai-compatible", providerModel: "m", blockReason: "email" },
    withAuditEvents: true
  });
  // The evaluation reports a different applied policy than the routed read.
  // The record must follow the evaluation, which made the decision.
  const evaluate = deps.piiProtection.evaluateArtifactWithPolicy;
  deps.piiProtection.evaluateArtifactWithPolicy = async (input, read) => ({
    ...(await evaluate(input, read)),
    appliedPolicy: { mode: "detect", revision: 8 }
  });

  expect((await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput())).kind).toBe("blocked");
  expect(scanRunUpdateCalls.at(-1)?.patch).toMatchObject({ status: "blocked", mode: "detect" });
  expect(piiDetailCalls.at(-1)?.pii).toMatchObject({ status: "blocked", modeApplied: "detect", policyRevision: 8 });
  expect(auditCalls.find((call) => call.type === "pii_blocked")?.payload).toMatchObject({ mode: "detect", policyRevision: 8 });
});
