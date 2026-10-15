import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PersonalSkillActionSchema, PersonalSkillCreateSchema, PersonalSkillDeleteResponseSchema,
  PersonalSkillDeleteSchema, PersonalSkillHistoryResponseSchema, PersonalSkillResponseSchema,
  PersonalSkillsResponseSchema, PersonalSkillScopeSchema, PersonalSkillUpdateSchema
} from "@cogniplane/shared-types";
import type { AppDependencies } from "../app-dependencies.js";
import { apiError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import {
  PersonalSkillAccessError, PersonalSkillConflictError, PersonalSkillDefaultsFullError,
  PersonalSkillLimitError, PersonalSkillNotFoundError
} from "../services/skills/personal-skill-store.js";
import { PersonalSkillValidationError } from "../services/skills/personal-skill-validation.js";

export type PersonalSkillStores = { personalSkills: Pick<AppDependencies["personalSkills"],
  "list" | "get" | "history" | "create" | "update" | "action" | "remove"> };
const IdParams = z.object({ skillId: z.string().regex(/^personal-skill-[0-9a-f-]{36}$/) });

export async function registerPersonalSkillRoutes(app: FastifyInstance, stores: PersonalSkillStores) {
  await app.register(async routes => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof PersonalSkillAccessError) return reply.code(403).send(apiError("membership_required", error.message));
      if (error instanceof PersonalSkillNotFoundError) return reply.code(404).send(apiError("personal_skill_not_found", error.message));
      if (error instanceof PersonalSkillConflictError) return reply.code(409).send(apiError("personal_skill_conflict", error.message));
      if (error instanceof PersonalSkillDefaultsFullError) return reply.code(409).send(apiError("personal_defaults_full", error.message));
      if (error instanceof PersonalSkillLimitError) return reply.code(409).send(apiError("personal_skill_limit", error.message));
      if (error instanceof PersonalSkillValidationError) return reply.code(400).send(apiError("personal_skill_invalid", error.message));
      throw error;
    });
    const scope = (tenantId: string, userId: string) => ({ tenantId, userId });
    const mismatched = (provided: { tenantId: string; userId: string }, actual: { tenantId: string; userId: string }) =>
      provided.tenantId !== actual.tenantId || provided.userId !== actual.userId;
    const scopeError = () => apiError("personal_skill_scope_changed", "Your account or organization changed. Reload before editing this skill.");
    const privateReply = (reply: { header: (name: string, value: string) => unknown }) => reply.header("cache-control", "private, no-store");
    const checkWriteScope = (requestBody: unknown, reply: Parameters<typeof parseRequestInput>[0],
      tenantId: string, userId: string) => {
      const supplied = typeof requestBody === "object" && requestBody !== null && "scope" in requestBody
        ? requestBody.scope : undefined;
      const parsed = parseRequestInput(reply, PersonalSkillScopeSchema, supplied);
      if (!parsed.ok) return parsed.response;
      if (mismatched(parsed.value, { tenantId, userId })) return reply.code(409).send(scopeError());
      return null;
    };

    routes.get("/me/skills", async (request, reply) => {
      const { tenantId, userId } = request.auth;
      const skills = await stores.personalSkills.list(tenantId, userId);
      privateReply(reply);
      return serialize(PersonalSkillsResponseSchema, { scope: scope(tenantId, userId), skills });
    });
    routes.post("/me/skills", async (request, reply) => {
      const { tenantId, userId } = request.auth;
      const scopeFailure = checkWriteScope(request.body, reply, tenantId, userId);
      if (scopeFailure) return scopeFailure;
      const body = parseRequestInput(reply, PersonalSkillCreateSchema, request.body);
      if (!body.ok) return body.response;
      const skill = await stores.personalSkills.create(tenantId, userId, body.value.source);
      privateReply(reply);
      return reply.code(201).send(serialize(PersonalSkillResponseSchema, { scope: scope(tenantId, userId), skill }));
    });
    routes.get("/me/skills/:skillId", async (request, reply) => {
      const params = parseRequestInput(reply, IdParams, request.params);
      if (!params.ok) return params.response;
      const { tenantId, userId } = request.auth;
      const skill = await stores.personalSkills.get(tenantId, userId, params.value.skillId);
      privateReply(reply);
      return serialize(PersonalSkillResponseSchema, { scope: scope(tenantId, userId), skill });
    });
    routes.put("/me/skills/:skillId", async (request, reply) => {
      const { tenantId, userId } = request.auth;
      const scopeFailure = checkWriteScope(request.body, reply, tenantId, userId);
      if (scopeFailure) return scopeFailure;
      const params = parseRequestInput(reply, IdParams, request.params);
      if (!params.ok) return params.response;
      const body = parseRequestInput(reply, PersonalSkillUpdateSchema, request.body);
      if (!body.ok) return body.response;
      const skill = await stores.personalSkills.update(tenantId, userId, params.value.skillId, body.value.source, body.value.version);
      privateReply(reply);
      return serialize(PersonalSkillResponseSchema, { scope: scope(tenantId, userId), skill });
    });
    routes.post("/me/skills/:skillId/action", async (request, reply) => {
      const { tenantId, userId } = request.auth;
      const scopeFailure = checkWriteScope(request.body, reply, tenantId, userId);
      if (scopeFailure) return scopeFailure;
      const params = parseRequestInput(reply, IdParams, request.params);
      if (!params.ok) return params.response;
      const body = parseRequestInput(reply, PersonalSkillActionSchema, request.body);
      if (!body.ok) return body.response;
      const skill = await stores.personalSkills.action(tenantId, userId, params.value.skillId, body.value.action, body.value.version);
      privateReply(reply);
      return serialize(PersonalSkillResponseSchema, { scope: scope(tenantId, userId), skill });
    });
    routes.delete("/me/skills/:skillId", async (request, reply) => {
      const { tenantId, userId } = request.auth;
      const scopeFailure = checkWriteScope(request.body, reply, tenantId, userId);
      if (scopeFailure) return scopeFailure;
      const params = parseRequestInput(reply, IdParams, request.params);
      if (!params.ok) return params.response;
      const body = parseRequestInput(reply, PersonalSkillDeleteSchema, request.body);
      if (!body.ok) return body.response;
      await stores.personalSkills.remove(tenantId, userId, params.value.skillId, body.value.version);
      privateReply(reply);
      return serialize(PersonalSkillDeleteResponseSchema, { scope: scope(tenantId, userId), deleted: true });
    });
    routes.get("/me/skills/:skillId/history", async (request, reply) => {
      const params = parseRequestInput(reply, IdParams, request.params);
      if (!params.ok) return params.response;
      const { tenantId, userId } = request.auth;
      const revisions = await stores.personalSkills.history(tenantId, userId, params.value.skillId);
      privateReply(reply);
      return serialize(PersonalSkillHistoryResponseSchema, { scope: scope(tenantId, userId), revisions });
    });
  });
}
