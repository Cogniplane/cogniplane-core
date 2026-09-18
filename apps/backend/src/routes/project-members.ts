import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ProjectSharingUpdateSchema, ProjectMemberUpdateSchema, ProjectMembersResponseSchema,
  ProjectMemberUpdateResponseSchema, ProjectOwnerRecoverySchema, OwnerlessProjectsResponseSchema
} from "@cogniplane/shared-types";
import type { ProjectMemberStore } from "../services/project-member-store.js";
import { ProjectAccessError } from "../services/project-access.js";
import { apiError } from "../lib/http-errors.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const memberParams = projectParams.extend({ userId: z.string().min(1).max(255) });

export async function registerProjectMemberRoutes(app: FastifyInstance, members: ProjectMemberStore) {
  await app.register(async routes => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ProjectAccessError) return reply.code(error.status).send(apiError(error.code, error.message));
      throw error;
    });
    routes.addHook("onRequest", async (_request, reply) => { reply.header("cache-control", "private, no-store"); });

    routes.get("/projects/:projectId/members", async (request, reply) => {
      const params = parseRequestInput(reply, projectParams, request.params);
      if (!params.ok) return params.response;
      return serialize(ProjectMembersResponseSchema, await members.list({ ...request.auth, ...params.value }));
    });
    routes.put("/projects/:projectId/sharing", async (request, reply) => {
      const params = parseRequestInput(reply, projectParams, request.params);
      if (!params.ok) return params.response;
      const body = parseRequestInput(reply, ProjectSharingUpdateSchema, request.body);
      if (!body.ok) return body.response;
      await members.setSharing({ ...request.auth, ...params.value }, body.value);
      return reply.code(204).send();
    });
    // A null explicit role removes membership. The response also names any
    // organization role that still grants access, including after self-removal.
    routes.put("/projects/:projectId/members/:userId", async (request, reply) => {
      const params = parseRequestInput(reply, memberParams, request.params);
      if (!params.ok) return params.response;
      const body = parseRequestInput(reply, ProjectMemberUpdateSchema, request.body);
      if (!body.ok) return body.response;
      return serialize(ProjectMemberUpdateResponseSchema, await members.setMember(
        { ...request.auth, projectId: params.value.projectId }, params.value.userId, body.value.role,
        { confirmRetainedRole: body.value.confirmRetainedRole }
      ));
    });
    routes.get("/admin/projects/ownerless", async (request) => {
      return serialize(OwnerlessProjectsResponseSchema, {
        projects: await members.listOwnerless(request.auth.tenantId, request.auth.userId)
      });
    });
    routes.post("/admin/projects/:projectId/recover-owner", async (request, reply) => {
      const params = parseRequestInput(reply, projectParams, request.params);
      if (!params.ok) return params.response;
      const body = parseRequestInput(reply, ProjectOwnerRecoverySchema, request.body);
      if (!body.ok) return body.response;
      await members.recoverOwner({ ...request.auth, ...params.value }, body.value.userId);
      return reply.code(204).send();
    });
  });
}
