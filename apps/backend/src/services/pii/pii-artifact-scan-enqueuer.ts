import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import { piiSubjectForSource, type PiiImportScopeRegistry } from "./pii-import-scopes.js";
import { PII_POLICY_INVALID_CODE, PII_POLICY_INVALID_MESSAGE } from "./pii-policy.js";
import type { PiiFinding } from "./pii-provider.js";
import {
  isScannableContentType,
  PiiProtectionServiceError,
  type PiiDecision,
  type PiiAppliedPolicy,
  type PiiPolicyRead,
  type PiiProtectionService,
  type PiiScanArtifactInput
} from "./pii-protection-service.js";
import { PERMANENT_PII_ERROR_CODES } from "./pii-scan-job-handler.js";
import type { PiiScanJobMode, PiiScanJobStore } from "./pii-scan-job-store.js";
import type { PiiScanRunStore } from "./pii-scan-run-store.js";
import { imageCoverageDetail, type ImageCoverageDetail } from "./scannable-text.js";

const PII_ENQUEUE_FAILED = "pii_enqueue_failed";

// "upload" for a direct upload, or the subject kind of a registered import
// source (see pii-import-scopes.ts). Stored as the job `subjectKind` and the
// audit `source`.
export type PiiArtifactScanSource = "upload" | (string & {});

export interface EnqueueArtifactPiiScanInput {
  tenantId: string;
  sessionId: string;
  userId: string;
  artifactId: string;
  contentType: string;
  storageKey: string;
  source: PiiArtifactScanSource;
}

// The synchronous path runs in block mode and, in every mode, for a type the
// scan cannot read. `mode` and `read` come from the one policy read that
// routed the upload. The evaluation uses the same read, so the scan run, the
// detail, and the audit event agree with the decision.
type SyncScanInput = EnqueueArtifactPiiScanInput & { mode: PiiScanJobMode; read: PiiPolicyRead };

export type PiiArtifactScanResult =
  | { kind: "skipped" }
  | { kind: "queued"; scanRunId: string; jobId: string; mode: PiiScanJobMode }
  | {
      kind: "blocked";
      scanRunId: string;
      blockReason: string;
      findings: PiiFinding[];
    }
  | { kind: "allowed"; scanRunId: string }
  | { kind: "failed"; scanRunId: string; errorCode: string; errorMessage: string };

export interface PiiArtifactSubjectReader {
  readArtifact(input: {
    tenantId: string;
    artifactId: string;
  }): Promise<PiiScanArtifactInput | null>;
}

type PiiArtifactScanLogger = {
  warn(payload: unknown, message: string): void;
  error(payload: unknown, message: string): void;
};

/**
 * Runs after an artifact has been persisted. Enforces the tenant's PII policy
 * for uploads and registered imports:
 *
 * - `block` mode is **synchronous**: the helper calls `evaluateArtifactWithPolicy`
 *   in the request path and, on a block decision, marks the artifact `failed` +
 *   stamps a `blocked` PII detail. Callers should surface an error to the
 *   user. Provider failures fail-closed the same way.
 * - `detect` and `transform` modes are async — the helper stamps a `pending`
 *   PII detail and enqueues a job so the scheduler worker can evaluate later.
 *   Transform mode on artifacts behaves like detect (see
 *   `PiiProtectionService.evaluateArtifact`).
 *
 * The async pending stamp is written **before** the job is enqueued so the
 * scheduler worker cannot overwrite a completed status with our later update.
 * If the job cannot be enqueued, no worker can finish the scan, so the
 * artifact, its PII detail and the scan run are marked failed.
 */
export class PiiArtifactScanEnqueuer {

  constructor(
    private readonly deps: {
      piiProtection: Pick<PiiProtectionService, "readPolicy" | "isSubjectInScope" | "evaluateArtifactWithPolicy">;
      importScopes?: Pick<PiiImportScopeRegistry, "findBySubjectKind">;
      piiScanRuns: Pick<PiiScanRunStore, "create" | "update">;
      piiScanJobs: Pick<PiiScanJobStore, "create">;
      artifacts: Pick<ArtifactStore, "setPiiDetail" | "update">;
      /** Deletes the stored object bytes on a block so they don't persist. */
      storage: Pick<ArtifactStorage, "delete">;
      subjectReader: PiiArtifactSubjectReader;
      auditEvents?: Pick<AuditEventStore, "create">;
      logger?: PiiArtifactScanLogger;
    }
  ) {}

  // One policy read routes the upload. The synchronous scan evaluates and
  // records with the same read. A queued scan applies the policy in force
  // when it runs (see PiiScanJobHandler).
  async enqueue(input: EnqueueArtifactPiiScanInput): Promise<PiiArtifactScanResult> {
    const read = await this.deps.piiProtection.readPolicy(input.tenantId);
    const { policy } = read;
    if (policy.activation === "off") return { kind: "skipped" };

    if (input.source !== "upload" && !this.deps.importScopes?.findBySubjectKind(input.source)) {
      // No toggle exists for this source, so the gate scans it.
      this.deps.logger?.warn?.(
        { tenantId: input.tenantId, artifactId: input.artifactId, source: input.source.slice(0, 64) },
        "PII scan source is not registered; it is scanned as in scope"
      );
    }
    if (!this.deps.piiProtection.isSubjectInScope(policy, piiSubjectForSource(input.source))) {
      return { kind: "skipped" };
    }
    if (policy.activation === "invalid") return this.stopForInvalidPolicy(input, read.revision);

    const mode = policy.settings.mode as PiiScanJobMode;

    // A type the scan cannot read is rejected now in every mode, so the
    // uploader gets the reason at once instead of a later background failure.
    if (mode === "block" || !isScannableContentType(input.contentType)) {
      return this.runSyncBlock({ ...input, mode, read });
    }

    return this.runAsync(input, mode, policy.settings.detectors.entityTypes);
  }

  // Not a finding: the artifact fails and keeps its bytes, so an admin can
  // repair the policy without data loss. No provider call and no scan run.
  private async stopForInvalidPolicy(
    input: EnqueueArtifactPiiScanInput,
    policyRevision: number
  ): Promise<PiiArtifactScanResult> {
    await this.deps.artifacts.update(input.tenantId, input.artifactId, { status: "failed" });
    await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
      status: "failed",
      summaryText: PII_POLICY_INVALID_CODE
    });
    await this.emitAudit(input, "pii_policy_invalid", {
      subjectType: "artifact",
      subjectId: input.artifactId,
      source: input.source,
      policyRevision
    });
    return {
      kind: "failed",
      scanRunId: "",
      errorCode: PII_POLICY_INVALID_CODE,
      errorMessage: PII_POLICY_INVALID_MESSAGE
    };
  }

  private async runSyncBlock(
    input: SyncScanInput
  ): Promise<PiiArtifactScanResult> {
    const scanRun = await this.deps.piiScanRuns.create({
      tenantId: input.tenantId,
      subjectType: "artifact",
      subjectId: input.artifactId,
      sourceSessionId: input.sessionId,
      sourceUserId: input.userId,
      mode: input.mode,
      policyRevision: input.read.revision,
      status: "processing"
    });

    try {
      const subject = await this.deps.subjectReader.readArtifact({
        tenantId: input.tenantId,
        artifactId: input.artifactId
      });

      if (!subject) {
        return this.handleArtifactNotFound(input, scanRun.scanRunId);
      }

      const { decision, appliedPolicy } = await this.deps.piiProtection.evaluateArtifactWithPolicy(
        { tenantId: input.tenantId, artifact: subject, subject: piiSubjectForSource(input.source) },
        input.read
      );

      // A scan that applied mode off read nothing, so no coverage applies.
      const coverage = appliedPolicy.mode === "off" ? {} : imageCoverageDetail(subject.imageCoverage?.());
      return decision.action === "block"
        ? await this.handleBlockDecision(input, scanRun.scanRunId, decision, appliedPolicy, coverage)
        : await this.handleAllowDecision(input, scanRun.scanRunId, decision, appliedPolicy, coverage);
    } catch (error) {
      return this.handleProviderError(input, scanRun.scanRunId, error);
    }
  }

  private async handleArtifactNotFound(
    input: SyncScanInput,
    scanRunId: string
  ): Promise<PiiArtifactScanResult> {
    await this.markArtifactFailed(input, scanRunId, "artifact_not_found");
    await this.deps.piiScanRuns.update(input.tenantId, scanRunId, {
      status: "failed",
      errorMessage: "artifact_not_found",
      completedAt: new Date()
    });
    return {
      kind: "failed",
      scanRunId,
      errorCode: "artifact_not_found",
      errorMessage: "artifact_not_found"
    };
  }

  private async handleBlockDecision(
    input: SyncScanInput,
    scanRunId: string,
    decision: Extract<PiiDecision, { action: "block" }>,
    applied: PiiAppliedPolicy,
    coverage: ImageCoverageDetail
  ): Promise<PiiArtifactScanResult> {
    // Purge the stored bytes BEFORE flipping to a terminal `blocked` state, so
    // a terminal status never coexists with a silent orphan: if the delete
    // fails we record it (objectDeleted:false + orphan audit) and the row's
    // status is the honest signal that cleanup is incomplete.
    const objectDeleted = await this.purgeRejectedObject(input, scanRunId);

    // Record the mode that the evaluation applied. The scan run was created
    // with the routed mode, from the same read.
    await this.deps.piiScanRuns.update(input.tenantId, scanRunId, {
      status: "blocked",
      mode: applied.mode,
      providerType: decision.providerType,
      providerModel: decision.providerModel,
      findings: decision.findings,
      actionTaken: "block",
      completedAt: new Date()
    });
    await this.deps.artifacts.update(input.tenantId, input.artifactId, {
      status: "failed"
    });
    await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
      status: "blocked",
      modeApplied: applied.mode,
      policyRevision: applied.revision,
      scanRunId,
      blockReason: decision.blockReason,
      findingsCount: decision.findings.length,
      ...coverage
    });
    await this.emitAudit(input, "pii_blocked", {
      scanRunId,
      mode: applied.mode,
      policyRevision: applied.revision,
      subjectType: "artifact",
      subjectId: input.artifactId,
      source: input.source,
      findingsCount: decision.findings.length,
      providerType: decision.providerType,
      providerModel: decision.providerModel,
      blockReason: decision.blockReason,
      objectDeleted
    });
    return {
      kind: "blocked",
      scanRunId,
      blockReason: decision.blockReason,
      findings: decision.findings
    };
  }

  /**
   * Best-effort delete of the stored object of a rejected upload (a block or a
   * failed synchronous scan). Returns whether the bytes were purged. Never
   * throws — the rejection must stand even if cleanup fails; a failure is
   * escalated to a queryable audit event (`pii_block_object_orphaned`) so the
   * residual orphan is discoverable.
   */
  private async purgeRejectedObject(
    input: EnqueueArtifactPiiScanInput,
    scanRunId: string
  ): Promise<boolean> {
    try {
      await this.deps.storage.delete(input.storageKey);
      return true;
    } catch (error) {
      this.deps.logger?.error?.(
        { err: error, tenantId: input.tenantId, artifactId: input.artifactId, scanRunId },
        "Failed to delete stored object for PII-rejected artifact"
      );
      await this.emitAudit(input, "pii_block_object_orphaned", {
        scanRunId,
        subjectType: "artifact",
        subjectId: input.artifactId,
        storageKey: input.storageKey,
        source: input.source
      });
      return false;
    }
  }

  private async handleAllowDecision(
    input: SyncScanInput,
    scanRunId: string,
    decision: Exclude<PiiDecision, { action: "block" }>,
    applied: PiiAppliedPolicy,
    coverage: ImageCoverageDetail
  ): Promise<PiiArtifactScanResult> {
    const findingsCount =
      decision.action === "report" ? decision.findings.length : 0;
    await this.deps.piiScanRuns.update(input.tenantId, scanRunId, {
      status: "completed",
      mode: applied.mode,
      providerType: decision.action === "report" ? decision.providerType : null,
      providerModel: decision.action === "report" ? decision.providerModel : null,
      findings: decision.action === "report" ? decision.findings : [],
      actionTaken: "allow",
      completedAt: new Date()
    });
    await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
      status: "scanned",
      modeApplied: applied.mode,
      policyRevision: applied.revision,
      scanRunId,
      findingsCount,
      ...coverage
    });
    return { kind: "allowed", scanRunId };
  }

  private async handleProviderError(
    input: SyncScanInput,
    scanRunId: string,
    error: unknown
  ): Promise<PiiArtifactScanResult> {
    const errorCode =
      error instanceof PiiProtectionServiceError ? error.code : "pii_provider_error";
    const errorMessage = error instanceof Error ? error.message : String(error);
    // A permanent rejection (an unscannable type, an unreadable PDF, an
    // oversized file) leaves bytes nobody can use, so they go. A provider
    // error is not a verdict: the content was never scanned, so keep it.
    if (PERMANENT_PII_ERROR_CODES.has(errorCode)) await this.purgeRejectedObject(input, scanRunId);
    await this.deps.piiScanRuns.update(input.tenantId, scanRunId, {
      status: "failed",
      errorMessage,
      completedAt: new Date()
    });
    await this.markArtifactFailed(input, scanRunId, errorMessage);
    return { kind: "failed", scanRunId, errorCode, errorMessage };
  }

  private async runAsync(
    input: EnqueueArtifactPiiScanInput,
    mode: PiiScanJobMode,
    entityTypes: string[]
  ): Promise<PiiArtifactScanResult> {
    let scanRunId: string | null = null;
    try {
      const scanRun = await this.deps.piiScanRuns.create({
        tenantId: input.tenantId,
        subjectType: "artifact",
        subjectId: input.artifactId,
        sourceSessionId: input.sessionId,
        sourceUserId: input.userId,
        mode,
        status: "pending"
      });
      scanRunId = scanRun.scanRunId;

      // Stamp pending BEFORE creating the job so the scheduler worker cannot
      // complete and then have this setPiiDetail() overwrite the final status.
      await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
        status: "pending",
        modeApplied: mode,
        scanRunId: scanRun.scanRunId
      });

      const job = await this.deps.piiScanJobs.create({
        tenantId: input.tenantId,
        scanRunId: scanRun.scanRunId,
        subjectType: "artifact",
        subjectId: input.artifactId,
        sourceSessionId: input.sessionId,
        sourceUserId: input.userId,
        mode,
        payload: {
          subjectKind: input.source,
          contentType: input.contentType,
          storageKey: input.storageKey,
          entityTypes
        }
      });

      return { kind: "queued", scanRunId: scanRun.scanRunId, jobId: job.jobId, mode };
    } catch (error) {
      this.deps.logger?.warn?.(
        {
          err: error,
          tenantId: input.tenantId,
          artifactId: input.artifactId,
          scanRunId,
          source: input.source
        },
        "Failed to enqueue PII scan for artifact"
      );
      await this.closeFailedEnqueue(input, mode, scanRunId);
      return {
        kind: "failed",
        scanRunId: scanRunId ?? "",
        errorCode: PII_ENQUEUE_FAILED,
        errorMessage: "The file scan could not be queued. Try again later."
      };
    }
  }

  /**
   * No job exists to finish the scan, so the worker cannot close the pending
   * state. Mark the artifact, its PII detail and the scan run (if created)
   * failed. The bytes stay, because the content was not scanned. A failed
   * artifact is not eligible for downloads, chat context or workspaces
   * (isArtifactPiiEligible). Each write runs even if an earlier one fails;
   * a failed write is logged.
   */
  private async closeFailedEnqueue(
    input: EnqueueArtifactPiiScanInput,
    mode: PiiScanJobMode,
    scanRunId: string | null
  ): Promise<void> {
    const writes: Array<[string, () => Promise<unknown>]> = [
      ["artifact_status", () => this.deps.artifacts.update(input.tenantId, input.artifactId, { status: "failed" })],
      ["artifact_pii_detail", () => this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
        status: "failed",
        modeApplied: mode,
        ...(scanRunId ? { scanRunId } : {}),
        summaryText: PII_ENQUEUE_FAILED
      })]
    ];
    if (scanRunId) {
      writes.push(["scan_run", () => this.deps.piiScanRuns.update(input.tenantId, scanRunId, {
        status: "failed",
        errorMessage: PII_ENQUEUE_FAILED,
        completedAt: new Date()
      })]);
    }
    for (const [write, run] of writes) {
      try {
        await run();
      } catch (error) {
        this.deps.logger?.error?.(
          { err: error, tenantId: input.tenantId, artifactId: input.artifactId, scanRunId, write },
          "Failed to close PII scan state after a failed enqueue"
        );
      }
    }
  }

  private async emitAudit(
    input: EnqueueArtifactPiiScanInput,
    eventType: "pii_blocked" | "pii_transformed" | "pii_reported" | "pii_block_object_orphaned" | "pii_policy_invalid",
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.deps.auditEvents) return;
    try {
      await this.deps.auditEvents.create({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        userId: input.userId,
        type: eventType,
        payload
      });
    } catch (error) {
      // Audit emission must never break the PII flow. Log and move on.
      this.deps.logger?.warn?.(
        { err: error, tenantId: input.tenantId, artifactId: input.artifactId, eventType },
        "Failed to emit PII audit event"
      );
    }
  }

  private async markArtifactFailed(
    input: SyncScanInput,
    scanRunId: string,
    errorMessage: string
  ): Promise<void> {
    await this.deps.artifacts.update(input.tenantId, input.artifactId, {
      status: "failed"
    });
    await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
      status: "failed",
      modeApplied: input.mode,
      policyRevision: input.read.revision,
      scanRunId,
      summaryText: errorMessage
    });
  }
}
