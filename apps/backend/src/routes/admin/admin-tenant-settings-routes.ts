import type { FastifyInstance } from "fastify";

import {
  ManagedToolsListResponseSchema,
  TenantSettingsEnvelopeSchema
} from "@cogniplane/shared-types";

import { serialize } from "../../lib/serialize-response.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { DynamicConfigService } from "../../services/dynamic-config-service.js";
import type { ManagedToolCatalog } from "../../services/managed-tools/catalog.js";
import { tenantSettingsBodySchema } from "./admin-route-schemas.js";
import {
  createAdminAuditEvent,
  respondAdminMutationError,
  withAdmin
} from "./admin-route-helpers.js";

export type TenantSettingsRouteStores = {
  dynamicConfig: DynamicConfigService;
  auditEvents: AuditEventStore;
  managedToolCatalog: ManagedToolCatalog;
};

export async function registerAdminTenantSettingsRoutes(
  app: FastifyInstance,
  stores: TenantSettingsRouteStores
): Promise<void> {
  app.get("/admin/tenant-settings", withAdmin(app, async (request, _reply) => {
    const settings = await stores.dynamicConfig.getOrCreateTenantSettings(request.auth.tenantId);
    return serialize(TenantSettingsEnvelopeSchema, { settings });
  }));

  app.get("/admin/managed-tools", withAdmin(app, async (_request, _reply) => {
    return serialize(ManagedToolsListResponseSchema, {
      tools: stores.managedToolCatalog.listTenantConfigurable().map((tool) => ({
        id: tool.name,
        description: tool.description,
        readOnly: tool.readOnly
      }))
    });
  }));

  app.put("/admin/tenant-settings", withAdmin(app, async (request, reply) => {
    const parseResult = tenantSettingsBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "validation_error",
        message: parseResult.error.issues.map((issue) => issue.message).join(", ")
      });
    }

    try {
      const settings = await stores.dynamicConfig.updateTenantSettings(
        request.auth.tenantId,
        parseResult.data
      );
      await createAdminAuditEvent(stores.auditEvents, {
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        type: "admin.tenant_settings.updated",
        payload: {
          runtimeProvider: settings.runtimeProvider,
          enabledRuntimeProviders: settings.enabledRuntimeProviders,
          showEffortSelector: settings.showEffortSelector,
          approvalPolicy: settings.approvalPolicy,
          approvalReviewer: settings.approvalReviewer,
          allowCommandExecution: settings.allowCommandExecution,
          allowUserTokenForwarding: settings.allowUserTokenForwarding,
          autoApproveReadOnlyTools: settings.autoApproveReadOnlyTools,
          developerInstructions: settings.developerInstructions,
          enabledToolIds: settings.enabledToolIds,
          enabledMcpServerIds: settings.enabledMcpServerIds,
          version: settings.version,
          configHash: settings.configHash
        },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
      return serialize(TenantSettingsEnvelopeSchema, { settings });
    } catch (error) {
      return respondAdminMutationError(reply, error, "Failed to update tenant settings.");
    }
  }));
}
