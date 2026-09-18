import { canBrowseSessionContent } from "../services/session-access.js";
import { Readable } from "node:stream";
import { z } from "zod";
import { ArtifactListQuerySchema } from "@cogniplane/shared-types";
import { buildArtifactStorageKey } from "../services/artifacts/artifact-storage-key.js";
import { ArtifactCursorError } from "../services/artifacts/artifact-store.js";
import { ProjectAccessError } from "../services/project-access.js";
import { SessionUploadAccessError } from "../services/session-upload-access.js";

import type { FastifyInstance } from "fastify";

import type { AppDependencies } from "../app-dependencies.js";
import type { SessionStore } from "../services/session-store.js";
import type { ArtifactStore } from "../services/artifacts/artifact-store.js";
import type { ArtifactStorage } from "../services/artifacts/artifact-storage.js";
import type { ArtifactProcessor } from "../services/artifacts/artifact-processor.js";
import type { AuditEventStore } from "../services/audit-event-store.js";
import type { PiiArtifactScanEnqueuer } from "../services/pii/pii-artifact-scan-enqueuer.js";
import type { RequestLimitsInterface } from "../services/request-limits.js";
import { ensureUser } from "../lib/db.js";
import { apiError, getErrorMessage, notFoundError, requestError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { artifactIdParams, sessionIdParams } from "../lib/route-schemas.js";
import { ALLOWED_ARTIFACT_MIME_TYPES } from "../lib/allowed-mime-types.js";
import { PERMANENT_PII_ERROR_CODES } from "../services/pii/pii-scan-job-handler.js";

const downloadParamsSchema = z.object({
  token: z.string().trim().min(1)
});

const uploadFieldsSchema = z.object({
  sessionId: z.string().uuid(),
  name: z.string().trim().min(1).max(255).optional()
});


function getUploadFields(
  file: Awaited<ReturnType<import("fastify").FastifyRequest["file"]>>
): Record<string, string | undefined> {
  const fields = file?.fields ?? {};
  const values: Record<string, string | undefined> = {};

  for (const [key, field] of Object.entries(fields)) {
    const value = Array.isArray(field) ? field[0] : field;
    if (value && "value" in value && typeof value.value === "string") {
      values[key] = value.value;
    }
  }

  return values;
}

function contentDispositionFileName(fileName: string): string {
  const sanitized = fileName.replace(/["\\\r\n;]/g, "_");
  const encoded = encodeURIComponent(fileName);
  return `filename="${sanitized}"; filename*=UTF-8''${encoded}`;
}

export function buildArtifactRouteStores(deps: AppDependencies) {
  return {
    sessions: deps.sessions,
    artifacts: deps.artifacts,
    auditEvents: deps.auditEvents,
    storage: deps.artifactStorage,
    processor: deps.artifactProcessor,
    piiScanEnqueuer: deps.piiScanEnqueuer,
    limits: deps.limits
  };
}

export type ArtifactRouteStores = {
  sessions: Pick<SessionStore, "requireUploadAccess" | "getReadable">;
  artifacts: Pick<
    ArtifactStore,
    | "listForUser"
    | "listBySession"
    | "createUpload"
    | "update"
    | "getReadable"
    | "createDownloadToken"
    | "peekDownloadToken"
    | "consumeDownloadToken"
  >;
  auditEvents: Pick<AuditEventStore, "create">;
  storage: Pick<ArtifactStorage, "put" | "openReadStream" | "delete">;
  processor: Pick<ArtifactProcessor, "extractArtifactText">;
  piiScanEnqueuer?: Pick<PiiArtifactScanEnqueuer, "enqueue">;
  limits: Pick<RequestLimitsInterface, "consumeRateLimit">;
};

export async function registerArtifactRoutes(
  app: FastifyInstance,
  stores: ArtifactRouteStores
): Promise<void> {
  // Cross-session artifact browser for the authenticated user. Read-only,
  // no role gate (own artifacts only); user isolation lives in the store's
  // `user_id` predicate. Keyset-paginated via an opaque `cursor`.
  app.get("/artifacts", async (request, reply) => {
    const queryResult = parseRequestInput(reply, ArtifactListQuerySchema, request.query);
    if (!queryResult.ok) {
      return queryResult.response;
    }

    const { userId, tenantId } = request.auth;
    const query = queryResult.value;

    try {
      const { items, nextCursor } = await stores.artifacts.listForUser(tenantId, userId, {
        q: query.q,
        artifactType: query.type,
        status: query.status,
        mimeClass: query.mimeClass,
        sort: query.sort,
        limit: query.limit,
        cursor: query.cursor
      });
      return { items, nextCursor };
    } catch (error) {
      if (error instanceof ArtifactCursorError) {
        reply.code(400);
        return apiError(error.reason, "Invalid pagination cursor for the requested sort/filter.");
      }
      throw error;
    }
  });

  app.get("/sessions/:sessionId/artifacts", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const { userId, tenantId } = request.auth;
    const { sessionId } = paramsResult.value;
    const session = await stores.sessions.getReadable(tenantId, sessionId, userId);
    if (!session || !canBrowseSessionContent(session)) {
      reply.code(404);
      return notFoundError("session_not_found");
    }

    reply.header("cache-control", "private, no-store");
    return {
      session,
      artifacts: (await stores.artifacts.listBySession(tenantId, sessionId, userId)).filter(
        (artifact) => artifact.artifactType !== "derived"
      )
    };
  });

  app.post("/artifacts", {
    errorHandler(error, _request, reply) {
      if (error instanceof ProjectAccessError || error instanceof SessionUploadAccessError)
        return reply.code(error.status).send(apiError(error.code, error.message));
      throw error;
    },
  }, async (request, reply) => {
    const { userId, tenantId } = request.auth;

    // Throttle BEFORE buffering the upload so an abusive client can't burn
    // bandwidth/CPU/storage faster than the limit allows.
    const rateLimitError = await stores.limits.consumeRateLimit({
      resource: "artifact_upload",
      userId,
      tenantId
    });
    if (rateLimitError) {
      reply.code(429);
      reply.header("retry-after", Math.max(1, Math.ceil(rateLimitError.retryAfterMs / 1000)));
      return rateLimitError;
    }

    await ensureUser(app.db, userId);

    if (!request.isMultipart()) {
      reply.code(400);
      return requestError([
        {
          path: "body",
          message: "Expected multipart/form-data payload."
        }
      ]);
    }

    let file;
    try {
      file = await request.file({
        limits: {
          files: 1,
          fileSize: app.config.ARTIFACT_MAX_UPLOAD_BYTES
        }
      });
    } catch (error) {
      reply.code(413);
      return apiError("artifact_too_large", getErrorMessage(error, "Artifact upload rejected."));
    }

    if (!file) {
      reply.code(400);
      return requestError([
        {
          path: "file",
          message: "A file upload is required."
        }
      ]);
    }

    if (!ALLOWED_ARTIFACT_MIME_TYPES.has(file.mimetype)) {
      reply.code(415);
      return apiError("unsupported_media_type", `Unsupported artifact MIME type: ${file.mimetype}`);
    }

    // Buffer now so magic bytes are available for MIME verification before storage.
    // toBuffer() respects the fileSize limit set on request.file() above.
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (error) {
      reply.code(413);
      return apiError("artifact_too_large", getErrorMessage(error, "Artifact upload rejected."));
    }

    const { fileTypeFromBuffer } = await import("file-type");
    const detected = await fileTypeFromBuffer(buffer);
    if (detected && detected.mime !== file.mimetype) {
      reply.code(415);
      return apiError(
        "mime_type_mismatch",
        `File content does not match declared MIME type (detected: ${detected.mime}, declared: ${file.mimetype}).`
      );
    }

    const fieldsResult = parseRequestInput(reply, uploadFieldsSchema, getUploadFields(file));
    if (!fieldsResult.ok) {
      return fieldsResult.response;
    }

    const fields = fieldsResult.value;
    const expectedProjectId = await stores.sessions.requireUploadAccess(tenantId, fields.sessionId, userId);

    const artifactName = fields.name ?? file.filename ?? "upload.bin";
    const stored = await stores.storage.put({
      storageKey: buildArtifactStorageKey({
        userId,
        sessionId: fields.sessionId,
        artifactName
      }),
      stream: Readable.from([buffer])
    });

    let artifact;
    try {
      artifact = await stores.artifacts.createUpload({
        expectedProjectId,
        tenantId,
        sessionId: fields.sessionId,
        userId,
        artifactName,
        mimeType: file.mimetype,
        storageBackend: stored.storageBackend,
        storageKey: stored.storageKey,
        fileSizeBytes: stored.fileSizeBytes,
        checksumSha256: stored.checksumSha256,
        detail: {
          fieldName: file.fieldname,
          encoding: file.encoding
        }
      });
    } catch (error) {
      // Access and lifecycle are rechecked in the insert transaction after I/O.
      // Preserve the actionable request error if object cleanup also fails.
      try {
        await stores.storage.delete(stored.storageKey);
      } catch (cleanupError) {
        request.log.error({ err: cleanupError, tenantId, sessionId: fields.sessionId, storageKey: stored.storageKey },
          "Failed to delete rejected artifact upload");
      }
      throw error;
    }

    await stores.auditEvents.create({
      tenantId,
      sessionId: fields.sessionId,
      userId,
      type: "artifact_uploaded",
      payload: {
        artifactId: artifact.artifactId,
        artifactType: artifact.artifactType,
        artifactName: artifact.artifactName,
        mimeType: artifact.mimeType,
        fileSizeBytes: artifact.fileSizeBytes
      }
    });

    if (stores.piiScanEnqueuer) {
      const scanResult = await stores.piiScanEnqueuer.enqueue({
        tenantId,
        sessionId: fields.sessionId,
        userId,
        artifactId: artifact.artifactId,
        contentType: artifact.mimeType,
        storageKey: artifact.storageKey,
        source: "upload"
      });
      if (scanResult.kind === "blocked") {
        reply.code(422);
        return apiError(
          "pii_block",
          `Upload blocked by organization policy (${scanResult.blockReason}).`
        );
      }
      if (scanResult.kind === "failed") {
        // Permanent client-side errors (oversize, unsupported MIME, missing
        // artifact) should NOT use 503 — that signals a transient provider
        // problem. Use 422 so the client knows retrying won't help.
        const isClientError = PERMANENT_PII_ERROR_CODES.has(scanResult.errorCode);
        reply.code(isClientError ? 422 : 503);
        return apiError(scanResult.errorCode, scanResult.errorMessage);
      }
      if (scanResult.kind === "skipped" || scanResult.kind === "allowed") {
        await stores.artifacts.update(tenantId, artifact.artifactId, { status: "ready" });
      }
    } else {
      await stores.artifacts.update(tenantId, artifact.artifactId, { status: "ready" });
    }

    // Return the persisted PII state, and do not return a stale response if the
    // uploader lost project access while a synchronous scan was running.
    const current = await stores.artifacts.getReadable(tenantId, artifact.artifactId, userId);
    if (!current) return reply.code(404).send(notFoundError("artifact_not_found"));
    reply.code(201);
    reply.header("cache-control", "private, no-store");
    return { artifact: current };
  });

  app.post("/artifacts/:artifactId/download-token", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, artifactIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const { userId, tenantId } = request.auth;
    const artifact = await stores.artifacts.getReadable(tenantId, paramsResult.value.artifactId, userId);
    if (!artifact) {
      reply.code(404);
      return notFoundError("artifact_not_found");
    }

    if (artifact.artifactType !== "upload" && artifact.status !== "ready") {
      reply.code(409);
      return apiError("artifact_not_ready");
    }

    const token = await stores.artifacts.createDownloadToken({
      tenantId,
      artifactId: artifact.artifactId,
      sessionId: artifact.sessionId,
      userId,
      storageBackend: artifact.storageBackend,
      storageKey: artifact.storageKey,
      fileName: artifact.artifactName,
      contentType: artifact.mimeType,
      ttlMs: app.config.ARTIFACT_DOWNLOAD_TTL_MS
    });

    return {
      download: {
        token: token.token,
        url: `/downloads/${token.token}`,
        expiresAt: token.expiresAt
      }
    };
  });

  app.get("/artifacts/:artifactId/preview-text", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    const paramsResult = parseRequestInput(reply, artifactIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const artifact = await stores.artifacts.getReadable(tenantId, paramsResult.value.artifactId, userId);
    if (!artifact) {
      reply.code(404);
      return notFoundError("artifact_not_found");
    }
    if (artifact.mimeType !== "application/pdf") {
      reply.code(422);
      return apiError("not_a_pdf");
    }
    if (artifact.status !== "ready") {
      reply.code(422);
      return apiError("artifact_not_ready");
    }

    const text = await stores.processor.extractArtifactText(artifact);
    if (text === null) {
      reply.code(422);
      return apiError("pdf_extraction_failed");
    }

    const current = await stores.artifacts.getReadable(tenantId, artifact.artifactId, userId);
    if (!current) return reply.code(404).send(notFoundError("artifact_not_found"));
    if (current.status !== "ready") return reply.code(422).send(apiError("artifact_not_ready"));
    reply.header("cache-control", "private, no-store");
    return { text };
  });

  app.get("/downloads/:token", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, downloadParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    // Single-use download, ordered so a transient storage error can't burn
    // the token. SQL checks caller identity and current session access at both
    // steps. The administrative bypass applies only to non-project sessions.
    //
    // 1. `peekDownloadToken` validates without consuming. Unknown token,
    //    cross-tenant, wrong user, already-consumed, or unreadable artifact
    //    all return null → 404.
    // 2. Expiry → 410. The peek does NOT consume, so the 410 is repeatable
    //    and an expired token is never spent.
    // 3. Open the storage stream BEFORE consuming. A failure here propagates
    //    (500) with the token still unconsumed, so the client can retry.
    // 4. `consumeDownloadToken` flips `consumed_at` atomically and only then.
    //    A lost race (concurrent request consumed it first) returns null → 404.
    const callerIsAdmin =
      request.auth.role === "owner" || request.auth.role === "admin";
    const token = await stores.artifacts.peekDownloadToken({
      token: paramsResult.value.token,
      requesterTenantId: request.auth.tenantId,
      requesterUserId: request.auth.userId,
      callerIsAdmin
    });
    if (!token) {
      reply.code(404);
      return notFoundError("download_not_found");
    }

    if (new Date(token.expiresAt).getTime() <= Date.now()) {
      reply.code(410);
      return apiError("download_expired");
    }

    const streamHandle = await stores.storage.openReadStream(token.storageKey);

    const consumed = await stores.artifacts.consumeDownloadToken({
      token: paramsResult.value.token,
      requesterTenantId: request.auth.tenantId,
      requesterUserId: request.auth.userId,
      callerIsAdmin
    });
    if (!consumed) {
      // Lost the single-use race (a concurrent request consumed the token
      // first). We optimistically opened the storage stream before consuming;
      // destroy it so an S3/HTTP-backed body/connection isn't left dangling
      // until timeout under replay or double-click.
      const closable = streamHandle.stream as { destroy?: () => void };
      if (typeof closable.destroy === "function") {
        closable.destroy();
      }
      reply.code(404);
      return notFoundError("download_not_found");
    }

    // Best-effort: the token is already consumed, so failing here would burn
    // the single-use token (retry 404s) just to report a 500. Serve the file.
    try {
      await stores.auditEvents.create({
        tenantId: token.tenantId,
        sessionId: token.sessionId,
        userId: request.auth.userId,
        type: "artifact_downloaded",
        payload: {
          artifactId: token.artifactId,
          fileName: token.fileName,
          actorUserId: request.auth.userId,
          tokenUserId: token.userId
        }
      });
    } catch (err) {
      request.log.warn(
        { err, artifactId: token.artifactId },
        "Failed to record artifact_downloaded audit event"
      );
    }

    reply.header("cache-control", "private, no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("content-type", token.contentType);
    reply.header(
      "content-disposition",
      `attachment; ${contentDispositionFileName(token.fileName)}`
    );
    reply.header("content-length", String(streamHandle.fileSizeBytes));
    return reply.send(streamHandle.stream);
  });
}
