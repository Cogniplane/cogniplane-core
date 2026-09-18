import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ProjectNameSchema,
  ProjectInstructionsUpdateSchema,
  ProjectInstructionsStatusSchema,
  ProjectSchema,
  ProjectApprovalModeUpdateSchema,
  ProjectAgentFileModeUpdateSchema,
  ProjectsResponseSchema,
  ProjectDetailSchema,
  SESSION_TRASH_RETENTION_DAYS,
  SessionEnvelopeSchema
} from "@cogniplane/shared-types";
import { ProjectAccessError } from "../services/project-access.js";
import type { AppDependencies } from "../app-dependencies.js";
import { ensureUser } from "../lib/db.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import { apiError, notFoundError } from "../lib/http-errors.js";

export type ProjectRouteStores = Pick<
  AppDependencies,
  | "projects"
  | "sessions"
  | "artifacts"
  | "activeTurns"
  | "runtimeAdapter"
  | "limits"
  | "auditEvents"
>;
const projectParams = z.object({ projectId: z.string().uuid() });
const sessionBody = z
  .object({
    sessionId: z.string().uuid(),
    // Accept the legacy flag only to return an explicit detachment error.
    attach: z.boolean().optional(),
    confirmAudience: z.boolean().default(false)
  })
  .strict();
export async function registerProjectRoutes(app: FastifyInstance, stores: ProjectRouteStores) {
  await app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ProjectAccessError)
        return reply.code(error.status).send(apiError(error.code, error.message));
      throw error;
    });
    await registerScopedProjectRoutes(routes, stores);
  });
}

async function registerScopedProjectRoutes(app: FastifyInstance, stores: ProjectRouteStores) {
  const owned = async (request: FastifyRequest, reply: FastifyReply, active = false, editor = false) => {
    const parsed = parseRequestInput(reply, projectParams, request.params);
    if (!parsed.ok) {
      reply.send(parsed.response);
      return null;
    }
    const { tenantId, userId } = request.auth;
    const project = await (editor ? stores.projects.getEditable : stores.projects.getOwned)
      .call(stores.projects, tenantId, userId, parsed.value.projectId);
    if (!project) {
      reply.code(404).send(notFoundError("project_not_found"));
      return null;
    }
    if (active && project.archivedAt) {
      reply.code(409).send(apiError("project_archived", "Restore the project before changing it."));
      return null;
    }
    return { tenantId, userId, project };
  };
  const limited = async (
    request: FastifyRequest,
    reply: FastifyReply,
    resource: "session_create" | "artifact_upload"
  ) => {
    const error = await stores.limits.consumeRateLimit({ ...request.auth, resource });
    if (!error) return false;
    reply
      .header("retry-after", Math.max(1, Math.ceil(error.retryAfterMs / 1000)))
      .code(429)
      .send(error);
    return true;
  };
  app.get("/projects", async (request, reply) => {
    const query = parseRequestInput(
      reply,
      z
        .object({
          archived: z.enum(["true", "false"]).optional(),
          q: z.string().trim().max(200).optional()
        })
        .strict(),
      request.query
    );
    if (!query.ok) return query.response;
    reply.header("cache-control", "private, no-store");
    return serialize(ProjectsResponseSchema, {
      projects: await stores.projects.list(request.auth.tenantId, request.auth.userId, {
        archived: query.value.archived === "true",
        q: query.value.q
      })
    });
  });
  app.get("/projects/:projectId/instructions/status", async (request, reply) => {
    const params = parseRequestInput(reply, projectParams, request.params);
    if (!params.ok) return params.response;
    const status = await stores.projects.getInstructionsStatus(
      request.auth.tenantId, request.auth.userId, params.value.projectId);
    if (!status) return reply.code(404).send(notFoundError("project_not_found"));
    return serialize(ProjectInstructionsStatusSchema, status);
  });
  app.put("/projects/:projectId/instructions", async (request, reply) => {
    const body = parseRequestInput(reply, ProjectInstructionsUpdateSchema, request.body);
    if (!body.ok) return body.response;
    const context = await owned(request, reply, true);
    if (!context) return reply;
    const { tenantId, userId, project } = context;
    if (!await stores.projects.updateInstructions(tenantId, userId, project.projectId,
      body.value.instructions, body.value.expectedRevision)) {
      return reply.code(409).send(apiError("project_instructions_conflict",
        "Instructions changed in another tab. Reload the saved version before trying again."));
    }
    return serialize(ProjectSchema, await stores.projects.getOwned(tenantId, userId, project.projectId));
  });
  app.put("/projects/:projectId/approval-mode", async (request, reply) => {
    const body = parseRequestInput(reply, ProjectApprovalModeUpdateSchema, request.body);
    if (!body.ok) return body.response;
    const context = await owned(request, reply, true);
    if (!context) return reply;
    const changed = await stores.projects.setApprovalMode(
      context.tenantId,
      context.userId,
      context.project.projectId,
      body.value.approvalMode
    );
    if (!changed) return reply.code(404).send(notFoundError("project_not_found"));
    const updated = await stores.projects.getOwned(
      context.tenantId,
      context.userId,
      context.project.projectId
    );
    if (!updated) return reply.code(404).send(notFoundError("project_not_found"));
    return serialize(ProjectSchema, updated);
  });
  app.put("/projects/:projectId/agent-file-mode", async (request, reply) => {
    const body = parseRequestInput(reply, ProjectAgentFileModeUpdateSchema, request.body);
    if (!body.ok) return body.response;
    const context = await owned(request, reply, true);
    if (!context) return reply;
    const changed = await stores.projects.setAgentFileMode(
      context.tenantId,
      context.userId,
      context.project.projectId,
      body.value.agentFileMode
    );
    if (!changed) return reply.code(404).send(notFoundError("project_not_found"));
    const updated = await stores.projects.getOwned(
      context.tenantId,
      context.userId,
      context.project.projectId
    );
    if (!updated) return reply.code(404).send(notFoundError("project_not_found"));
    return serialize(ProjectSchema, updated);
  });
  app.put("/projects/:projectId/archive", async (request, reply) => {
    const context = await owned(request, reply);
    if (!context) return reply;
    const body = parseRequestInput(
      reply,
      z.object({ archived: z.boolean() }).strict(),
      request.body
    );
    if (!body.ok) return body.response;
    const changed = await stores.projects.setArchived(
      context.tenantId,
      context.userId,
      context.project.projectId,
      body.value.archived
    );
    if (!changed) return reply.code(404).send(notFoundError("project_not_found"));
    return reply.code(204).send();
  });
  app.post("/projects", async (request, reply) => {
    const body = parseRequestInput(reply, ProjectNameSchema, request.body);
    if (!body.ok) return body.response;
    if (await limited(request, reply, "session_create")) return reply;
    await ensureUser(app.db, request.auth.userId);
    const project = await stores.projects.create(
      request.auth.tenantId,
      request.auth.userId,
      body.value.name
    );
    reply.code(201);
    return serialize(ProjectSchema, project);
  });
  app.get("/projects/:projectId", async (request, reply) => {
    const params = parseRequestInput(reply, projectParams, request.params);
    if (!params.ok) return params.response;
    const { tenantId, userId } = request.auth;
    const project = await stores.projects.getReadable(tenantId, userId, params.value.projectId);
    if (!project) return reply.code(404).send(notFoundError("project_not_found"));
    const [activeSessions, archivedSessions, files] = await Promise.all([
      stores.sessions.list(tenantId, userId, {
        purposes: ["normal"],
        projectId: project.projectId
      }),
      stores.sessions.list(tenantId, userId, {
        purposes: ["normal"],
        status: "archived",
        projectId: project.projectId
      }),
      stores.artifacts.listByProject(tenantId, userId, project.projectId)
    ]);
    const trashRetentionDays = stores.sessions.getRetentionDays?.() ?? SESSION_TRASH_RETENTION_DAYS;
    const trash = project.canEdit && trashRetentionDays > 0
      ? await stores.sessions.list(tenantId, userId, {
        purposes: ["normal"],
        status: "deleted",
        projectId: project.projectId,
      })
      : [];
    const activity = stores.auditEvents.listProjectActivity
      ? await stores.auditEvents.listProjectActivity(tenantId, project.projectId)
      : [];
    reply.header("cache-control", "private, no-store");
    return serialize(ProjectDetailSchema, {
      project,
      sessions: [...activeSessions, ...archivedSessions],
      files,
      canManage: project.canManage,
      canEdit: project.canEdit,
      trash: { sessions: trash, retentionDays: trashRetentionDays },
      activity
    });
  });
  app.put("/projects/:projectId", async (request, reply) => {
    const body = parseRequestInput(reply, ProjectNameSchema, request.body);
    if (!body.ok) return body.response;
    const context = await owned(request, reply, true);
    if (!context) return reply;
    const project = await stores.projects.rename(
      context.tenantId,
      context.userId,
      context.project.projectId,
      body.value.name
    );
    if (!project) {
      reply.code(404);
      return notFoundError("project_not_found");
    }
    return serialize(ProjectSchema, project);
  });
  app.post("/projects/:projectId/sessions", async (request, reply) => {
    const context = await owned(request, reply, true, true);
    if (!context) return reply;
    const body = parseRequestInput(reply, ProjectNameSchema, request.body);
    if (!body.ok) return body.response;
    if (await limited(request, reply, "session_create")) return reply;
    const { tenantId, userId, project } = context;
    await ensureUser(app.db, userId);
    const id = await stores.projects.createSession(
      tenantId,
      userId,
      project.projectId,
      body.value.name
    );
    if (!id) {
      reply.code(404);
      return notFoundError("project_not_found");
    }
    reply.code(201);
    return serialize(SessionEnvelopeSchema, {
      session: await stores.sessions.getOwned(tenantId, id, userId)
    });
  });
  app.put("/projects/:projectId/sessions", async (request, reply) => {
    const context = await owned(request, reply, false, true);
    if (!context) return reply;
    const body = parseRequestInput(reply, sessionBody, request.body);
    if (!body.ok) return body.response;
    const { tenantId, userId, project } = context;
    const session = await stores.sessions.getOwned(tenantId, body.value.sessionId, userId);
    if (!session || session.status !== "active" || session.purpose !== "normal") {
      reply.code(404);
      return notFoundError("session_not_found");
    }
    if (body.value.attach === false) {
      return reply.code(409).send(apiError("project_session_detach_forbidden",
        "Sessions cannot be removed from their project."));
    }
    if (session.projectId && session.projectId !== project.projectId) {
      return reply.code(409).send(apiError("project_session_move_forbidden",
        "Sessions cannot move between projects."));
    }
    if (project.archivedAt) {
      return reply.code(409).send(apiError("project_archived",
        "Restore the project before adding a session."));
    }
    if (!session.projectId && !body.value.confirmAudience) {
      return reply.code(409).send(apiError("project_audience_confirmation_required",
        "Confirm that this conversation and its attachments will follow project access. The session cannot be moved or detached afterward."));
    }
    const release = stores.runtimeAdapter.hasActiveTurn(session.sessionId)
      ? null
      : stores.activeTurns.reserveMutation(session.sessionId);
    if (!release) {
      reply.code(409);
      return apiError("session_busy", "Finish the current turn before adding this session to a project.");
    }
    try {
      if (
        !(await stores.projects.setSession(
          tenantId,
          userId,
          project.projectId,
          session.sessionId
        ))
      ) {
        reply.code(409);
        return apiError("project_conflict", "The session changed. Reload and try again.");
      }
      return reply.code(204).send();
    } finally {
      release();
    }
  });
}
