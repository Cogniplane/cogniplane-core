import type { FastifyBaseLogger } from "fastify";

import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { AuditEventStore } from "../audit-event-store.js";
import type { PiiFinding } from "./pii-provider.js";
import {
  PiiProtectionServiceError,
  type PiiProtectionService,
  type PiiScanArtifactInput
} from "./pii-protection-service.js";
import type { PiiScanJobMode, PiiScanJobStore } from "./pii-scan-job-store.js";
import type { PiiScanRunStore } from "./pii-scan-run-store.js";

export type PiiArtifactScanSource = "upload" | "microsoft_import";

export interface EnqueueArtifactPiiScanInput {
  tenantId: string;
  sessionId: string;
  userId: string;
  artifactId: string;
  contentType: string;
  storageKey: string;
  source: PiiArtifactScanSource;
}

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

/**
 * Runs after an artifact has been persisted. Enforces the tenant's PII policy
 * for uploads and Microsoft imports:
 *
 * - `block` mode is **synchronous**: the helper calls `evaluateArtifact` in the
 *   request path and, on a block decision, marks the artifact `failed` +
 *   stamps a `blocked` PII detail. Callers should surface an error to the
 *   user. Provider failures fail-closed the same way.
 * - `detect` and `transform` modes are async — the helper stamps a `pending`
 *   PII detail and enqueues a job so the scheduler worker can evaluate later.
 *   (Artifact transform is deferred to Epic 7; in phase 1 transform mode on
 *   artifacts behaves like detect per `PiiProtectionService.evaluateArtifact`.)
 *
 * The async pending stamp is written **before** the job is enqueued so the
 * scheduler worker cannot overwrite a completed status with our later update.
 */
export class PiiArtifactScanEnqueuer {
  constructor(
    private readonly deps: {
      piiProtection: PiiProtectionService;
      piiScanRuns: PiiScanRunStore;
      piiScanJobs: PiiScanJobStore;
      artifacts: ArtifactStore;
      subjectReader: PiiArtifactSubjectReader;
      auditEvents?: AuditEventStore;
      logger?: Pick<FastifyBaseLogger, "warn" | "error">;
    }
  ) {}

  async enqueue(input: EnqueueArtifactPiiScanInput): Promise<PiiArtifactScanResult> {
    const settings = await this.deps.piiProtection.getActiveSettings(input.tenantId);
    if (!settings.enabled || settings.mode === "off") return { kind: "skipped" };

    const scopeEnabled =
      input.source === "upload" ? settings.scopes.uploads : settings.scopes.microsoftImports;
    if (!scopeEnabled) return { kind: "skipped" };

    const mode = settings.mode as PiiScanJobMode;

    if (mode === "block") {
      return this.runSyncBlock(input);
    }

    return this.runAsync(input, mode);
  }

  private async runSyncBlock(
    input: EnqueueArtifactPiiScanInput
  ): Promise<PiiArtifactScanResult> {
    const scanRun = await this.deps.piiScanRuns.create({
      tenantId: input.tenantId,
      subjectType: "artifact",
      subjectId: input.artifactId,
      sourceSessionId: input.sessionId,
      sourceUserId: input.userId,
      mode: "block",
      status: "processing"
    });

    const subject = await this.deps.subjectReader.readArtifact({
      tenantId: input.tenantId,
      artifactId: input.artifactId
    });

    if (!subject) {
      return this.handleArtifactNotFound(input, scanRun.scanRunId);
    }

    try {
      const decision = await this.deps.piiProtection.evaluateArtifact({
        tenantId: input.tenantId,
        artifact: subject,
        subject: {
          kind: input.source === "upload" ? "upload" : "microsoft_import"
        }
      });

      return decision.action === "block"
        ? await this.handleBlockDecision(input, scanRun.scanRunId, decision)
        : await this.handleAllowDecision(input, scanRun.scanRunId, decision);
    } catch (error) {
      return this.handleProviderError(input, scanRun.scanRunId, error);
    }
  }

  private async handleArtifactNotFound(
    input: EnqueueArtifactPiiScanInput,
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
    input: EnqueueArtifactPiiScanInput,
    scanRunId: string,
    decision: Extract<
      Awaited<ReturnType<PiiProtectionService["evaluateArtifact"]>>,
      { action: "block" }
    >
  ): Promise<PiiArtifactScanResult> {
    await this.deps.piiScanRuns.update(input.tenantId, scanRunId, {
      status: "blocked",
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
      modeApplied: "block",
      scanRunId,
      blockReason: decision.blockReason,
      findingsCount: decision.findings.length
    });
    await this.emitAudit(input, "pii_blocked", {
      scanRunId,
      mode: "block",
      subjectType: "artifact",
      subjectId: input.artifactId,
      source: input.source,
      findingsCount: decision.findings.length,
      providerType: decision.providerType,
      providerModel: decision.providerModel,
      blockReason: decision.blockReason
    });
    return {
      kind: "blocked",
      scanRunId,
      blockReason: decision.blockReason,
      findings: decision.findings
    };
  }

  private async handleAllowDecision(
    input: EnqueueArtifactPiiScanInput,
    scanRunId: string,
    decision: Exclude<
      Awaited<ReturnType<PiiProtectionService["evaluateArtifact"]>>,
      { action: "block" }
    >
  ): Promise<PiiArtifactScanResult> {
    const findingsCount =
      decision.action === "report" ? decision.findings.length : 0;
    await this.deps.piiScanRuns.update(input.tenantId, scanRunId, {
      status: "completed",
      providerType: decision.action === "report" ? decision.providerType : null,
      providerModel: decision.action === "report" ? decision.providerModel : null,
      findings: decision.action === "report" ? decision.findings : [],
      actionTaken: "allow",
      completedAt: new Date()
    });
    await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
      status: "scanned",
      modeApplied: "block",
      scanRunId,
      findingsCount
    });
    return { kind: "allowed", scanRunId };
  }

  private async handleProviderError(
    input: EnqueueArtifactPiiScanInput,
    scanRunId: string,
    error: unknown
  ): Promise<PiiArtifactScanResult> {
    const errorCode =
      error instanceof PiiProtectionServiceError ? error.code : "pii_provider_error";
    const errorMessage = error instanceof Error ? error.message : String(error);
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
    mode: PiiScanJobMode
  ): Promise<PiiArtifactScanResult> {
    const settings = await this.deps.piiProtection.getActiveSettings(input.tenantId);

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
          entityTypes: settings.detectors.entityTypes
        }
      });

      return { kind: "queued", scanRunId: scanRun.scanRunId, jobId: job.jobId, mode };
    } catch (error) {
      this.deps.logger?.warn?.(
        {
          err: error,
          tenantId: input.tenantId,
          artifactId: input.artifactId,
          source: input.source
        },
        "Failed to enqueue PII scan for artifact"
      );
      return {
        kind: "failed",
        scanRunId: "",
        errorCode: "pii_enqueue_failed",
        errorMessage: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async emitAudit(
    input: EnqueueArtifactPiiScanInput,
    eventType: "pii_blocked" | "pii_transformed" | "pii_reported",
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
    input: EnqueueArtifactPiiScanInput,
    scanRunId: string,
    errorMessage: string
  ): Promise<void> {
    await this.deps.artifacts.update(input.tenantId, input.artifactId, {
      status: "failed"
    });
    await this.deps.artifacts.setPiiDetail(input.tenantId, input.artifactId, {
      status: "failed",
      modeApplied: "block",
      scanRunId,
      summaryText: errorMessage
    });
  }
}
