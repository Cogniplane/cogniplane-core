import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ProjectFileCreateSchema,
  ProjectFileLocationSchema,
  ProjectEntryNameSchema,
  ProjectFileSchema,
  ProjectLibrarySchema,
  ProjectFolderSchema,
  ProjectFileHistorySchema,
} from "@cogniplane/shared-types";
import { ProjectAccessError } from "../services/project-access.js";
import type { AppDependencies } from "../app-dependencies.js";
import {
  ProjectFileError,
  ProjectFileStore,
} from "../services/project-file-store.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { apiError } from "../lib/http-errors.js";
import { serialize } from "../lib/serialize-response.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const fileParams = projectParams.extend({ fileId: z.string().uuid() });
const versionParams = fileParams.extend({ versionId: z.string().uuid() });
const folderParams = projectParams.extend({ folderId: z.string().uuid() });
export type ProjectFileRouteStores = Pick<
  AppDependencies,
  "artifactStorage" | "artifactProcessor" | "limits"
>;

export async function registerProjectFileRoutes(
  app: FastifyInstance,
  stores: ProjectFileRouteStores,
) {
  const files = new ProjectFileStore(app.db, app.log);
  // Scope the error handler to this plugin; existing project routes keep theirs.
  await app.register(async (routes) => {
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof ProjectFileError || error instanceof ProjectAccessError)
        return reply
          .code(error.status)
          .send(apiError(error.code, error.message));
      request.log.error({ err: error }, "Project file request failed");
      return reply
        .code(500)
        .send(
          apiError(
            "project_file_error",
            "The file operation failed. Try again.",
          ),
        );
    });
    routes.get("/projects/:projectId/library", async (request, reply) => {
      const params = parseRequestInput(reply, projectParams, request.params);
      if (!params.ok) return params.response;
      return serialize(
        ProjectLibrarySchema,
        await files.list({ ...request.auth, ...params.value }),
      );
    });
    routes.post(
      "/projects/:projectId/library/files",
      async (request, reply) => {
        const params = parseRequestInput(reply, projectParams, request.params);
        if (!params.ok) return params.response;
        const body = parseRequestInput(
          reply,
          ProjectFileCreateSchema,
          request.body,
        );
        if (!body.ok) return body.response;
        // Limit attempts before storage I/O, including retries that encounter a conflict.
        const limited = await stores.limits.consumeRateLimit({
          ...request.auth,
          resource: "artifact_upload",
        });
        if (limited)
          return reply
            .header(
              "retry-after",
              Math.max(1, Math.ceil(limited.retryAfterMs / 1000)),
            )
            .code(429)
            .send(limited);
        const file = await files.createFromArtifact(
          { ...request.auth, ...params.value },
          body.value,
          stores.artifactStorage,
          app.config.ARTIFACT_MAX_UPLOAD_BYTES,
        );
        return reply.code(201).send(serialize(ProjectFileSchema, file));
      },
    );
    routes.post(
      "/projects/:projectId/library/folders",
      async (request, reply) => {
        const params = parseRequestInput(reply, projectParams, request.params);
        if (!params.ok) return params.response;
        const body = parseRequestInput(
          reply,
          z
            .object({
              name: ProjectEntryNameSchema,
              parentId: z.string().uuid().nullable().default(null),
            })
            .strict(),
          request.body,
        );
        if (!body.ok) return body.response;
        return reply
          .code(201)
          .send(
            serialize(
              ProjectFolderSchema,
              await files.createFolder(
                { ...request.auth, ...params.value },
                body.value.name,
                body.value.parentId,
              ),
            ),
          );
      },
    );
    routes.put(
      "/projects/:projectId/library/folders/:folderId",
      async (request, reply) => {
        const params = parseRequestInput(reply, folderParams, request.params);
        if (!params.ok) return params.response;
        const body = parseRequestInput(
          reply,
          z.object({ name: ProjectEntryNameSchema }).strict(),
          request.body,
        );
        if (!body.ok) return body.response;
        await files.renameFolder(
          { ...request.auth, ...params.value },
          params.value.folderId,
          body.value.name,
        );
        return reply.code(204).send();
      },
    );
    routes.delete(
      "/projects/:projectId/library/folders/:folderId",
      async (request, reply) => {
        const params = parseRequestInput(reply, folderParams, request.params);
        if (!params.ok) return params.response;
        await files.removeFolder(
          { ...request.auth, ...params.value },
          params.value.folderId,
        );
        return reply.code(204).send();
      },
    );
    routes.put(
      "/projects/:projectId/library/files/:fileId/location",
      async (request, reply) => {
        const params = parseRequestInput(reply, fileParams, request.params);
        if (!params.ok) return params.response;
        const body = parseRequestInput(
          reply,
          ProjectFileLocationSchema,
          request.body,
        );
        if (!body.ok) return body.response;
        await files.relocate(
          { ...request.auth, ...params.value },
          params.value.fileId,
          body.value.name,
          body.value.folderId,
        );
        return reply.code(204).send();
      },
    );
    routes.put(
      "/projects/:projectId/library/files/:fileId/restore",
      async (request, reply) => {
        const params = parseRequestInput(reply, fileParams, request.params);
        if (!params.ok) return params.response;
        const body = parseRequestInput(
          reply,
          ProjectFileLocationSchema,
          request.body,
        );
        if (!body.ok) return body.response;
        await files.restoreTrash(
          { ...request.auth, ...params.value },
          params.value.fileId,
          body.value.name,
          body.value.folderId,
        );
        return reply.code(204).send();
      },
    );
    routes.put(
      "/projects/:projectId/library/files/:fileId/save-as-new",
      async (request, reply) => {
        const params = parseRequestInput(reply, fileParams, request.params);
        if (!params.ok) return params.response;
        const body = parseRequestInput(
          reply,
          ProjectFileLocationSchema,
          request.body,
        );
        if (!body.ok) return body.response;
        await files.saveDraftAsNew(
          { ...request.auth, ...params.value },
          params.value.fileId,
          body.value.name,
          body.value.folderId,
        );
        return reply.code(204).send();
      },
    );
    routes.post(
      "/projects/:projectId/library/files/:fileId/promote",
      async (request, reply) => {
        const params = parseRequestInput(reply, fileParams, request.params);
        if (!params.ok) return params.response;
        return serialize(
          ProjectFileSchema,
          await files.promote(
            { ...request.auth, ...params.value },
            params.value.fileId,
          ),
        );
      },
    );
    routes.delete(
      "/projects/:projectId/library/files/:fileId",
      async (request, reply) => {
        const params = parseRequestInput(reply, fileParams, request.params);
        if (!params.ok) return params.response;
        await files.trash(
          { ...request.auth, ...params.value },
          params.value.fileId,
        );
        return reply.code(204).send();
      },
    );
    routes.get(
      "/projects/:projectId/library/files/:fileId/versions",
      async (request, reply) => {
        const params = parseRequestInput(reply, fileParams, request.params);
        if (!params.ok) return params.response;
        return serialize(
          ProjectFileHistorySchema,
          await files.history(
            { ...request.auth, ...params.value },
            params.value.fileId,
          ),
        );
      },
    );
    routes.post(
      "/projects/:projectId/library/files/:fileId/versions/:versionId/restore",
      async (request, reply) => {
        const params = parseRequestInput(reply, versionParams, request.params);
        if (!params.ok) return params.response;
        const body = parseRequestInput(
          reply,
          z.object({ expectedVersionId: z.string().uuid() }).strict(),
          request.body,
        );
        if (!body.ok) return body.response;
        return serialize(
          ProjectFileSchema,
          await files.restoreVersion(
            { ...request.auth, ...params.value },
            params.value.fileId,
            params.value.versionId,
            body.value.expectedVersionId,
          ),
        );
      },
    );
    routes.get(
      "/projects/:projectId/library/files/:fileId/versions/:versionId/content",
      async (request, reply) => {
        const params = parseRequestInput(reply, versionParams, request.params);
        if (!params.ok) return params.response;
        const content = await files.content(
          { ...request.auth, ...params.value },
          params.value.fileId,
          params.value.versionId,
        );
        const handle = await stores.artifactStorage.openReadStream(
          content.storageKey,
        );
        reply.header("cache-control", "private, no-store");
        reply.header("x-content-type-options", "nosniff");
        reply.header(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(content.name)}`,
        );
        return reply.type(content.mimeType).send(handle.stream);
      },
    );
    routes.get(
      "/projects/:projectId/library/files/:fileId/versions/:versionId/preview-text",
      async (request, reply) => {
        const params = parseRequestInput(reply, versionParams, request.params);
        if (!params.ok) return params.response;
        const content = await files.content(
          { ...request.auth, ...params.value },
          params.value.fileId,
          params.value.versionId,
        );
        if (content.mimeType !== "application/pdf")
          return reply
            .code(422)
            .send(
              apiError(
                "not_a_pdf",
                "Text preview is only available for PDF files.",
              ),
            );
        const text = await stores.artifactProcessor.extractArtifactText({
          ...content,
          status: "ready",
        });
        if (text === null)
          return reply
            .code(422)
            .send(
              apiError(
                "pdf_extraction_failed",
                "This PDF could not be previewed. Download it to view its contents.",
              ),
            );
        reply.header("cache-control", "private, no-store");
        return { text };
      },
    );
  });
}
