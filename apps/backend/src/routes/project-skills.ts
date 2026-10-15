import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  ProjectSkillActionSchema, ProjectSkillCopySchema, ProjectSkillCreateSchema, ProjectSkillDeleteResponseSchema,
  ProjectSkillDeleteSchema, ProjectSkillHistoryResponseSchema, ProjectSkillResponseSchema,
  ProjectSkillScopeSchema, ProjectSkillSourceUpdateSchema, ProjectSkillsResponseSchema, ProjectSkillUpdateSchema,
  type ProjectSkillScope
} from "@cogniplane/shared-types";
import type { AppDependencies } from "../app-dependencies.js";
import { apiError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import { ProjectAccessError } from "../services/project-access.js";
import {
  ProjectSkillConflictError, ProjectSkillLimitError, ProjectSkillNotFoundError,
  ProjectSkillSelectionFullError, ProjectSkillSourceError
} from "../services/skills/project-skill-store.js";
import { SkillSourceValidationError } from "../services/skills/personal-skill-validation.js";

export type ProjectSkillStores = { projectSkills: Pick<AppDependencies["projectSkills"],
  "list" | "get" | "history" | "create" | "copyFromPersonal" | "update" | "updateFromPersonal" | "action" | "remove"> };
const ProjectParams = z.object({ projectId: z.string().uuid() });
const SkillParams = ProjectParams.extend({ skillId: z.string().regex(/^project-skill-[0-9a-f-]{36}$/) });
const base = "/projects/:projectId/skills";

export async function registerProjectSkillRoutes(app: FastifyInstance, stores: ProjectSkillStores) {
  await app.register(async routes => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ProjectAccessError) return reply.code(error.status).send(apiError(error.code, error.message));
      if (error instanceof ProjectSkillNotFoundError) return reply.code(404).send(apiError("project_skill_not_found", error.message));
      if (error instanceof ProjectSkillConflictError) return reply.code(409).send(apiError("project_skill_conflict", error.message));
      if (error instanceof ProjectSkillLimitError) return reply.code(409).send(apiError("project_skill_limit", error.message));
      if (error instanceof ProjectSkillSelectionFullError) return reply.code(409).send(apiError("project_selection_full", error.message));
      if (error instanceof ProjectSkillSourceError) return reply.code(409).send(apiError(error.code, error.message));
      if (error instanceof SkillSourceValidationError) return reply.code(400).send(apiError("project_skill_invalid", error.message));
      throw error;
    });
    const privateReply = (reply: FastifyReply) => reply.header("cache-control", "private, no-store");
    // The expected scope is a precondition, not a target. A refreshed login for
    // another member, organization, or project must not replay an old draft.
    const checkWriteScope = (body: unknown, reply: FastifyReply, actual: ProjectSkillScope) => {
      const supplied = typeof body === "object" && body !== null && "scope" in body ? body.scope : undefined;
      const parsed = parseRequestInput(reply, ProjectSkillScopeSchema, supplied);
      if (!parsed.ok) return parsed.response;
      if (parsed.value.tenantId !== actual.tenantId || parsed.value.userId !== actual.userId ||
          parsed.value.projectId !== actual.projectId) {
        return reply.code(409).send(apiError("project_skill_scope_changed",
          "Your account, organization, or project changed. Reload before editing project skills."));
      }
      return null;
    };
    const scopeOf = (auth: { tenantId: string; userId: string }, projectId: string): ProjectSkillScope =>
      ({ tenantId: auth.tenantId, userId: auth.userId, projectId });

    routes.get(base, async (request, reply) => {
      const params = parseRequestInput(reply, ProjectParams, request.params);
      if (!params.ok) return params.response;
      const scope = scopeOf(request.auth, params.value.projectId);
      const result = await stores.projectSkills.list(scope.tenantId, scope.userId, scope.projectId);
      privateReply(reply);
      return serialize(ProjectSkillsResponseSchema, { scope, ...result });
    });
    routes.post(base, async (request, reply) => {
      const params = parseRequestInput(reply, ProjectParams, request.params);
      if (!params.ok) return params.response;
      const scope = scopeOf(request.auth, params.value.projectId);
      const scopeFailure = checkWriteScope(request.body, reply, scope);
      if (scopeFailure) return scopeFailure;
      const body = parseRequestInput(reply, ProjectSkillCreateSchema, request.body);
      if (!body.ok) return body.response;
      const skill = await stores.projectSkills.create(scope.tenantId, scope.userId, scope.projectId, body.value.source);
      privateReply(reply);
      return reply.code(201).send(serialize(ProjectSkillResponseSchema, { scope, skill }));
    });
    routes.post(`${base}/from-personal`, async (request, reply) => {
      const params = parseRequestInput(reply, ProjectParams, request.params);
      if (!params.ok) return params.response;
      const scope = scopeOf(request.auth, params.value.projectId);
      const scopeFailure = checkWriteScope(request.body, reply, scope);
      if (scopeFailure) return scopeFailure;
      const body = parseRequestInput(reply, ProjectSkillCopySchema, request.body);
      if (!body.ok) return body.response;
      const skill = await stores.projectSkills.copyFromPersonal(scope.tenantId, scope.userId, scope.projectId,
        body.value.personalSkillId, body.value.sourceRevision);
      privateReply(reply);
      return reply.code(201).send(serialize(ProjectSkillResponseSchema, { scope, skill }));
    });
    routes.get(`${base}/:skillId`, async (request, reply) => {
      const params = parseRequestInput(reply, SkillParams, request.params);
      if (!params.ok) return params.response;
      const scope = scopeOf(request.auth, params.value.projectId);
      const skill = await stores.projectSkills.get(scope.tenantId, scope.userId, scope.projectId, params.value.skillId);
      privateReply(reply);
      return serialize(ProjectSkillResponseSchema, { scope, skill });
    });
    routes.get(`${base}/:skillId/history`, async (request, reply) => {
      const params = parseRequestInput(reply, SkillParams, request.params);
      if (!params.ok) return params.response;
      const scope = scopeOf(request.auth, params.value.projectId);
      const revisions = await stores.projectSkills.history(scope.tenantId, scope.userId, scope.projectId, params.value.skillId);
      privateReply(reply);
      return serialize(ProjectSkillHistoryResponseSchema, { scope, revisions });
    });
    routes.put(`${base}/:skillId`, async (request, reply) => {
      const params = parseRequestInput(reply, SkillParams, request.params);
      if (!params.ok) return params.response;
      const scope = scopeOf(request.auth, params.value.projectId);
      const scopeFailure = checkWriteScope(request.body, reply, scope);
      if (scopeFailure) return scopeFailure;
      const body = parseRequestInput(reply, ProjectSkillUpdateSchema, request.body);
      if (!body.ok) return body.response;
      const skill = await stores.projectSkills.update(scope.tenantId, scope.userId, scope.projectId,
        params.value.skillId, body.value.source, body.value.version);
      privateReply(reply);
      return serialize(ProjectSkillResponseSchema, { scope, skill });
    });
    routes.post(`${base}/:skillId/from-personal`, async (request, reply) => {
      const params = parseRequestInput(reply, SkillParams, request.params);
      if (!params.ok) return params.response;
      const scope = scopeOf(request.auth, params.value.projectId);
      const scopeFailure = checkWriteScope(request.body, reply, scope);
      if (scopeFailure) return scopeFailure;
      const body = parseRequestInput(reply, ProjectSkillSourceUpdateSchema, request.body);
      if (!body.ok) return body.response;
      const skill = await stores.projectSkills.updateFromPersonal(scope.tenantId, scope.userId, scope.projectId,
        params.value.skillId, body.value.sourceRevision, body.value.version);
      privateReply(reply);
      return serialize(ProjectSkillResponseSchema, { scope, skill });
    });
    routes.post(`${base}/:skillId/action`, async (request, reply) => {
      const params = parseRequestInput(reply, SkillParams, request.params);
      if (!params.ok) return params.response;
      const scope = scopeOf(request.auth, params.value.projectId);
      const scopeFailure = checkWriteScope(request.body, reply, scope);
      if (scopeFailure) return scopeFailure;
      const body = parseRequestInput(reply, ProjectSkillActionSchema, request.body);
      if (!body.ok) return body.response;
      const skill = await stores.projectSkills.action(scope.tenantId, scope.userId, scope.projectId,
        params.value.skillId, body.value.action, body.value.version);
      privateReply(reply);
      return serialize(ProjectSkillResponseSchema, { scope, skill });
    });
    routes.delete(`${base}/:skillId`, async (request, reply) => {
      const params = parseRequestInput(reply, SkillParams, request.params);
      if (!params.ok) return params.response;
      const scope = scopeOf(request.auth, params.value.projectId);
      const scopeFailure = checkWriteScope(request.body, reply, scope);
      if (scopeFailure) return scopeFailure;
      const body = parseRequestInput(reply, ProjectSkillDeleteSchema, request.body);
      if (!body.ok) return body.response;
      await stores.projectSkills.remove(scope.tenantId, scope.userId, scope.projectId, params.value.skillId, body.value.version);
      privateReply(reply);
      return serialize(ProjectSkillDeleteResponseSchema, { scope, deleted: true });
    });
  });
}
