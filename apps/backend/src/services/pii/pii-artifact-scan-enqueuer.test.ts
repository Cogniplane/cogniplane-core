import { test, expect } from "vitest";

import {
  PiiArtifactScanEnqueuer,
  type EnqueueArtifactPiiScanInput,
  type PiiArtifactSubjectReader
} from "./pii-artifact-scan-enqueuer.js";
import { DEFAULT_PII_PROTECTION, type PiiProtectionSettings } from "./pii-policy.js";
import { PiiProtectionServiceError, type PiiDecision } from "./pii-protection-service.js";

function buildDeps(overrides: {
  settings?: Partial<PiiProtectionSettings>;
  decision?: PiiDecision;
  evaluateThrows?: Error;
  readerReturnsNull?: boolean;
  scanRunCreateThrows?: Error;
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
  let scanRunCounter = 0;

  const reader: PiiArtifactSubjectReader = {
    async readArtifact({ tenantId, artifactId }) {
      if (overrides.readerReturnsNull) return null;
      return {
        artifactId,
        contentType: "text/plain",
        entityTypes: [],
        async readContent() {
          return `content for ${tenantId}/${artifactId}`;
        }
      };
    }
  };

  const deps = {
    piiProtection: {
      async getActiveSettings() {
        return settings;
      },
      async evaluateArtifact() {
        if (overrides.evaluateThrows) throw overrides.evaluateThrows;
        return overrides.decision ?? ({ action: "allow", reason: "no_findings" } as PiiDecision);
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
    subjectReader: reader,
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
    auditCalls
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

test("enqueue returns skipped when PII protection is disabled", async () => {
  const { deps, scanRunCreateCalls } = buildDeps({
    settings: { enabled: false, mode: "detect" }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result).toEqual({ kind: "skipped" });
  expect(scanRunCreateCalls.length).toBe(0);
});

test("enqueue returns skipped when mode is off", async () => {
  const { deps, scanRunCreateCalls } = buildDeps({
    settings: { enabled: true, mode: "off" }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result).toEqual({ kind: "skipped" });
  expect(scanRunCreateCalls.length).toBe(0);
});

test("enqueue returns skipped when the upload scope is disabled", async () => {
  const { deps, scanRunCreateCalls } = buildDeps({
    settings: {
      enabled: true,
      mode: "detect",
      scopes: { chatPrompts: true, uploads: false, microsoftImports: true }
    }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput({ source: "upload" }));
  expect(result).toEqual({ kind: "skipped" });
  expect(scanRunCreateCalls.length).toBe(0);
});

test("detect mode stamps pending BEFORE the job is enqueued", async () => {
  const { deps, jobCalls, piiDetailCalls, artifactUpdateCalls } = buildDeps({
    settings: { enabled: true, mode: "detect" }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(sampleInput());
  expect(result.kind).toBe("queued");

  // Pending stamp must happen before job creation so the scheduler worker
  // can't complete the job between the two writes and get clobbered.
  expect(piiDetailCalls.length).toBe(1);
  expect(piiDetailCalls[0].pii.status).toBe("pending");
  expect(jobCalls.length).toBe(1);
  expect(artifactUpdateCalls.length).toBe(0);
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

test("block mode on a dirty artifact marks it failed and returns blocked", async () => {
  const { deps, scanRunUpdateCalls, piiDetailCalls, artifactUpdateCalls, jobCalls } = buildDeps({
    settings: { enabled: true, mode: "block" },
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
});

test("block mode fails closed when the provider throws", async () => {
  const { deps, scanRunUpdateCalls, artifactUpdateCalls, piiDetailCalls } = buildDeps({
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
});

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

test("microsoft_import scope is checked, not uploads", async () => {
  const { deps } = buildDeps({
    settings: {
      enabled: true,
      mode: "block",
      scopes: { uploads: false, microsoftImports: false }
    }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(
    sampleInput({ source: "microsoft_import" })
  );
  expect(result.kind).toBe("skipped");
});

test("microsoft_import scope enabled but uploads disabled still allows microsoft", async () => {
  const { deps } = buildDeps({
    settings: {
      enabled: true,
      mode: "block",
      scopes: { uploads: false, microsoftImports: true }
    }
  });
  const result = await new PiiArtifactScanEnqueuer(deps).enqueue(
    sampleInput({ source: "microsoft_import" })
  );
  expect(result.kind).toBe("allowed");
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
