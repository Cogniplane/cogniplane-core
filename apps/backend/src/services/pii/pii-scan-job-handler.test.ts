import { test, expect } from "vitest";

import {
  PiiScanJobHandler,
  type PiiScanJobHandlerDeps,
  type PiiScanSubjectReader
} from "./pii-scan-job-handler.js";
import type { ArtifactRecord } from "../artifacts/artifact-store.js";
import type { PiiDecision } from "./pii-protection-service.js";
import { PiiProtectionServiceError } from "./pii-protection-service.js";
import type { PiiScanJobRecord } from "./pii-scan-job-store.js";

type UpdateScanRunCall = { tenantId: string; scanRunId: string; patch: Record<string, unknown> };
type SetMessagePiiCall = { tenantId: string; messageId: string; pii: Record<string, unknown> };
type SetArtifactPiiCall = { tenantId: string; artifactId: string; pii: Record<string, unknown> };

function buildDeps(overrides: {
  decision?: PiiDecision;
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
  let failureReturn: { status: PiiScanJobRecord["status"] } | null = { status: "queued" };
  // Artifact row the handler re-fetches to find the current storage key. Tests
  // override `artifactGet` to model a missing/deleted row or a diverging key.
  let artifactGet: (() => Pick<ArtifactRecord, "storageBackend" | "storageKey" | "status"> | null) =
    () => ({ storageBackend: "local", storageKey: "users/user-1/session-1/art-1.txt", status: "ready" });
  let storageDeleteThrows: Error | null = null;

  const piiProtection: PiiScanJobHandlerDeps["piiProtection"] = {
    async evaluateText() {
      if (overrides.evaluateThrows) throw overrides.evaluateThrows;
      return overrides.decision ?? ({ action: "allow", reason: "disabled" } as PiiDecision);
    },
    async evaluateArtifact() {
      if (overrides.evaluateThrows) throw overrides.evaluateThrows;
      return overrides.decision ?? ({ action: "allow", reason: "disabled" } as PiiDecision);
    }
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
        async update(tenantId: string, scanRunId: string, patch: Record<string, unknown>) {
          updateCalls.push({ tenantId, scanRunId, patch });
          return null;
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

test("PiiScanJobHandler skips audit emission when sourceUserId is null", async () => {
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
  expect(auditCalls.length).toBe(0);
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
