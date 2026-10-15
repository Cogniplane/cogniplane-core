import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  OrganizationSkillSubmissionCreateSchema, OrganizationSkillSubmissionDecisionSchema,
  OrganizationSkillSubmissionResubmitSchema, OrganizationSkillSubmissionResponseSchema,
  OrganizationSkillSubmissionReleaseSchema,
  OrganizationSkillSubmissionUpdatesQuerySchema, OrganizationSkillSubmissionUpdatesResponseSchema,
  OrganizationSkillSubmissionUpdateReadSchema, OrganizationSkillSubmissionUpdateReadResponseSchema,
  OrganizationSkillSubmissionsResponseSchema, OrganizationSkillSubmissionVersionSchema,
  PersonalSkillScopeSchema
} from "@cogniplane/shared-types";
import type { AppDependencies } from "../app-dependencies.js";
import { apiError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import { SubmissionAccessError, SubmissionConflictError, SubmissionNotFoundError,
  SubmissionValidationError } from "../services/skills/organization-skill-submission-store.js";

export type SubmissionStores = { organizationSkillSubmissions: AppDependencies["organizationSkillSubmissions"] };
const paramsSchema = z.object({ id: z.string().uuid() });
export async function registerOrganizationSkillSubmissionRoutes(app: FastifyInstance, stores: SubmissionStores) {
  await app.register(async routes => {
    routes.setErrorHandler((error, _request, reply) => {
      reply.header("cache-control", "private, no-store");
      if (error instanceof SubmissionAccessError) return reply.code(403).send(apiError("membership_required", error.message));
      if (error instanceof SubmissionNotFoundError) return reply.code(404).send(apiError("submission_not_found", error.message));
      if (error instanceof SubmissionConflictError) return reply.code(409).send(apiError("submission_conflict", error.message));
      if (error instanceof SubmissionValidationError) return reply.code(400).send(apiError("submission_invalid", error.message));
      throw error;
    });
    const scope = (tenantId: string, userId: string) => ({ tenantId, userId });
    const checkScope = (body: unknown, reply: Parameters<typeof parseRequestInput>[0], tenantId: string, userId: string) => {
      const supplied = typeof body === "object" && body !== null && "scope" in body ? body.scope : undefined;
      const result = parseRequestInput(reply, PersonalSkillScopeSchema, supplied);
      if (!result.ok) return result.response;
      if (result.value.tenantId !== tenantId || result.value.userId !== userId)
        return reply.code(409).send(apiError("submission_scope_changed", "Your account or organization changed. Reload before editing."));
      return null;
    };
    const detail = async (tenantId: string, userId: string, id: string, admin: boolean) =>
      serialize(OrganizationSkillSubmissionResponseSchema, { scope:scope(tenantId,userId),
        submission:await stores.organizationSkillSubmissions.get(tenantId,userId,id,admin) });
    routes.get("/me/skill-submissions", async (request, reply) => {
      const {tenantId,userId}=request.auth; reply.header("cache-control","private, no-store");
      return serialize(OrganizationSkillSubmissionsResponseSchema, {scope:scope(tenantId,userId),
        submissions:await stores.organizationSkillSubmissions.list(tenantId,userId,false)});
    });
    routes.get("/me/skill-submission-updates", async (request, reply) => {
      const query=parseRequestInput(reply,OrganizationSkillSubmissionUpdatesQuerySchema,request.query);
      if (!query.ok) return query.response;
      const {tenantId,userId}=request.auth; reply.header("cache-control","private, no-store");
      const updates=await stores.organizationSkillSubmissions.listUpdates(tenantId,userId,query.value.limit,query.value.before);
      return serialize(OrganizationSkillSubmissionUpdatesResponseSchema,{scope:scope(tenantId,userId),...updates});
    });
    routes.post("/me/skill-submission-updates/:id/read", async (request,reply) => {
      const {tenantId,userId}=request.auth;
      const failed=checkScope(request.body,reply,tenantId,userId); if(failed) return failed;
      const params=parseRequestInput(reply,paramsSchema,request.params); if(!params.ok) return params.response;
      const body=parseRequestInput(reply,OrganizationSkillSubmissionUpdateReadSchema,request.body);
      if(!body.ok) return body.response;
      const read=await stores.organizationSkillSubmissions.readUpdate(tenantId,userId,params.value.id);
      reply.header("cache-control","private, no-store");
      return serialize(OrganizationSkillSubmissionUpdateReadResponseSchema,{scope:scope(tenantId,userId),...read});
    });
    routes.post("/me/skill-submissions", async (request, reply) => {
      const {tenantId,userId}=request.auth;
      const failed=checkScope(request.body,reply,tenantId,userId); if (failed) return failed;
      const body=parseRequestInput(reply,OrganizationSkillSubmissionCreateSchema,request.body); if (!body.ok) return body.response;
      const id=await stores.organizationSkillSubmissions.create(tenantId,userId,body.value.personalSkillId,
        body.value.sourceRevision,body.value.note,body.value.targetOrganizationSkillId);
      reply.header("cache-control","private, no-store"); return reply.code(201).send(await detail(tenantId,userId,id,false));
    });
    routes.get("/me/skill-submissions/:id", async (request,reply) => {
      const params=parseRequestInput(reply,paramsSchema,request.params); if (!params.ok) return params.response;
      const {tenantId,userId}=request.auth; reply.header("cache-control","private, no-store"); return detail(tenantId,userId,params.value.id,false);
    });
    routes.post("/me/skill-submissions/:id/withdraw", async (request,reply) => {
      const {tenantId,userId}=request.auth; const failed=checkScope(request.body,reply,tenantId,userId); if(failed) return failed;
      const params=parseRequestInput(reply,paramsSchema,request.params); if(!params.ok) return params.response;
      const body=parseRequestInput(reply,OrganizationSkillSubmissionVersionSchema,request.body); if(!body.ok) return body.response;
      await stores.organizationSkillSubmissions.withdraw(tenantId,userId,params.value.id,body.value.version);
      reply.header("cache-control","private, no-store"); return detail(tenantId,userId,params.value.id,false);
    });
    routes.post("/me/skill-submissions/:id/resubmit", async (request,reply) => {
      const {tenantId,userId}=request.auth; const failed=checkScope(request.body,reply,tenantId,userId); if(failed) return failed;
      const params=parseRequestInput(reply,paramsSchema,request.params); if(!params.ok) return params.response;
      const body=parseRequestInput(reply,OrganizationSkillSubmissionResubmitSchema,request.body); if(!body.ok) return body.response;
      await stores.organizationSkillSubmissions.resubmit(tenantId,userId,params.value.id,body.value.version,body.value.sourceRevision,body.value.note);
      reply.header("cache-control","private, no-store"); return detail(tenantId,userId,params.value.id,false);
    });
    routes.get("/admin/skill-submissions", async (request,reply) => {
      const {tenantId,userId}=request.auth; reply.header("cache-control","private, no-store");
      return serialize(OrganizationSkillSubmissionsResponseSchema,{scope:scope(tenantId,userId),
        submissions:await stores.organizationSkillSubmissions.list(tenantId,userId,true)});
    });
    routes.get("/admin/skill-submissions/:id", async (request,reply) => {
      const params=parseRequestInput(reply,paramsSchema,request.params); if(!params.ok) return params.response;
      const {tenantId,userId}=request.auth; reply.header("cache-control","private, no-store"); return detail(tenantId,userId,params.value.id,true);
    });
    routes.post("/admin/skill-submissions/:id/decision", async (request,reply) => {
      const {tenantId,userId}=request.auth; const failed=checkScope(request.body,reply,tenantId,userId); if(failed) return failed;
      const params=parseRequestInput(reply,paramsSchema,request.params); if(!params.ok) return params.response;
      const body=parseRequestInput(reply,OrganizationSkillSubmissionDecisionSchema,request.body); if(!body.ok) return body.response;
      await stores.organizationSkillSubmissions.decide(tenantId,userId,params.value.id,body.value);
      reply.header("cache-control","private, no-store"); return detail(tenantId,userId,params.value.id,true);
    });
    routes.post("/admin/skill-submissions/:id/release", async (request,reply) => {
      const {tenantId,userId}=request.auth; const failed=checkScope(request.body,reply,tenantId,userId); if(failed) return failed;
      const params=parseRequestInput(reply,paramsSchema,request.params); if(!params.ok) return params.response;
      const body=parseRequestInput(reply,OrganizationSkillSubmissionReleaseSchema,request.body); if(!body.ok) return body.response;
      await stores.organizationSkillSubmissions.release(tenantId,userId,params.value.id,body.value);
      reply.header("cache-control","private, no-store"); return detail(tenantId,userId,params.value.id,true);
    });
  });
}
