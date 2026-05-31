import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  AdminSkillEnvelopeSchema,
  AdminSkillsListResponseSchema,
  SkillMarketplaceResponseSchema
} from "@cogniplane/shared-types";

import { apiError, getErrorMessage, requestError } from "../../lib/http-errors.js";
import { serialize } from "../../lib/serialize-response.js";
import {
  activateSkillRevisionBodySchema,
  cleanupSkillRevisionsBodySchema,
  githubImportBodySchema,
  inlineSkillImportBodySchema,
  skillRevisionParamsSchema
} from "./admin-route-schemas.js";
import {
  adminIdSchema,
  configError,
  createAdminAuditEvent,
  parseAdminBody,
  parseAdminParams,
  respondAdminMutationError,
  respondAdminNotFound,
  withAdmin
} from "./admin-route-helpers.js";
import type { ActivationTracker } from "../../services/activation-tracker.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { DynamicConfigService } from "../../services/dynamic-config-service.js";
import {
  GithubConnectionNotConfiguredError,
  type GithubConnectionService
} from "../../services/integrations/github/github-connection-service.js";
import type { SkillMarketplaceService } from "../../services/skills/skill-marketplace-service.js";
import type { SkillBundleStorage } from "../../services/skills/skill-bundle-storage.js";
import { SkillLifecycleService } from "../../services/skills/skill-lifecycle-service.js";
import {
  SKILL_FILE_PREVIEW_LIMIT_BYTES,
  readSkillRevisionFile
} from "../../services/skills/skill-revision-file-reader.js";
const skillIdParamsSchema = z.object({ skillId: adminIdSchema });
const skillRevisionFileQuerySchema = z.object({
  path: z.string().min(1).max(1024)
});

function respondSkillConfigError(reply: FastifyReply, error: unknown, fallback: string) {
  reply.code(400);
  return configError(getErrorMessage(error, fallback));
}

function respondSkillUploadTooLarge(reply: FastifyReply, error: unknown) {
  reply.code(413);
  return apiError("skill_import_too_large", getErrorMessage(error, "Skill import exceeds size limit."));
}

export async function registerAdminSkillRoutes(
  app: FastifyInstance,
  stores: {
    dynamicConfig: DynamicConfigService;
    skillMarketplace: SkillMarketplaceService;
    auditEvents: AuditEventStore;
    skillBundleStorage: SkillBundleStorage;
    githubConnections?: GithubConnectionService;
    tenantSettings?: {
      getMarketplaceManifestUrl(tenantId: string): Promise<string | null>;
    };
    // Optional: when present, the skill list is decorated with adoption
    // counts (last 30 days) per skill. Failures are swallowed — counts are
    // decorative. Tests that don't supply it just get skills with no counts.
    activations?: ActivationTracker;
  }
): Promise<void> {
  const ACTIVATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  const skillLifecycle = new SkillLifecycleService(stores.dynamicConfig, stores.auditEvents);

  app.get("/admin/skills", withAdmin(app, async (request) => {
    const skills = await stores.dynamicConfig.listSkills(request.auth.tenantId, true);
    if (!stores.activations) {
      return serialize(AdminSkillsListResponseSchema, { skills });
    }
    let counts:
      | Awaited<ReturnType<ActivationTracker["countSkillActivations"]>>
      | null = null;
    try {
      counts = await stores.activations.countSkillActivations(
        request.auth.tenantId,
        ACTIVATION_WINDOW_MS
      );
    } catch (err) {
      // Counts are decorative. If the activations table errored, log and
      // serve skills without counts rather than failing the whole list.
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "admin-skill-routes: failed to read activation counts; returning skills without counts"
      );
    }
    if (!counts) {
      return serialize(AdminSkillsListResponseSchema, { skills });
    }
    return serialize(AdminSkillsListResponseSchema, {
      skills: skills.map((skill) => {
        const entry = counts!.get(skill.skillId);
        return {
          ...skill,
          invokedSessions30d: entry?.invokedSessions ?? 0,
          materializedSessions30d: entry?.materializedSessions ?? 0
        };
      })
    });
  }));

  app.get("/admin/skills/marketplace", withAdmin(app, async (request) => {
    const tenantId = request.auth.tenantId;

    const [orgManifestUrl, githubToken] = await Promise.all([
      stores.tenantSettings?.getMarketplaceManifestUrl(tenantId).catch(() => null) ?? Promise.resolve(null),
      stores.githubConnections
        ? stores.githubConnections.getRuntimeCredentials(tenantId, request.auth.userId)
            .then((creds) => creds?.token ?? null)
            .catch((err) => {
              if (err instanceof GithubConnectionNotConfiguredError) return null;
              app.log.warn({ err }, "Failed to get GitHub user token for marketplace; proceeding without auth");
              return null;
            })
        : Promise.resolve(null)
    ]);

    const catalog = await stores.skillMarketplace.getCatalog(
      orgManifestUrl ? { manifestUrl: orgManifestUrl, githubToken: githubToken ?? undefined } : undefined
    );

    return serialize(SkillMarketplaceResponseSchema, { marketplace: catalog });
  }));

  app.post("/admin/skills/:skillId/disable", withAdmin(app, async (request, reply) => {
    const paramsResult = parseAdminParams(reply, skillIdParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    try {
      const skill = await stores.dynamicConfig.disableSkill(request.auth.tenantId, paramsResult.value.skillId);
      if (!skill) {
        return respondAdminNotFound(reply, "skill_not_found");
      }

      await createAdminAuditEvent(stores.auditEvents, {
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        type: "admin.skill.disabled",
        payload: {
          skillId: skill.skillId,
          version: skill.version
        },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });

      return serialize(AdminSkillEnvelopeSchema, { skill });
    } catch (error) {
      return respondAdminMutationError(reply, error, "Skill cannot be disabled.");
    }
  }));

  app.post("/admin/skills/import/zip", withAdmin(app, async (request, reply) => {
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
      return respondSkillUploadTooLarge(reply, error);
    }

    if (!file) {
      reply.code(400);
      return configError("A zip file upload is required.");
    }

    const fileName = file.filename ?? "skill.zip";
    try {
      const archiveBuffer = await file.toBuffer();
      const imported = await skillLifecycle.importSkillBundleFromZip(request.auth.tenantId, {
        archiveBuffer,
        originalFileName: fileName,
        actorUserId: request.auth.userId
      });

      reply.code(201);
      return imported;
    } catch (error) {
      return respondSkillConfigError(reply, error, "Skill import failed.");
    }
  }));

  app.post("/admin/skills/import/github", withAdmin(app, async (request, reply) => {
    const bodyResult = parseAdminBody(reply, githubImportBodySchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const githubToken = stores.githubConnections
      ? await stores.githubConnections
          .getRuntimeCredentials(request.auth.tenantId, request.auth.userId)
          .then((creds) => creds?.token ?? undefined)
          .catch((err) => {
            if (err instanceof GithubConnectionNotConfiguredError) return undefined;
            app.log.warn({ err }, "Failed to get GitHub user token; proceeding without auth");
            return undefined;
          })
      : undefined;

    try {
      const imported = await skillLifecycle.importSkillBundleFromGithub(request.auth.tenantId, {
        githubUrl: bodyResult.value.githubUrl,
        ref: bodyResult.value.ref,
        subdirectory: bodyResult.value.subdirectory,
        actorUserId: request.auth.userId,
        githubToken
      });

      reply.code(201);
      return imported;
    } catch (error) {
      return respondSkillConfigError(reply, error, "GitHub skill import failed.");
    }
  }));

  app.post("/admin/skills/import/inline", withAdmin(app, async (request, reply) => {
    const bodyResult = parseAdminBody(reply, inlineSkillImportBodySchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    try {
      const imported = await skillLifecycle.importSkillBundleFromInline(request.auth.tenantId, {
        skillId: bodyResult.value.skillId,
        skillName: bodyResult.value.skillName,
        description: bodyResult.value.description,
        instructions: bodyResult.value.instructions,
        actorUserId: request.auth.userId
      });

      reply.code(201);
      return imported;
    } catch (error) {
      return respondSkillConfigError(reply, error, "Inline skill import failed.");
    }
  }));

  app.get("/admin/skills/:skillId/revisions", withAdmin(app, async (request, reply) => {
    const paramsResult = parseAdminParams(reply, skillIdParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    return {
      revisions: await stores.dynamicConfig.listSkillRevisions(request.auth.tenantId, paramsResult.value.skillId)
    };
  }));

  app.get(
    "/admin/skills/:skillId/revisions/:skillRevisionId/files",
    withAdmin(app, async (request, reply) => {
      const paramsResult = parseAdminParams(reply, skillRevisionParamsSchema, request.params);
      if (!paramsResult.ok) {
        return paramsResult.response;
      }

      const queryParse = skillRevisionFileQuerySchema.safeParse(request.query);
      if (!queryParse.success) {
        reply.code(400);
        return requestError(
          queryParse.error.issues.map((issue) => ({
            path: issue.path.join(".") || "path",
            message: issue.message
          }))
        );
      }

      const revision = await stores.dynamicConfig.getSkillRevision(
        request.auth.tenantId,
        paramsResult.value.skillId,
        paramsResult.value.skillRevisionId
      );
      if (!revision) {
        return respondAdminNotFound(reply, "skill_revision_not_found");
      }

      const preview = await readSkillRevisionFile({
        revision,
        requestedPath: queryParse.data.path,
        skillBundleStorage: stores.skillBundleStorage
      });

      if (preview.kind === "not_found") {
        return respondAdminNotFound(reply, "skill_revision_file_not_found");
      }

      if (preview.kind === "too_large") {
        reply.code(413);
        return {
          ...apiError(
            "skill_revision_file_too_large",
            `File is ${preview.sizeBytes} bytes, exceeds ${preview.limitBytes}-byte preview limit.`
          ),
          sizeBytes: preview.sizeBytes,
          limitBytes: preview.limitBytes
        };
      }

      return {
        file: {
          path: preview.filePath,
          sizeBytes: preview.sizeBytes,
          encoding: preview.encoding,
          contentType: preview.contentType,
          content: preview.content
        },
        limitBytes: SKILL_FILE_PREVIEW_LIMIT_BYTES
      };
    })
  );

  app.post(
    "/admin/skills/:skillId/revisions/:skillRevisionId/activate",
    withAdmin(app, async (request, reply) => {
      const paramsResult = parseAdminParams(reply, skillRevisionParamsSchema, request.params);
      if (!paramsResult.ok) {
        return paramsResult.response;
      }

      const bodyResult = parseAdminBody(reply, activateSkillRevisionBodySchema, request.body ?? {});
      if (!bodyResult.ok) {
        return bodyResult.response;
      }

      try {
        const activated = await skillLifecycle.activateSkillRevision(request.auth.tenantId, {
          skillId: paramsResult.value.skillId,
          skillRevisionId: paramsResult.value.skillRevisionId,
          actorUserId: request.auth.userId,
          reviewNotes: bodyResult.value.reviewNotes ?? null
        });

        if (!activated) {
          return respondAdminNotFound(reply, "skill_revision_not_found");
        }

        return activated;
      } catch (error) {
        return respondSkillConfigError(reply, error, "Skill activation failed.");
      }
    })
  );

  app.post("/admin/skills/:skillId/publish", withAdmin(app, async (request, reply) => {
    const paramsResult = parseAdminParams(reply, skillIdParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    try {
      const skill = await stores.dynamicConfig.setSkillPublished(request.auth.tenantId, paramsResult.value.skillId, true);
      if (!skill) {
        return respondAdminNotFound(reply, "skill_not_found");
      }

      await createAdminAuditEvent(stores.auditEvents, {
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        type: "admin.skill.published",
        payload: { skillId: skill.skillId, version: skill.version },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });

      return serialize(AdminSkillEnvelopeSchema, { skill });
    } catch (error) {
      return respondAdminMutationError(reply, error, "Skill cannot be published.");
    }
  }));

  app.post("/admin/skills/:skillId/unpublish", withAdmin(app, async (request, reply) => {
    const paramsResult = parseAdminParams(reply, skillIdParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    try {
      const skill = await stores.dynamicConfig.setSkillPublished(request.auth.tenantId, paramsResult.value.skillId, false);
      if (!skill) {
        return respondAdminNotFound(reply, "skill_not_found");
      }

      await createAdminAuditEvent(stores.auditEvents, {
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        type: "admin.skill.unpublished",
        payload: { skillId: skill.skillId, version: skill.version },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });

      return serialize(AdminSkillEnvelopeSchema, { skill });
    } catch (error) {
      return respondAdminMutationError(reply, error, "Skill cannot be unpublished.");
    }
  }));

  app.post("/admin/skills/revisions/cleanup", withAdmin(app, async (request, reply) => {
    const bodyResult = parseAdminBody(reply, cleanupSkillRevisionsBodySchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    try {
      const report = await skillLifecycle.cleanupInactiveSkillRevisions(request.auth.tenantId, {
        actorUserId: request.auth.userId,
        dryRun: bodyResult.value?.dryRun ?? false
      });

      return { report };
    } catch (error) {
      return respondSkillConfigError(reply, error, "Skill cleanup failed.");
    }
  }));

}
