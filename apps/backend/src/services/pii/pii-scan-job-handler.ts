import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type {
  ArtifactPiiDetail,
  ArtifactRecord,
  ArtifactStore
} from "../artifacts/artifact-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { MessagePiiDetail, MessageStore } from "../message-store.js";
import type { PiiImportScopeRegistry } from "./pii-import-scopes.js";
import type {
  PiiAppliedPolicy,
  PiiDecision,
  PiiProtectionService,
  PiiSubject
} from "./pii-protection-service.js";
import { PII_POLICY_INVALID_CODE } from "./pii-policy.js";
import { PiiProtectionServiceError } from "./pii-protection-service.js";
import type {
  PiiScanArtifactInput
} from "./pii-provider.js";
import type { PiiScanJobRecord } from "./pii-scan-job-store.js";
import type { PiiScanMode, PiiScanRunDecision, PiiScanRunStore } from "./pii-scan-run-store.js";

/**
 * Reads the raw content of a scan subject so the handler can pass text/binary
 * into `PiiProtectionService`. Abstracted so tests don't need real storage.
 */
export interface PiiScanSubjectReader {
  readMessageText(input: {
    tenantId: string;
    messageId: string;
  }): Promise<string | null>;
  readArtifact(input: {
    tenantId: string;
    artifactId: string;
  }): Promise<PiiScanArtifactInput | null>;
}

type PiiScanJobLogger = {
  error(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
};

type PiiScanJobStoreCapability = {
  markCompleted(tenantId: string, jobId: string): Promise<void>;
  recordFailure(
    tenantId: string,
    jobId: string,
    error: string,
    options?: { backoffMs?: number; permanent?: boolean }
  ): Promise<{ status: PiiScanJobRecord["status"] } | null>;
};

type ArtifactPiiStoreCapability = {
  get(
    tenantId: string,
    artifactId: string
  ): Promise<Pick<ArtifactRecord, "storageKey" | "status"> | null>;
  setPiiDetail: ArtifactStore["setPiiDetail"];
};

export type PiiScanJobHandlerDeps = {
  piiProtection: Pick<PiiProtectionService, "evaluateTextWithPolicy" | "evaluateArtifactWithPolicy">;
  piiScanRuns: Pick<PiiScanRunStore, "update" | "recordDecision" | "getPendingDecision" | "finishUndecidedFailure">;
  piiScanJobs: PiiScanJobStoreCapability;
  messages: Pick<MessageStore, "setPiiDetail">;
  artifacts: ArtifactPiiStoreCapability;
  /** Deletes stored object bytes on a block so they don't persist. */
  storage: Pick<ArtifactStorage, "delete">;
  subjectReader: PiiScanSubjectReader;
  // `createSystemEvent` records an event for a job with no source user.
  auditEvents?: Pick<AuditEventStore, "create" | "hasPiiScanRunEvent"> &
    Partial<Pick<AuditEventStore, "createSystemEvent">>;
  logger: PiiScanJobLogger;
  importScopes?: Pick<PiiImportScopeRegistry, "findBySubjectKind">;
};

export class PiiScanJobHandler {
  constructor(private readonly deps: PiiScanJobHandlerDeps) {}

  /**
   * The job records its decision on the scan run before it applies it. An
   * attempt that stops after that point does not decide again: the next
   * attempt, or the failed-job recovery, finishes the recorded decision. A
   * block can already have deleted the bytes, and a newer policy must not
   * then record the file as scanned.
   */
  async execute(job: PiiScanJobRecord): Promise<void> {
    let decisionApplied = false;
    try {
      let next = await this.recordedDecision(job);
      if (!next) {
        if (
          job.subjectType === "artifact" &&
          (await this.deps.artifacts.get(job.tenantId, job.subjectId))?.status === "deleted"
        ) {
          await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
            status: "completed",
            summaryText: "File removed before scanning.",
            completedAt: new Date()
          });
          decisionApplied = true;
          await this.deps.piiScanJobs.markCompleted(job.tenantId, job.jobId);
          return;
        }
        // A completed attempt can have cleared its decision before this
        // attempt reads it. Do not reopen that run or read its deleted bytes.
        const started = await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
          status: "processing"
        });
        if (!started) return;

        const decision = await this.decide(job, this.resolveSubject(job));
        // Another attempt of this job can decide first, for example after
        // its claim expired while it ran. The first recorded decision wins.
        next = (await this.deps.piiScanRuns.recordDecision(job.tenantId, job.scanRunId, decision))
          ? { decision, resumed: false }
          : await this.recordedDecision(job);
        if (!next) {
          // The scan run closed while this attempt evaluated: another attempt
          // finished it and acknowledges the job.
          this.deps.logger.warn(
            { jobId: job.jobId, tenantId: job.tenantId },
            "PII scan run closed before this attempt applied its decision"
          );
          return;
        }
      }
      await this.applyDecision(job, next.decision, next.resumed);
      decisionApplied = true;
      await this.deps.piiScanJobs.markCompleted(job.tenantId, job.jobId);
    } catch (error) {
      if (decisionApplied) {
        // Leave the applied decision intact. The worker's stale-job recovery
        // handles an unfinished acknowledgement after a database outage.
        this.deps.logger.error({ err: error, jobId: job.jobId }, "Failed to acknowledge completed PII scan");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const errorCode =
        error instanceof PiiProtectionServiceError ? error.code : "pii_job_failed";
      const permanent = isPermanentFailure(error, errorCode);
      if (errorCode === PII_POLICY_INVALID_CODE) {
        // Not a finding: the job stays retryable and keeps the subject. The
        // audit event is the record that a configuration error stopped it,
        // with the settings revision that the evaluation read.
        const policyRevision = error instanceof PiiProtectionServiceError ? error.policyRevision : undefined;
        await this.emitAudit(job, "pii_policy_invalid", {
          jobId: job.jobId,
          scanRunId: job.scanRunId,
          subjectType: job.subjectType,
          subjectId: job.subjectId,
          ...(policyRevision !== undefined ? { policyRevision } : {})
        });
      }

      this.deps.logger.error(
        { err: error, jobId: job.jobId, tenantId: job.tenantId, permanent },
        "PiiScanJobHandler execution failed"
      );

      const updated = await this.deps.piiScanJobs.recordFailure(
        job.tenantId,
        job.jobId,
        `${errorCode}: ${message}`,
        { permanent }
      );

      // On terminal failure (permanent OR no attempts left), mirror the state
      // onto the subject and scan run so callers can see the job gave up. A
      // write that fails here is retried by the worker's failed-job recovery.
      if (updated && updated.status === "failed") {
        await this.finishFailedJob({ ...job, errorMessage: message }).catch((caughtError: unknown) => {
          this.deps.logger.error(
            { err: caughtError, jobId: job.jobId },
            "Failed to close the subject and scan run after terminal job failure"
          );
        });
      }
    }
  }

  /**
   * Close the scan run and subject of a job that failed without its handler,
   * for example by the stale-claim sweep. The subject is written first: if
   * that write fails, the scan run stays open and the next sweep tries again.
   * A job that recorded a decision finishes it instead (see `execute`).
   */
  async finishFailedJob(job: PiiScanJobRecord): Promise<void> {
    const decision = await this.deps.piiScanRuns.finishUndecidedFailure(
      job.tenantId,
      job.scanRunId,
      job.errorMessage ?? "PII scan job failed",
      () => this.writeSubjectDetail(job, { status: "failed", modeApplied: job.mode })
    );
    if (decision) await this.applyDecision(job, decision, true);
  }

  // A job without a hint predates stored subject kinds: its subject type
  // decides. A hint that no import source registered (for example, a job that
  // a build with an overlay queued) keeps its identity and is scanned as in
  // scope; the service still honors a tenant-wide Off.
  private resolveSubject(job: PiiScanJobRecord): PiiSubject {
    const hint: unknown = job.payload.subjectKind;
    if (hint === undefined || hint === null) {
      return job.subjectType === "artifact" ? { kind: "upload" } : { kind: "chat_prompt" };
    }
    if (hint === "chat_prompt" || hint === "upload") return { kind: hint };
    if (typeof hint !== "string" || !this.deps.importScopes?.findBySubjectKind(hint)) {
      this.deps.logger.warn(
        {
          jobId: job.jobId,
          tenantId: job.tenantId,
          subjectKind: typeof hint === "string" ? hint.slice(0, 64) : typeof hint
        },
        "PII scan job has an unregistered subject kind; it is scanned as in scope"
      );
    }
    return { kind: "import", subjectKind: String(hint) };
  }

  private async recordedDecision(
    job: PiiScanJobRecord
  ): Promise<{ decision: PiiScanRunDecision; resumed: boolean } | null> {
    const decision = await this.deps.piiScanRuns.getPendingDecision(job.tenantId, job.scanRunId);
    return decision ? { decision, resumed: true } : null;
  }

  // The decision and the policy that it applied, as the scan run records them.
  private async decide(job: PiiScanJobRecord, subject: PiiSubject): Promise<PiiScanRunDecision> {
    const { decision, appliedPolicy, imagesNotScanned } = await this.evaluate(job, subject);
    const scanned = decision.action === "allow"
      ? { findings: [], providerType: null, providerModel: null }
      : { findings: decision.findings, providerType: decision.providerType, providerModel: decision.providerModel };
    return {
      action: decision.action,
      mode: appliedPolicy.mode,
      policyRevision: appliedPolicy.revision,
      ...scanned,
      ...(decision.action === "block" ? { blockReason: decision.blockReason } : {}),
      // A scan that applied mode off read nothing, so no coverage applies.
      ...(imagesNotScanned && appliedPolicy.mode !== "off" ? { imagesNotScanned: true } : {})
    };
  }

  // The job applies the policy in force now, not the policy at enqueue time.
  // `appliedPolicy` comes from the same settings read as the decision.
  private async evaluate(
    job: PiiScanJobRecord,
    subject: PiiSubject
  ): Promise<{ decision: PiiDecision; appliedPolicy: PiiAppliedPolicy; imagesNotScanned: boolean }> {
    if (job.subjectType === "message") {
      const text = await this.deps.subjectReader.readMessageText({
        tenantId: job.tenantId,
        messageId: job.subjectId
      });
      if (text === null) {
        throw new Error(`message ${job.subjectId} not found for scan job ${job.jobId}`);
      }
      const evaluation = await this.deps.piiProtection.evaluateTextWithPolicy({
        tenantId: job.tenantId,
        text,
        subject
      });
      return { ...evaluation, imagesNotScanned: false };
    }

    const artifact = await this.deps.subjectReader.readArtifact({
      tenantId: job.tenantId,
      artifactId: job.subjectId
    });
    if (artifact === null) {
      throw new Error(`artifact ${job.subjectId} not found for scan job ${job.jobId}`);
    }
    const evaluation = await this.deps.piiProtection.evaluateArtifactWithPolicy({
      tenantId: job.tenantId,
      artifact,
      subject
    });
    return { ...evaluation, imagesNotScanned: artifact.imagesNotScanned?.() ?? false };
  }

  /**
   * Records the mode and the settings revision that the evaluation applied:
   * on the subject detail, on the scan run, and in the audit event. They can
   * differ from `job.mode`, which keeps the mode at enqueue time. Each write
   * can run again: when `resumed`, an earlier attempt applied part of this
   * decision, so each audit event is written only if it does not exist. The
   * terminal scan run update is last and clears the recorded decision.
   */
  private async applyDecision(
    job: PiiScanJobRecord,
    decision: PiiScanRunDecision,
    resumed: boolean
  ): Promise<void> {
    const { action, mode, policyRevision, findings, providerType, providerModel } = decision;
    // The subject detail names the mode `modeApplied`; the scan run and the
    // audit payload name it `mode`.
    const policy = { modeApplied: mode, policyRevision };
    const recorded = { mode, policyRevision };
    // A clean or redacted verdict on a PDF covers only its text.
    const coverage = decision.imagesNotScanned ? { imagesNotScanned: true } : {};
    const auditOptions = { once: resumed };

    if (action === "allow") {
      await this.writeSubjectDetail(job, { status: "scanned", ...policy, findingsCount: 0, ...coverage });
      await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
        status: "completed",
        ...recorded,
        actionTaken: "allow",
        pendingDecision: null,
        completedAt: new Date()
      });
      return;
    }

    if (action === "report") {
      await this.writeSubjectDetail(job, {
        status: "scanned",
        ...policy,
        findingsCount: findings.length,
        ...coverage
      });
      await this.emitAudit(job, "pii_reported", {
        scanRunId: job.scanRunId,
        ...recorded,
        subjectType: job.subjectType,
        subjectId: job.subjectId,
        findingsCount: findings.length,
        providerType,
        providerModel
      }, auditOptions);
      await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
        status: "completed", ...recorded, actionTaken: "report", findings,
        providerType, providerModel, pendingDecision: null,
        completedAt: new Date()
      });
      return;
    }

    if (action === "block") {
      // Purge stored bytes BEFORE the terminal status flip (same ordering as the
      // sync enqueuer) so a `blocked` row never coexists with a silent orphan.
      // Artifacts only — messages have no stored object. A resumed block
      // deletes again: a delete of a missing object succeeds.
      const objectDeleted = await this.purgeBlockedObject(job, auditOptions);

      await this.writeSubjectDetail(job, {
        status: "blocked",
        ...policy,
        blockReason: decision.blockReason,
        findingsCount: findings.length
      });
      await this.emitAudit(job, "pii_blocked", {
        scanRunId: job.scanRunId,
        ...recorded,
        subjectType: job.subjectType,
        subjectId: job.subjectId,
        findingsCount: findings.length,
        providerType,
        providerModel,
        blockReason: decision.blockReason,
        objectDeleted
      }, auditOptions);
      await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
        status: "blocked", ...recorded, actionTaken: "block", findings,
        providerType, providerModel, pendingDecision: null,
        completedAt: new Date()
      });
      return;
    }

    // transform path — phase 1 records the finding set; the derived
    // transformed-artifact pipeline (Epic 7) handles persisting the
    // transformed content.
    await this.writeSubjectDetail(job, {
      status: "transformed",
      ...policy,
      findingsCount: findings.length,
      ...coverage
    });
    await this.emitAudit(job, "pii_transformed", {
      scanRunId: job.scanRunId,
      ...recorded,
      subjectType: job.subjectType,
      subjectId: job.subjectId,
      findingsCount: findings.length,
      providerType,
      providerModel
    }, auditOptions);
    await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
      status: "transformed", ...recorded, actionTaken: "transform", findings,
      providerType, providerModel, pendingDecision: null,
      completedAt: new Date()
    });
  }

  /**
   * Best-effort delete of an artifact's stored bytes on a block. Re-fetches the
   * CURRENT backend + key via ArtifactStore.get rather than trusting the job's
   * frozen payload: a re-upload/migration could have changed the key or backend,
   * and a missing/already-deleted row means there's nothing to purge (idempotent
   * re-run). Returns undefined for messages (no object) or when the row is gone,
   * true on delete, false on a delete failure (escalated to a queryable audit).
   */
  private async purgeBlockedObject(
    job: PiiScanJobRecord,
    auditOptions: { once: boolean }
  ): Promise<boolean | undefined> {
    if (job.subjectType !== "artifact") return undefined;

    const artifact = await this.deps.artifacts.get(job.tenantId, job.subjectId);
    if (!artifact || artifact.status === "deleted") return undefined;

    try {
      await this.deps.storage.delete(artifact.storageKey);
      return true;
    } catch (error) {
      this.deps.logger.error(
        { err: error, tenantId: job.tenantId, artifactId: job.subjectId, jobId: job.jobId },
        "Failed to delete stored object for PII-blocked artifact"
      );
      await this.emitAudit(job, "pii_block_object_orphaned", {
        scanRunId: job.scanRunId,
        subjectType: "artifact",
        subjectId: job.subjectId,
        storageKey: artifact.storageKey
      }, auditOptions);
      return false;
    }
  }

  private async emitAudit(
    job: PiiScanJobRecord,
    eventType:
      | "pii_blocked"
      | "pii_transformed"
      | "pii_reported"
      | "pii_block_object_orphaned"
      | "pii_policy_invalid",
    payload: Record<string, unknown>,
    options: { once?: boolean } = {}
  ): Promise<void> {
    const auditEvents = this.deps.auditEvents;
    if (!auditEvents) return;
    // `once`: an earlier attempt can have written this event. The event is
    // not written again. A failed read stops the attempt, and the next
    // attempt reads again.
    if (
      options.once &&
      (await auditEvents.hasPiiScanRunEvent(job.tenantId, eventType, job.scanRunId, new Date(job.createdAt)))
    ) {
      return;
    }
    try {
      const event = { tenantId: job.tenantId, sessionId: job.sourceSessionId, type: eventType, payload };
      if (job.sourceUserId) {
        await auditEvents.create({ ...event, userId: job.sourceUserId });
      } else if (auditEvents.createSystemEvent) {
        // A job with no source user records a system event
        // (`audit_events.user_id` is nullable).
        await auditEvents.createSystemEvent(event);
      } else {
        this.deps.logger.warn({ jobId: job.jobId, eventType }, "PII audit event skipped: no system audit writer");
      }
    } catch (error) {
      // Audit emission must never break a job. Log and continue.
      this.deps.logger.warn(
        { err: error, jobId: job.jobId, eventType },
        "Failed to emit PII audit event from scan job handler"
      );
    }
  }

  private async writeSubjectDetail(
    job: PiiScanJobRecord,
    detail: {
      status: "scanned" | "blocked" | "transformed" | "failed";
      modeApplied: PiiScanMode;
      policyRevision?: number;
      blockReason?: string;
      findingsCount?: number;
      imagesNotScanned?: boolean;
    }
  ): Promise<void> {
    if (job.subjectType === "message") {
      const pii: MessagePiiDetail = {
        status: detail.status,
        modeApplied: detail.modeApplied,
        scanRunId: job.scanRunId
      };
      if (detail.policyRevision !== undefined) pii.policyRevision = detail.policyRevision;
      if (detail.blockReason !== undefined) pii.blockReason = detail.blockReason;
      if (detail.status === "transformed") pii.transformed = true;
      await this.deps.messages.setPiiDetail(job.tenantId, job.subjectId, pii);
      return;
    }

    const artifactPii: ArtifactPiiDetail = {
      status: detail.status,
      modeApplied: detail.modeApplied,
      scanRunId: job.scanRunId
    };
    if (detail.policyRevision !== undefined) artifactPii.policyRevision = detail.policyRevision;
    if (detail.findingsCount !== undefined) {
      artifactPii.findingsCount = detail.findingsCount;
    }
    if (detail.imagesNotScanned) artifactPii.imagesNotScanned = true;
    await this.deps.artifacts.setPiiDetail(job.tenantId, job.subjectId, artifactPii);
  }
}

// Errors that won't recover with a retry should terminate the job immediately
// instead of burning the full attempt budget. Anything else (provider 5xx,
// network blips, unknown thrown errors) stays transient.
//
// Exported so route handlers can pick the right HTTP status for these codes
// (4xx client error) versus transient codes (503 service unavailable).
export const PERMANENT_PII_ERROR_CODES = new Set([
  "artifact_not_found",
  "pii_decode_failed",
  "unsupported_mime",
  "pdf_extraction_failed",
  "file_too_large"
]);

function isPermanentFailure(error: unknown, errorCode: string): boolean {
  if (PERMANENT_PII_ERROR_CODES.has(errorCode)) return true;
  // The handler's evaluate() throws plain Error(`...not found for scan job...`)
  // when the subject reader returns null. That's a permanent failure: the row
  // is gone, retrying won't bring it back.
  if (error instanceof Error && /not found for scan job/.test(error.message)) {
    return true;
  }
  return false;
}
