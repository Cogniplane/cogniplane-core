import type { Readable } from "node:stream";

import type { FastifyBaseLogger } from "fastify";

import type { AuditEventStore } from "../audit-event-store.js";
import type { PiiArtifactScanEnqueuer, PiiArtifactScanSource } from "../pii/pii-artifact-scan-enqueuer.js";
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
  // The persisted artifact: `pending` while an async scan runs, else `ready`.
  | { kind: "admitted"; artifact: ArtifactRecord }
  | { kind: "blocked"; blockReason: string; scanRunId: string }
  | { kind: "scan_failed"; errorCode: string; errorMessage: string };

/**
 * The one path that turns user-supplied bytes into a session artifact. Every
 * entry point (direct upload, Microsoft import, import tool) must use it, so
 * access checks, file name validation, pending-until-scanned state, and the PII
 * scan stay the same.
 */
export class UploadAdmission {
  constructor(
    private readonly deps: {
      sessions: Pick<SessionStore, "requireUploadAccess">;
      artifacts: Pick<ArtifactStore, "createUpload" | "update" | "getReadable">;
      storage: Pick<ArtifactStorage, "put" | "delete">;
      auditEvents: Pick<AuditEventStore, "create">;
      piiScanEnqueuer?: Pick<PiiArtifactScanEnqueuer, "enqueue">;
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
      storageKey: buildArtifactStorageKey({ userId, sessionId, artifactName: input.artifactName }),
      stream: input.stream
    });

    let artifact: ArtifactRecord;
    try {
      // Access is checked again under lock: it can change while bytes stream.
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
        detail: input.detail
      });
    } catch (error) {
      // Keep the access error if cleanup also fails.
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

    await this.deps.auditEvents.create({
      tenantId,
      sessionId,
      userId,
      type: "artifact_uploaded",
      payload: {
        artifactId: artifact.artifactId,
        artifactType: artifact.artifactType,
        artifactName: artifact.artifactName,
        mimeType: artifact.mimeType,
        fileSizeBytes: artifact.fileSizeBytes,
        ...input.auditPayload
      }
    });

    const scan = this.deps.piiScanEnqueuer
      ? await this.deps.piiScanEnqueuer.enqueue({
          tenantId,
          sessionId,
          userId,
          artifactId: artifact.artifactId,
          contentType: artifact.mimeType,
          storageKey: artifact.storageKey,
          source: input.source
        })
      : ({ kind: "skipped" } as const);
    if (scan.kind === "blocked") {
      return { kind: "blocked", blockReason: scan.blockReason, scanRunId: scan.scanRunId };
    }
    if (scan.kind === "failed") {
      return { kind: "scan_failed", errorCode: scan.errorCode, errorMessage: scan.errorMessage };
    }
    if (scan.kind === "skipped" || scan.kind === "allowed") {
      await this.deps.artifacts.update(tenantId, artifact.artifactId, { status: "ready" });
    }

    // Return the persisted state: a queued scan stays pending, and access can
    // change while a synchronous scan runs.
    const current = await this.deps.artifacts.getReadable(tenantId, artifact.artifactId, userId);
    if (!current) throw new SessionUploadAccessError();
    return { kind: "admitted", artifact: current };
  }
}
