import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  AdminUserEnvelopeSchema,
  AdminUsersListResponseSchema
} from "@cogniplane/shared-types";

import { serialize } from "../../lib/serialize-response.js";
import {
  adminIdSchema,
  createAdminAuditEvent,
  parseAdminBody,
  parseAdminParams,
  respondAdminMutationError,
  respondAdminNotFound,
  withAdmin
} from "./admin-route-helpers.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { TenantMemberStore } from "../../services/tenant-member-store.js";

const userIdParamsSchema = z.object({ userId: adminIdSchema });
const setBetaTesterBodySchema = z.object({
  isBetaTester: z.boolean()
});

export async function registerAdminUserRoutes(
  app: FastifyInstance,
  stores: {
    tenantMembers: TenantMemberStore;
    auditEvents: AuditEventStore;
  }
): Promise<void> {
  app.get("/admin/users", withAdmin(app, async (request) => {
    const users = await stores.tenantMembers.listTenantMembers(request.auth.tenantId);
    return serialize(AdminUsersListResponseSchema, { users });
  }));

  app.post("/admin/users/:userId/set-beta-tester", withAdmin(app, async (request, reply) => {
    const paramsResult = parseAdminParams(reply, userIdParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const bodyResult = parseAdminBody(reply, setBetaTesterBodySchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    try {
      const user = await stores.tenantMembers.setUserBetaTester(
        request.auth.tenantId,
        paramsResult.value.userId,
        bodyResult.value.isBetaTester
      );

      if (!user) {
        return respondAdminNotFound(reply, "user_not_found");
      }

      await createAdminAuditEvent(stores.auditEvents, {
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        type: "admin.user.beta_tester_updated",
        payload: {
          targetUserId: user.userId,
          isBetaTester: user.isBetaTester
        },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });

      return serialize(AdminUserEnvelopeSchema, { user });
    } catch (error) {
      return respondAdminMutationError(reply, error, "Failed to update user beta tester status.");
    }
  }));
}
