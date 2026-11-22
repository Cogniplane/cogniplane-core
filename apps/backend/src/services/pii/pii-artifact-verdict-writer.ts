import type { ArtifactPiiDetail, ArtifactStore } from "../artifacts/artifact-store.js";
import type { StorageGc, StorageGcOutcome } from "../storage/storage-gc.js";
import type { PiiScanActionTaken, PiiScanRunDecision, PiiScanRunStore, PiiScanStatus } from "./pii-scan-run-store.js";
import type { ImageCoverageDetail } from "./scannable-text.js";

export type PiiArtifactVerdictAuditEvent =
  | "pii_blocked"
  | "pii_transformed"
  | "pii_reported"
  | "pii_block_object_orphaned";

/** The artifact and the scan run that a verdict goes to. */
export type PiiArtifactVerdictTarget = {
  tenantId: string;
  artifactId: string;
  scanRunId: string;
  /**
   * Writes one audit event of this scan. The caller owns the user of the
   * event, and the check for an event that an earlier attempt wrote. It must
   * not throw for a failed audit write.
   */
  emitAudit(eventType: PiiArtifactVerdictAuditEvent, payload: Record<string, unknown>): Promise<void>;
  /** Added to the log payload, for example the job id. */
  logContext?: Record<string, unknown>;
};

export type RejectedObjectCleanup = { objectDeleted: boolean; objectCleanup: StorageGcOutcome | "row_gone" };

type VerdictOutcome = {
  detailStatus: "scanned" | "blocked" | "transformed";
  runStatus: PiiScanStatus;
  auditEvent?: "pii_blocked" | "pii_transformed" | "pii_reported";
};

// A transform records the finding set only: the file is not changed.
const OUTCOMES: Record<PiiScanActionTaken, VerdictOutcome> = {
  allow: { detailStatus: "scanned", runStatus: "completed" },
  report: { detailStatus: "scanned", runStatus: "completed", auditEvent: "pii_reported" },
  block: { detailStatus: "blocked", runStatus: "blocked", auditEvent: "pii_blocked" },
  transform: { detailStatus: "transformed", runStatus: "transformed", auditEvent: "pii_transformed" }
};

/**
 * Applies a recorded decision (`pending_decision`) to an artifact. The
 * synchronous upload scan and the scan job handler both call it, so a decision
 * that the worker finishes ends the same way as one that the request applied:
 * the same PII detail, the same audit payload, the same scan run.
 */
export class PiiArtifactVerdictWriter {
  constructor(
    private readonly deps: {
      artifacts: Pick<ArtifactStore, "setPiiDetail" | "rejectStoredObject">;
      piiScanRuns: Pick<PiiScanRunStore, "update">;
      /** Deletes the object that a rejection queued; a failure stays queued for the worker. */
      storageGc: Pick<StorageGc, "collectArtifactObject">;
      logger?: { error(payload: unknown, message: string): void };
    }
  ) {}

  /**
   * Order: the PII detail, the audit event, then the scan run. The detail
   * write moves a pending upload to `ready`, or to `failed` for a block. The
   * terminal scan run update is last and clears the recorded decision, so a
   * failure before it leaves the decision for the next attempt. Each write
   * can run again.
   */
  async apply(target: PiiArtifactVerdictTarget, decision: PiiScanRunDecision): Promise<void> {
    const { action, mode, policyRevision, findings, providerType, providerModel, source } = decision;
    const outcome = OUTCOMES[action];
    const detail: ArtifactPiiDetail = {
      status: outcome.detailStatus,
      modeApplied: mode,
      policyRevision,
      scanRunId: target.scanRunId,
      ...(decision.blockReason !== undefined ? { blockReason: decision.blockReason } : {}),
      findingsCount: findings.length,
      // What the scan read of a PDF's page images, also on a block.
      ...coverageOf(decision)
    };

    // For a block, the `blocked` verdict and the queued object delete commit
    // together, so no failure after this point loses the key. A resumed block
    // queues and deletes again: a delete of a missing object succeeds.
    let cleanup: RejectedObjectCleanup | undefined;
    if (action === "block") cleanup = await this.rejectStoredObject(target, detail, { source });
    else await this.deps.artifacts.setPiiDetail(target.tenantId, target.artifactId, detail);

    if (outcome.auditEvent) {
      await target.emitAudit(outcome.auditEvent, {
        scanRunId: target.scanRunId,
        mode,
        policyRevision,
        subjectType: "artifact",
        subjectId: target.artifactId,
        ...(source !== undefined ? { source } : {}),
        findingsCount: findings.length,
        providerType,
        providerModel,
        ...(cleanup ? { blockReason: decision.blockReason, ...cleanup } : {})
      });
    }

    // The mode and the settings revision that the evaluation applied. They
    // can differ from the values at enqueue time.
    await this.deps.piiScanRuns.update(target.tenantId, target.scanRunId, {
      status: outcome.runStatus,
      mode,
      policyRevision,
      providerType,
      providerModel,
      findings,
      actionTaken: action,
      pendingDecision: null,
      completedAt: new Date()
    });
  }

  /**
   * Rejects the artifact and gives up its object (a block, or a permanent scan
   * error): `ArtifactStore.rejectStoredObject` writes `pii`, and queues the key
   * that the row holds now (a re-upload or a migration can change it), in one
   * transaction. Then this call tries the delete. The delete keeps an object
   * that a live row of any tenant still references. A failed delete stays
   * queued: the scheduler worker retries it, and the
   * `pii_block_object_orphaned` audit event records the failure. `row_gone`
   * when the row is gone or deleted: nothing to release, and the verdict has
   * no row to go to.
   */
  async rejectStoredObject(
    target: PiiArtifactVerdictTarget,
    pii: ArtifactPiiDetail,
    options: { status?: "failed"; source?: string } = {}
  ): Promise<RejectedObjectCleanup> {
    const released = await this.deps.artifacts.rejectStoredObject(target.tenantId, target.artifactId, {
      pii,
      ...(options.status ? { status: options.status } : {})
    });
    if (!released) return { objectDeleted: false, objectCleanup: "row_gone" };
    const outcome = await this.deps.storageGc.collectArtifactObject({
      queue: "session_storage_gc",
      tenantId: target.tenantId,
      ownerId: released.sessionId,
      storageKey: released.storageKey
    });
    if (outcome === "pending") {
      this.deps.logger?.error(
        { tenantId: target.tenantId, artifactId: target.artifactId, scanRunId: target.scanRunId, ...target.logContext },
        "Failed to delete stored object for PII-rejected artifact; it stays queued for retry"
      );
      await target.emitAudit("pii_block_object_orphaned", {
        scanRunId: target.scanRunId,
        subjectType: "artifact",
        subjectId: target.artifactId,
        storageKey: released.storageKey,
        ...(options.source !== undefined ? { source: options.source } : {}),
        retry: "queued"
      });
    }
    return { objectDeleted: outcome === "deleted", objectCleanup: outcome };
  }
}

// The page-image coverage that a recorded decision states. A decision
// recorded before OCR coverage existed holds only `imagesNotScanned`.
export function coverageOf(decision: PiiScanRunDecision): ImageCoverageDetail {
  return {
    ...(decision.imagesNotScanned ? { imagesNotScanned: true } : {}),
    ...(decision.imageScan !== undefined ? { imageScan: decision.imageScan } : {}),
    ...(decision.imagePagesScanned !== undefined ? { imagePagesScanned: decision.imagePagesScanned } : {}),
    ...(decision.imagePageCount !== undefined ? { imagePageCount: decision.imagePageCount } : {})
  };
}
