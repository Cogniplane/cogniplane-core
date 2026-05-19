import type { FastifyBaseLogger } from "fastify";

import type { ArtifactPiiDetail, ArtifactStore } from "../artifacts/artifact-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { MessagePiiDetail, MessageStore } from "../message-store.js";
import type { PiiDecision, PiiProtectionService, PiiSubject } from "./pii-protection-service.js";
import { PiiProtectionServiceError } from "./pii-protection-service.js";
import type {
  PiiScanArtifactInput
} from "./pii-provider.js";
import type { PiiScanJobRecord, PiiScanJobStore } from "./pii-scan-job-store.js";
import type { PiiScanRunStore } from "./pii-scan-run-store.js";

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

export type PiiScanJobHandlerDeps = {
  piiProtection: PiiProtectionService;
  piiScanRuns: PiiScanRunStore;
  piiScanJobs: PiiScanJobStore;
  messages: MessageStore;
  artifacts: ArtifactStore;
  subjectReader: PiiScanSubjectReader;
  auditEvents?: AuditEventStore;
  logger: FastifyBaseLogger;
};

export class PiiScanJobHandler {
  constructor(private readonly deps: PiiScanJobHandlerDeps) {}

  async execute(job: PiiScanJobRecord): Promise<void> {
    try {
      await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
        status: "processing"
      });

      const subject = resolveSubject(job);
      const decision = await this.evaluate(job, subject);
      await this.applyDecision(job, decision);
      await this.deps.piiScanJobs.markCompleted(job.tenantId, job.jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode =
        error instanceof PiiProtectionServiceError ? error.code : "pii_job_failed";
      const permanent = isPermanentFailure(error, errorCode);

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
      // onto the scan run and subject so callers can see the job gave up.
      if (updated && updated.status === "failed") {
        await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
          status: "failed",
          errorMessage: message,
          completedAt: new Date()
        });
        await this.markSubjectFailed(job);
      }
    }
  }

  private async evaluate(job: PiiScanJobRecord, subject: PiiSubject): Promise<PiiDecision> {
    if (job.subjectType === "message") {
      const text = await this.deps.subjectReader.readMessageText({
        tenantId: job.tenantId,
        messageId: job.subjectId
      });
      if (text === null) {
        throw new Error(`message ${job.subjectId} not found for scan job ${job.jobId}`);
      }
      return this.deps.piiProtection.evaluateText({
        tenantId: job.tenantId,
        text,
        subject
      });
    }

    const artifact = await this.deps.subjectReader.readArtifact({
      tenantId: job.tenantId,
      artifactId: job.subjectId
    });
    if (artifact === null) {
      throw new Error(`artifact ${job.subjectId} not found for scan job ${job.jobId}`);
    }
    return this.deps.piiProtection.evaluateArtifact({
      tenantId: job.tenantId,
      artifact,
      subject
    });
  }

  private async applyDecision(job: PiiScanJobRecord, decision: PiiDecision): Promise<void> {
    const modeApplied = job.mode;

    if (decision.action === "allow") {
      await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
        status: "completed",
        actionTaken: "allow",
        completedAt: new Date()
      });
      await this.writeSubjectDetail(job, { status: "scanned", modeApplied, findingsCount: 0 });
      return;
    }

    if (decision.action === "report") {
      await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
        status: "completed",
        actionTaken: "report",
        findings: decision.findings,
        providerType: decision.providerType,
        providerModel: decision.providerModel,
        completedAt: new Date()
      });
      await this.writeSubjectDetail(job, {
        status: "scanned",
        modeApplied,
        findingsCount: decision.findings.length
      });
      await this.emitAudit(job, "pii_reported", {
        scanRunId: job.scanRunId,
        mode: job.mode,
        subjectType: job.subjectType,
        subjectId: job.subjectId,
        findingsCount: decision.findings.length,
        providerType: decision.providerType,
        providerModel: decision.providerModel
      });
      return;
    }

    if (decision.action === "block") {
      await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
        status: "blocked",
        actionTaken: "block",
        findings: decision.findings,
        providerType: decision.providerType,
        providerModel: decision.providerModel,
        completedAt: new Date()
      });
      await this.writeSubjectDetail(job, {
        status: "blocked",
        modeApplied,
        blockReason: decision.blockReason,
        findingsCount: decision.findings.length
      });
      await this.emitAudit(job, "pii_blocked", {
        scanRunId: job.scanRunId,
        mode: job.mode,
        subjectType: job.subjectType,
        subjectId: job.subjectId,
        findingsCount: decision.findings.length,
        providerType: decision.providerType,
        providerModel: decision.providerModel,
        blockReason: decision.blockReason
      });
      return;
    }

    // transform path — phase 1 records the finding set; the derived
    // transformed-artifact pipeline (Epic 7) handles persisting the
    // transformed content.
    await this.deps.piiScanRuns.update(job.tenantId, job.scanRunId, {
      status: "transformed",
      actionTaken: "transform",
      findings: decision.findings,
      providerType: decision.providerType,
      providerModel: decision.providerModel,
      completedAt: new Date()
    });
    await this.writeSubjectDetail(job, {
      status: "transformed",
      modeApplied,
      findingsCount: decision.findings.length
    });
    await this.emitAudit(job, "pii_transformed", {
      scanRunId: job.scanRunId,
      mode: job.mode,
      subjectType: job.subjectType,
      subjectId: job.subjectId,
      findingsCount: decision.findings.length,
      providerType: decision.providerType,
      providerModel: decision.providerModel
    });
  }

  private async emitAudit(
    job: PiiScanJobRecord,
    eventType: "pii_blocked" | "pii_transformed" | "pii_reported",
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.deps.auditEvents) return;
    if (!job.sourceUserId) return; // audit_events.user_id is NOT NULL
    try {
      await this.deps.auditEvents.create({
        tenantId: job.tenantId,
        sessionId: job.sourceSessionId,
        userId: job.sourceUserId,
        type: eventType,
        payload
      });
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
      modeApplied: PiiScanJobRecord["mode"];
      blockReason?: string;
      findingsCount?: number;
    }
  ): Promise<void> {
    if (job.subjectType === "message") {
      const pii: MessagePiiDetail = {
        status: detail.status,
        modeApplied: detail.modeApplied,
        scanRunId: job.scanRunId
      };
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
    if (detail.findingsCount !== undefined) {
      artifactPii.findingsCount = detail.findingsCount;
    }
    await this.deps.artifacts.setPiiDetail(job.tenantId, job.subjectId, artifactPii);
  }

  private async markSubjectFailed(job: PiiScanJobRecord): Promise<void> {
    try {
      await this.writeSubjectDetail(job, { status: "failed", modeApplied: job.mode });
    } catch (caughtError) {
      this.deps.logger.error(
        { err: caughtError, jobId: job.jobId },
        "Failed to mark subject detail as failed after terminal job failure"
      );
    }
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

function resolveSubject(job: PiiScanJobRecord): PiiSubject {
  const hint = job.payload.subjectKind;
  if (hint === "chat_prompt" || hint === "upload" || hint === "microsoft_import") {
    return { kind: hint };
  }
  return job.subjectType === "artifact" ? { kind: "upload" } : { kind: "chat_prompt" };
}
