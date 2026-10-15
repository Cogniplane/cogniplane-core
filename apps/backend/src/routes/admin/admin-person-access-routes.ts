import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AdminPersonAccessResponseSchema } from "@cogniplane/shared-types";
import { apiError } from "../../lib/http-errors.js";
import { serialize } from "../../lib/serialize-response.js";
import { adminIdSchema, withAdmin } from "./admin-route-helpers.js";
import { PersonAccessMemberNotFound, type PersonAccessService } from "../../services/person-access-service.js";
import { PersonalCapabilityAccessError } from "../../services/personal-capability-store.js";
import { MemberMcpAccessError } from "../../services/member-mcp-credential-store.js";

export async function registerAdminPersonAccessRoutes(app: FastifyInstance, service: Pick<PersonAccessService, "explain">) {
  app.get("/admin/users/:userId/skills-connections", withAdmin(app, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ userId: adminIdSchema }).safeParse(request.params);
    if (!params.success || !z.object({}).strict().safeParse(request.query).success) {
      return reply.code(400).send(apiError("invalid_request"));
    }
    try {
      return serialize(AdminPersonAccessResponseSchema,
        await service.explain(request.auth.tenantId, params.data.userId));
    } catch (error) {
      if (error instanceof PersonAccessMemberNotFound || error instanceof PersonalCapabilityAccessError || error instanceof MemberMcpAccessError) {
        return reply.code(404).send(apiError("member_not_found"));
      }
      request.log.error({ err: error }, "Person access lookup failed");
      return reply.code(503).send(apiError("lookup_unavailable"));
    }
  }));
}
