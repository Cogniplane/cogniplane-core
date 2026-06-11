import { extname } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { ArtifactListQuerySchema } from "@cogniplane/shared-types";
import { uuidv7 } from "../lib/uuid.js";
import { ArtifactCursorError } from "../services/artifacts/artifact-store.js";

import type { FastifyInstance } from "fastify";

import type { AppDependencies } from "../app-dependencies.js";
import { ensureUser } from "../lib/db.js";
import { apiError, getErrorMessage, notFoundError, requestError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { artifactIdParams, messageIdParams, sessionIdParams } from "../lib/route-schemas.js";
import { ALLOWED_ARTIFACT_MIME_TYPES } from "../lib/allowed-mime-types.js";
import { PERMANENT_PII_ERROR_CODES } from "../services/pii/pii-scan-job-handler.js";

const downloadParamsSchema = z.object({
  token: z.string().trim().min(1)
});

const uploadFieldsSchema = z.object({
  sessionId: z.string().uuid(),
  name: z.string().trim().min(1).max(255).optional()
});

const createMessageArtifactSchema = z.object({
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

function buildStorageKey(input: {
  userId: string;
  sessionId: string;
  artifactName: string;
}): string {
  const extension = extname(input.artifactName).slice(0, 32);
  const safeExtension = extension.replace(/[^a-zA-Z0-9._-]/g, "");
  return `${input.userId}/${input.sessionId}/${uuidv7()}${safeExtension}`;
}

function contentDispositionFileName(fileName: string): string {
  const sanitized = fileName.replace(/["\\\r\n;]/g, "_");
  const encoded = encodeURIComponent(fileName);
  return `filename="${sanitized}"; filename*=UTF-8''${encoded}`;
}

export function buildArtifactRouteStores(deps: AppDependencies) {
  return {
    sessions: deps.sessions,
    messages: deps.messages,
    artifacts: deps.artifacts,
    auditEvents: deps.auditEvents,
    storage: deps.artifactStorage,
    processor: deps.artifactProcessor,
    piiScanEnqueuer: deps.piiScanEnqueuer,
    limits: deps.limits
  };
}

export type ArtifactRouteStores = ReturnType<typeof buildArtifactRouteStores>;

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
    const session = await stores.sessions.getOwned(tenantId, sessionId, userId);
    if (!session || session.status !== "active") {
      reply.code(404);
      return notFoundError("session_not_found");
    }

    return {
      session,
      artifacts: (await stores.artifacts.listBySession(tenantId, sessionId, userId)).filter(
        (artifact) => artifact.artifactType !== "derived"
      )
    };
  });

  app.post("/artifacts", async (request, reply) => {
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
    const session = await stores.sessions.getOwned(tenantId, fields.sessionId, userId);
    if (!session || session.status !== "active") {
      reply.code(404);
      return notFoundError("session_not_found");
    }

    const artifactName = fields.name ?? file.filename ?? "upload.bin";
    const stored = await stores.storage.put({
      storageKey: buildStorageKey({
        userId,
        sessionId: fields.sessionId,
        artifactName
      }),
      stream: Readable.from([buffer])
    });

    const artifact = await stores.artifacts.create({
      tenantId,
      artifactType: "upload",
      sessionId: fields.sessionId,
      userId,
      artifactName,
      mimeType: file.mimetype,
      storageBackend: stored.storageBackend,
      storageKey: stored.storageKey,
      fileSizeBytes: stored.fileSizeBytes,
      checksumSha256: stored.checksumSha256,
      status: "ready",
      createdByType: "user",
      detail: {
        fieldName: file.fieldname,
        encoding: file.encoding
      }
    });

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
    }

    reply.code(201);
    return { artifact };
  });

  app.post("/messages/:messageId/artifact", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, messageIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const bodyResult = parseRequestInput(reply, createMessageArtifactSchema, request.body ?? {});
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { userId, tenantId } = request.auth;

    const rateLimitError = await stores.limits.consumeRateLimit({
      resource: "artifact_create",
      userId,
      tenantId
    });
    if (rateLimitError) {
      reply.code(429);
      reply.header("retry-after", Math.max(1, Math.ceil(rateLimitError.retryAfterMs / 1000)));
      return rateLimitError;
    }

    const message = await stores.messages.getOwned(tenantId, paramsResult.value.messageId, userId);
    if (!message) {
      reply.code(404);
      return notFoundError("message_not_found");
    }

    const session = await stores.sessions.getOwned(tenantId, message.sessionId, userId);
    if (!session || session.status !== "active") {
      reply.code(404);
      return notFoundError("session_not_found");
    }

    const name =
      bodyResult.value.name ??
      `${message.role === "assistant" ? "assistant" : "message"}-${message.messageId}.md`;
    const stored = await stores.storage.put({
      storageKey: buildStorageKey({
        userId,
        sessionId: message.sessionId,
        artifactName: name
      }),
      stream: Readable.from([message.content])
    });

    const artifact = await stores.artifacts.create({
      tenantId,
      artifactType: "generated",
      sessionId: message.sessionId,
      userId,
      artifactName: name,
      mimeType: "text/markdown",
      storageBackend: stored.storageBackend,
      storageKey: stored.storageKey,
      fileSizeBytes: stored.fileSizeBytes,
      checksumSha256: stored.checksumSha256,
      status: "ready",
      createdByType: "system",
      createdByRef: message.messageId,
      detail: {
        sourceRole: message.role,
        sourceMessageId: message.messageId
      }
    });

    await stores.auditEvents.create({
      tenantId,
      sessionId: message.sessionId,
      userId,
      type: "artifact_generated",
      payload: {
        artifactId: artifact.artifactId,
        sourceMessageId: message.messageId,
        artifactName: artifact.artifactName
      }
    });

    reply.code(201);
    return { artifact };
  });

  app.post("/artifacts/:artifactId/download-token", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, artifactIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const { userId, tenantId } = request.auth;
    const artifact = await stores.artifacts.getOwned(tenantId, paramsResult.value.artifactId, userId);
    if (!artifact || artifact.status === "deleted") {
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

    const artifact = await stores.artifacts.getOwned(tenantId, paramsResult.value.artifactId, userId);
    if (!artifact || artifact.status === "deleted") {
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

    return { text };
  });

  app.get("/downloads/:token", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, downloadParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    // Single-use download, ordered so a transient storage error can't burn
    // the token. Caller identity (tenant + user, with admin bypass) is matched
    // in SQL on every step so an unauthorized request never observes or
    // consumes a peer's token.
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
        userId: token.userId,
        type: "artifact_downloaded",
        payload: {
          artifactId: token.artifactId,
          fileName: token.fileName
        }
      });
    } catch (err) {
      request.log.warn(
        { err, artifactId: token.artifactId },
        "Failed to record artifact_downloaded audit event"
      );
    }

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
