import type { Readable } from "node:stream";

import type { FastifyBaseLogger } from "fastify";

import type {
  PiiArtifactScanEnqueuer,
  PiiArtifactScanPlan,
  PiiArtifactScanSource
} from "../pii/pii-artifact-scan-enqueuer.js";
import { SessionUploadAccessError } from "../session-upload-access.js";
import type { SessionStore } from "../session-store.js";
import { assertValidArtifactFilename } from "./artifact-filename.js";
import { buildArtifactStorageKey } from "./artifact-storage-key.js";
import type { ArtifactStorage } from "./artifact-storage.js";
import type { ArtifactDetail, ArtifactRecord, ArtifactStore } from "./artifact-store.js";

// Proof that `begin` checked upload access. Only `begin` makes one, so an
// entry point cannot call `admit` without the check.
export type UploadTicket = {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly expectedProjectId: string | null;
  readonly brand: unique symbol;
};

export type UploadAdmissionResult =
  // The persisted artifact: `pending` while its scan is open, else `ready`.
  | { kind: "admitted"; artifact: ArtifactRecord }
  | { kind: "blocked"; blockReason: string; scanRunId: string }
  | { kind: "scan_failed"; errorCode: string; errorMessage: string };

/**
 * The one path that turns user-supplied bytes into a session artifact. Every
 * entry point (direct upload, overlay import, import tool) must use it, so
 * access checks, file name validation, pending-until-scanned state, and the PII
 * scan stay the same.
 */
export class UploadAdmission {
  constructor(
    private readonly deps: {
      sessions: Pick<SessionStore, "requireUploadAccess">;
      artifacts: Pick<ArtifactStore, "createUpload" | "getReadable">;
      storage: Pick<ArtifactStorage, "put" | "delete">;
      piiScanEnqueuer?: Pick<PiiArtifactScanEnqueuer, "plan" | "enqueue">;
      logger?: Pick<FastifyBaseLogger, "error">;
    }
  ) {}

  /** Check current upload access. Call it before fetching or storing any bytes. */
  async begin({ tenantId, sessionId, userId }: { tenantId: string; sessionId: string; userId: string }): Promise<UploadTicket> {
    const expectedProjectId = await this.deps.sessions.requireUploadAccess(tenantId, sessionId, userId);
    return { tenantId, sessionId, userId, expectedProjectId } as UploadTicket;
  }

  async admit(
    ticket: UploadTicket,
    input: {
      artifactName: string;
      mimeType: string;
      stream: Readable;
      source: PiiArtifactScanSource;
      createdByType?: ArtifactRecord["createdByType"];
      createdByRef?: string | null;
      detail?: ArtifactDetail;
      auditPayload?: Record<string, unknown>;
    }
  ): Promise<UploadAdmissionResult> {
    const { tenantId, sessionId, userId } = ticket;
    // Last line of defence for every entry point: refuse a bad name before any
    // bytes are stored or a row is inserted. Entry points that can answer sooner
    // (the upload route) check earlier. Release the caller's source stream, as
    // nothing will read it.
    try {
      assertValidArtifactFilename(input.artifactName);
    } catch (error) {
      input.stream.destroy();
      throw error;
    }
    const stored = await this.deps.storage.put({
      storageKey: buildArtifactStorageKey({ tenantId, userId, sessionId, artifactName: input.artifactName }),
      stream: input.stream
    });

    let artifact: ArtifactRecord;
    let plan: PiiArtifactScanPlan;
    try {
      // Read the policy after the bytes are stored, before the row exists.
      // An upload that needs no scan is created `ready` in one transaction;
      // any other upload is `pending` until its verdict.
      plan = this.deps.piiScanEnqueuer
        ? await this.deps.piiScanEnqueuer.plan({ tenantId, contentType: input.mimeType, source: input.source })
        : { kind: "skip" };
      // Access is checked again under lock: it can change while bytes stream.
      // The audit event commits with the row, or neither commits.
      artifact = await this.deps.artifacts.createUpload({
        expectedProjectId: ticket.expectedProjectId,
        tenantId,
        sessionId,
        userId,
        artifactName: input.artifactName,
        mimeType: input.mimeType,
        storageBackend: stored.storageBackend,
        storageKey: stored.storageKey,
        fileSizeBytes: stored.fileSizeBytes,
        checksumSha256: stored.checksumSha256,
        createdByType: input.createdByType,
        createdByRef: input.createdByRef ?? null,
        detail: input.detail,
        awaitingScan: plan.kind !== "skip"
      }, (created) => ({
        tenantId,
        sessionId,
        userId,
        type: "artifact_uploaded",
        payload: {
          artifactId: created.artifactId,
          artifactType: created.artifactType,
          artifactName: created.artifactName,
          mimeType: created.mimeType,
          fileSizeBytes: created.fileSizeBytes,
          ...input.auditPayload
        }
      }));
    } catch (error) {
      // Keep the access or audit error if cleanup also fails.
      try {
        await this.deps.storage.delete(stored.storageKey);
      } catch (cleanupError) {
        this.deps.logger?.error(
          { err: cleanupError, tenantId, sessionId, storageKey: stored.storageKey },
          "Failed to delete rejected artifact upload"
        );
      }
      throw error;
    }

    // A crash or a failed write from here on leaves a pending upload; the
    // worker's stalled-upload recovery closes it.
    const scan = this.deps.piiScanEnqueuer && plan.kind !== "skip"
      ? await this.deps.piiScanEnqueuer.enqueue({
          tenantId,
          sessionId,
          userId,
          artifactId: artifact.artifactId,
          contentType: artifact.mimeType,
          storageKey: artifact.storageKey,
          source: input.source
        }, plan)
      : ({ kind: "skipped" } as const);
    if (scan.kind === "blocked") {
      return { kind: "blocked", blockReason: scan.blockReason, scanRunId: scan.scanRunId };
    }
    if (scan.kind === "failed") {
      return { kind: "scan_failed", errorCode: scan.errorCode, errorMessage: scan.errorMessage };
    }

    // Return the persisted state: a queued scan stays pending, an allowed
    // synchronous scan made it ready, and access can change while a
    // synchronous scan runs.
    const current = await this.deps.artifacts.getReadable(tenantId, artifact.artifactId, userId);
    if (!current) throw new SessionUploadAccessError();
    return { kind: "admitted", artifact: current };
  }
}
