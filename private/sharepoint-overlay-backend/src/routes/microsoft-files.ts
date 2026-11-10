import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { ArtifactEnvelopeSchema } from "@cogniplane/shared-types";

import type { AttachOverlaysInput } from "../../../../apps/backend/src/overlay-contracts.js";
import { apiError } from "../../../../apps/backend/src/lib/http-errors.js";
import type { RequestLimitsInterface } from "../../../../apps/backend/src/services/request-limits.js";
import { parseRequestInput } from "../../../../apps/backend/src/lib/route-validation.js";
import { sessionIdParams } from "../../../../apps/backend/src/lib/route-schemas.js";
import { serialize } from "../../../../apps/backend/src/lib/serialize-response.js";
import {
  MicrosoftFilesListResponseSchema,
  MicrosoftFilesSearchResponseSchema,
  MicrosoftSitesListResponseSchema
} from "../../../sharepoint-overlay-contracts/src/index.js";
import {
  MicrosoftConnectionRequiredError,
  MicrosoftFilesService,
  MicrosoftGraphRequestError,
  MicrosoftImportBlockedError,
  MicrosoftImportPiiScanError,
  MicrosoftImportTooLargeError,
  MicrosoftUnsupportedImportError
} from "../services/microsoft-files-service.js";
import { MicrosoftInvalidIdError } from "../services/graph-id-validation.js";
import { PERMANENT_PII_ERROR_CODES } from "../../../../apps/backend/src/services/pii/pii-scan-job-handler.js";
import { ProjectAccessError } from "../../../../apps/backend/src/services/project-access.js";
import { SessionUploadAccessError } from "../../../../apps/backend/src/services/session-upload-access.js";

const microsoftSitesQuerySchema = z.object({
  search: z.string().trim().max(120).optional()
});

const microsoftFilesQuerySchema = z.object({
  siteId: z.string().trim().min(1).optional(),
  driveId: z.string().trim().min(1).optional(),
  folderId: z.string().trim().min(1).optional()
});

const microsoftSearchQuerySchema = z.object({
  q: z.string().trim().min(1),
  maxResults: z.coerce.number().int().min(1).max(25).optional()
});

const importMicrosoftFileSchema = z.object({
  driveId: z.string().trim().min(1),
  itemId: z.string().trim().min(1),
  artifactName: z.string().trim().min(1).max(255).optional()
});

export type MicrosoftFilesRouteStores = {
  // The tenant toggles of Microsoft 365. Every route here reads Microsoft 365 for the
  // member, so it needs Reads on, as the read tools do (docs/connectors.md).
  loadIntegrationEnablement: AttachOverlaysInput["loadIntegrationEnablement"];
  microsoftFiles: Pick<
    MicrosoftFilesService,
    "listSites" | "listFiles" | "searchFiles" | "importFileToSession"
  >;
  limits?: Pick<RequestLimitsInterface, "consumeRateLimit">;
};

export function replyForMicrosoftError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof MicrosoftInvalidIdError) {
    reply.code(400);
    return { error: "invalid_microsoft_id", message: error.message, field: error.field };
  }

  if (error instanceof MicrosoftConnectionRequiredError) {
    reply.code(404);
    return { error: "microsoft_connection_not_found", message: error.message };
  }

  if (error instanceof ProjectAccessError || error instanceof SessionUploadAccessError) {
    reply.code(error.status);
    return apiError(error.code, error.message);
  }

  if (error instanceof MicrosoftImportTooLargeError) {
    reply.code(413);
    return apiError("artifact_too_large", error.message);
  }

  if (error instanceof MicrosoftUnsupportedImportError) {
    reply.code(415);
    return { error: "unsupported_media_type", message: error.message };
  }

  if (error instanceof MicrosoftGraphRequestError) {
    reply.code(error.status === 404 ? 404 : 502);
    return {
      error: error.status === 404 ? "microsoft_item_not_found" : "microsoft_graph_error",
      message: error.message,
      detail: error.detail
    };
  }

  if (error instanceof MicrosoftImportBlockedError) {
    reply.code(422);
    return {
      error: "pii_block",
      message: error.message,
      blockReason: error.blockReason,
      scanRunId: error.scanRunId
    };
  }

  if (error instanceof MicrosoftImportPiiScanError) {
    // A permanent rejection (an unscannable type, an unreadable PDF) is the
    // file's fault, as for a direct upload. Only a provider failure is a 503.
    reply.code(PERMANENT_PII_ERROR_CODES.has(error.code) ? 422 : 503);
    return { error: error.code, message: error.message };
  }

  throw error;
}

export async function registerMicrosoftFileRoutes(
  app: FastifyInstance,
  stores: MicrosoftFilesRouteStores
): Promise<void> {
  async function refuseWhenReadsOff(tenantId: string, reply: FastifyReply) {
    const enablement = await stores.loadIntegrationEnablement(tenantId, "microsoft");
    if (enablement.tenantReadsEnabled) return null;
    reply.code(403);
    return apiError("microsoft_integration_disabled", "Your organization has not enabled Microsoft 365.");
  }

  app.get("/integrations/microsoft/sites", async (request, reply) => {
    const inputResult = parseRequestInput(reply, microsoftSitesQuerySchema, request.query ?? {});
    if (!inputResult.ok) {
      return inputResult.response;
    }

    const { tenantId, userId } = request.auth;
    const disabled = await refuseWhenReadsOff(tenantId, reply);
    if (disabled) return disabled;

    try {
      const sites = await stores.microsoftFiles.listSites({
        tenantId,
        userId,
        search: inputResult.value.search
      });
      return serialize(MicrosoftSitesListResponseSchema, { sites });
    } catch (error) {
      return replyForMicrosoftError(reply, error);
    }
  });

  app.get("/integrations/microsoft/files", async (request, reply) => {
    const inputResult = parseRequestInput(reply, microsoftFilesQuerySchema, request.query ?? {});
    if (!inputResult.ok) {
      return inputResult.response;
    }

    const { tenantId, userId } = request.auth;
    const disabled = await refuseWhenReadsOff(tenantId, reply);
    if (disabled) return disabled;

    try {
      const items = await stores.microsoftFiles.listFiles({
        tenantId,
        userId,
        siteId: inputResult.value.siteId,
        driveId: inputResult.value.driveId,
        folderId: inputResult.value.folderId
      });
      return serialize(MicrosoftFilesListResponseSchema, { items });
    } catch (error) {
      return replyForMicrosoftError(reply, error);
    }
  });

  app.get("/integrations/microsoft/files/search", async (request, reply) => {
    const inputResult = parseRequestInput(reply, microsoftSearchQuerySchema, request.query ?? {});
    if (!inputResult.ok) {
      return inputResult.response;
    }

    const { tenantId, userId } = request.auth;
    const disabled = await refuseWhenReadsOff(tenantId, reply);
    if (disabled) return disabled;

    try {
      const results = await stores.microsoftFiles.searchFiles({
        tenantId,
        userId,
        query: inputResult.value.q,
        maxResults: inputResult.value.maxResults
      });
      return serialize(MicrosoftFilesSearchResponseSchema, { results });
    } catch (error) {
      return replyForMicrosoftError(reply, error);
    }
  });

  app.post("/sessions/:sessionId/import-microsoft-file", async (request, reply) => {
    const paramsResult = parseRequestInput(reply, sessionIdParams, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const bodyResult = parseRequestInput(reply, importMicrosoftFileSchema, request.body ?? {});
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { tenantId, userId } = request.auth;
    const disabled = await refuseWhenReadsOff(tenantId, reply);
    if (disabled) return disabled;

    // An import adds a file to the session like an upload, so it shares the upload limit.
    const rateLimitError = await stores.limits?.consumeRateLimit({ resource: "artifact_upload", userId, tenantId });
    if (rateLimitError) {
      reply.code(429);
      reply.header("retry-after", Math.max(1, Math.ceil(rateLimitError.retryAfterMs / 1000)));
      return rateLimitError;
    }

    try {
      const artifact = await stores.microsoftFiles.importFileToSession({
        tenantId,
        userId,
        sessionId: paramsResult.value.sessionId,
        driveId: bodyResult.value.driveId,
        itemId: bodyResult.value.itemId,
        artifactName: bodyResult.value.artifactName,
        createdByType: "user"
      });

      reply.code(201);
      return serialize(ArtifactEnvelopeSchema, { artifact });
    } catch (error) {
      return replyForMicrosoftError(reply, error);
    }
  });
}
