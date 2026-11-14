import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import { piiSubjectForSource, type PiiImportScopeRegistry } from "./pii-import-scopes.js";
import { PII_POLICY_INVALID_CODE, PII_POLICY_INVALID_MESSAGE } from "./pii-policy.js";
import type { PiiFinding } from "./pii-provider.js";
import {
  isScannableContentType,
  PiiProtectionServiceError,
  type PiiPolicyRead,
  type PiiProtectionService,
  type PiiScanArtifactInput
} from "./pii-protection-service.js";
import { coverageOf, PERMANENT_PII_ERROR_CODES, scanRunDecision } from "./pii-scan-job-handler.js";
import { PII_SCAN_INTERRUPTED, type PiiScanJobMode, type PiiScanJobStore } from "./pii-scan-job-store.js";
import type { PiiScanRunDecision, PiiScanRunStore } from "./pii-scan-run-store.js";
import { imageCoverageDetail } from "./scannable-text.js";

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

/**
 * How an upload is scanned, from one policy read. `UploadAdmission` plans
 * before it creates the row, so an upload that needs no scan is created
 * `ready` in one transaction.
 */
export type PiiArtifactScanPlan =
  | { kind: "skip" }
  | { kind: "invalid_policy"; policyRevision: number }
  // The synchronous path runs in block mode and, in every mode, for a type the
  // scan cannot read. The evaluation uses the same read, so the scan run, the
  // detail, and the audit event agree with the decision.
  | { kind: "sync"; mode: PiiScanJobMode; read: PiiPolicyRead }
  // A queued scan applies the policy in force when it runs (PiiScanJobHandler).
  | { kind: "async"; mode: PiiScanJobMode; entityTypes: string[] };

export type PiiArtifactScanPlanInput = Pick<EnqueueArtifactPiiScanInput, "tenantId" | "contentType" | "source">;

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
 * - `block` mode is **synchronous**: the helper evaluates the file in the
 *   request path, records the decision on the scan run, and then applies it.
 *   Provider failures fail closed.
 * - `detect` and `transform` modes are async: one transaction writes the scan
 *   run, the `pending` PII detail and the job, so the scheduler worker can
 *   evaluate later. Transform mode on artifacts behaves like detect (see
 *   `PiiProtectionService.evaluateArtifact`).
 *
 * The worker's stalled-upload recovery (`PiiScanJobStore.recoverStalledUpload`)
 * closes an upload that a crash or a failed write leaves `pending`, and
 * finishes a synchronous decision that was recorded but not applied.
 */
export class PiiArtifactScanEnqueuer {

  constructor(
    private readonly deps: {
      piiProtection: Pick<PiiProtectionService, "readPolicy" | "isSubjectInScope" | "evaluateArtifactWithPolicy">;
      importScopes?: Pick<PiiImportScopeRegistry, "findBySubjectKind">;
      piiScanRuns: Pick<PiiScanRunStore, "create" | "update" | "recordDecision">;
      piiScanJobs: Pick<PiiScanJobStore, "enqueueArtifactScan">;
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
  async plan(input: PiiArtifactScanPlanInput): Promise<PiiArtifactScanPlan> {
    const read = await this.deps.piiProtection.readPolicy(input.tenantId);
    const { policy } = read;
    if (policy.activation === "off") return { kind: "skip" };

    if (input.source !== "upload" && !this.deps.importScopes?.findBySubjectKind(input.source)) {
      // No toggle exists for this source, so the gate scans it.
      this.deps.logger?.warn?.(
        { tenantId: input.tenantId, source: input.source.slice(0, 64) },
        "PII scan source is not registered; it is scanned as in scope"
      );
    }
    if (!this.deps.piiProtection.isSubjectInScope(policy, piiSubjectForSource(input.source))) {
      return { kind: "skip" };
    }
    if (policy.activation === "invalid") return { kind: "invalid_policy", policyRevision: read.revision };

    const mode = policy.settings.mode as PiiScanJobMode;
    // A type the scan cannot read is rejected now in every mode, so the
    // uploader gets the reason at once instead of a later background failure.
    if (mode === "block" || !isScannableContentType(input.contentType)) {
      return { kind: "sync", mode, read };
    }
    return { kind: "async", mode, entityTypes: policy.settings.detectors.entityTypes };
  }

  /** Scans a persisted upload with `plan`, or with a new plan when none is given. */
  async enqueue(input: EnqueueArtifactPiiScanInput, plan?: PiiArtifactScanPlan): Promise<PiiArtifactScanResult> {
    const routed = plan ?? await this.plan(input);
    switch (routed.kind) {
      case "skip": return { kind: "skipped" };
      case "invalid_policy": return this.stopForInvalidPolicy(input, routed.policyRevision);
      case "sync": return this.runSyncBlock({ ...input, mode: routed.mode, read: routed.read });
      case "async": return this.runAsync(input, routed.mode, routed.entityTypes);
    }
  }

  // Not a finding: the artifact fails and keeps its bytes, so an admin can
  // repair the policy without data loss. No provider call and no scan run.
  private async stopForInvalidPolicy(
    input: EnqueueArtifactPiiScanInput,
    policyRevision: number
  ): Promise<PiiArtifactScanResult> {
    // The detail write also fails the pending upload; the status write covers
    // a row without the pending marker.
    await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
      status: "failed",
      summaryText: PII_POLICY_INVALID_CODE
    });
    await this.deps.artifacts.update(input.tenantId, input.artifactId, { status: "failed" });
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

  /**
   * The decision is recorded on the scan run before any of it is applied, as
   * the queued scan does. A failure after that point is not a provider error:
   * the verdict stands, and the stalled-upload recovery finishes it. Without
   * the record, a purge followed by a failed write would read as "not
   * scanned" and lose the block.
   */
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
    const scanRunId = scanRun.scanRunId;

    let decision: PiiScanRunDecision;
    try {
      const subject = await this.deps.subjectReader.readArtifact({
        tenantId: input.tenantId,
        artifactId: input.artifactId
      });

      if (!subject) {
        return this.handleArtifactNotFound(input, scanRunId);
      }

      const evaluation = await this.deps.piiProtection.evaluateArtifactWithPolicy(
        { tenantId: input.tenantId, artifact: subject, subject: piiSubjectForSource(input.source) },
        input.read
      );
      decision = scanRunDecision(evaluation.decision, evaluation.appliedPolicy, imageCoverageDetail(subject.imageCoverage?.()));
    } catch (error) {
      return this.handleProviderError(input, scanRunId, error);
    }

    // A database error here leaves the scan run open with no decision and the
    // upload pending; recovery fails both. Nothing was deleted.
    if (!(await this.deps.piiScanRuns.recordDecision(input.tenantId, scanRunId, decision))) {
      // Recovery closed the scan run first. Its outcome stands.
      return {
        kind: "failed",
        scanRunId,
        errorCode: PII_SCAN_INTERRUPTED,
        errorMessage: "The file scan was interrupted. Upload the file again."
      };
    }

    try {
      if (decision.action === "block") {
        await this.applyBlockDecision(input, scanRunId, decision);
      } else {
        await this.applyAllowDecision(input, scanRunId, decision);
      }
    } catch (error) {
      this.deps.logger?.error?.(
        { err: error, tenantId: input.tenantId, artifactId: input.artifactId, scanRunId },
        "Failed to apply a recorded PII decision; recovery finishes it"
      );
    }
    return decision.action === "block"
      ? { kind: "blocked", scanRunId, blockReason: decision.blockReason ?? "", findings: decision.findings }
      : { kind: "allowed", scanRunId };
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

  // Same order as PiiScanJobHandler.applyDecision, so a decision that
  // recovery finishes ends the same way. The detail write moves the pending
  // upload to `failed`. The terminal scan run update is last and clears the
  // recorded decision.
  private async applyBlockDecision(
    input: SyncScanInput,
    scanRunId: string,
    decision: PiiScanRunDecision
  ): Promise<void> {
    // Purge the stored bytes BEFORE the terminal `blocked` state, so a
    // terminal status never coexists with a silent orphan: if the delete fails
    // we record it (objectDeleted:false + orphan audit).
    const objectDeleted = await this.purgeRejectedObject(input, scanRunId);
    await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
      status: "blocked",
      modeApplied: decision.mode,
      policyRevision: decision.policyRevision,
      scanRunId,
      blockReason: decision.blockReason,
      findingsCount: decision.findings.length,
      ...coverageOf(decision)
    });
    await this.emitAudit(input, "pii_blocked", {
      scanRunId,
      mode: decision.mode,
      policyRevision: decision.policyRevision,
      subjectType: "artifact",
      subjectId: input.artifactId,
      source: input.source,
      findingsCount: decision.findings.length,
      providerType: decision.providerType,
      providerModel: decision.providerModel,
      blockReason: decision.blockReason,
      objectDeleted
    });
    // Record the mode that the evaluation applied. The scan run was created
    // with the routed mode, from the same read.
    await this.deps.piiScanRuns.update(input.tenantId, scanRunId, {
      status: "blocked",
      mode: decision.mode,
      providerType: decision.providerType,
      providerModel: decision.providerModel,
      findings: decision.findings,
      actionTaken: "block",
      pendingDecision: null,
      completedAt: new Date()
    });
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

  private async applyAllowDecision(
    input: SyncScanInput,
    scanRunId: string,
    decision: PiiScanRunDecision
  ): Promise<void> {
    // The detail write moves the pending upload to `ready`.
    await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
      status: "scanned",
      modeApplied: decision.mode,
      policyRevision: decision.policyRevision,
      scanRunId,
      findingsCount: decision.findings.length,
      ...coverageOf(decision)
    });
    await this.deps.piiScanRuns.update(input.tenantId, scanRunId, {
      status: "completed",
      mode: decision.mode,
      providerType: decision.providerType,
      providerModel: decision.providerModel,
      findings: decision.findings,
      actionTaken: "allow",
      pendingDecision: null,
      completedAt: new Date()
    });
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
    try {
      const { scanRunId, jobId } = await this.deps.piiScanJobs.enqueueArtifactScan({
        tenantId: input.tenantId,
        artifactId: input.artifactId,
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
      return { kind: "queued", scanRunId, jobId, mode };
    } catch (error) {
      this.deps.logger?.warn?.(
        { err: error, tenantId: input.tenantId, artifactId: input.artifactId, source: input.source },
        "Failed to enqueue PII scan for artifact"
      );
      await this.closeFailedEnqueue(input, mode);
      return {
        kind: "failed",
        scanRunId: "",
        errorCode: PII_ENQUEUE_FAILED,
        errorMessage: "The file scan could not be queued. Try again later."
      };
    }
  }

  /**
   * The enqueue transaction rolled back, so no scan run or job exists. Mark
   * the artifact and its PII detail failed. The bytes stay, because the
   * content was not scanned. A failed artifact is not eligible for downloads,
   * chat context or workspaces (isArtifactPiiEligible). If this write fails
   * too, the stalled-upload recovery fails the upload later.
   */
  private async closeFailedEnqueue(
    input: EnqueueArtifactPiiScanInput,
    mode: PiiScanJobMode
  ): Promise<void> {
    try {
      await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
        status: "failed",
        modeApplied: mode,
        summaryText: PII_ENQUEUE_FAILED
      });
    } catch (error) {
      this.deps.logger?.error?.(
        { err: error, tenantId: input.tenantId, artifactId: input.artifactId },
        "Failed to close PII scan state after a failed enqueue"
      );
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

  // The detail write also fails the pending upload; the status write covers
  // a row without the pending marker.
  private async markArtifactFailed(
    input: SyncScanInput,
    scanRunId: string,
    errorMessage: string
  ): Promise<void> {
    await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
      status: "failed",
      modeApplied: input.mode,
      policyRevision: input.read.revision,
      scanRunId,
      summaryText: errorMessage
    });
    await this.deps.artifacts.update(input.tenantId, input.artifactId, {
      status: "failed"
    });
  }
}
