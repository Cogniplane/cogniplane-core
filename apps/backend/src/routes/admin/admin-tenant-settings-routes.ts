import type { FastifyInstance } from "fastify";

import {
  ManagedToolsListResponseSchema,
  TenantSettingsEnvelopeSchema
} from "@cogniplane/shared-types";

import { apiError } from "../../lib/http-errors.js";
import { serialize } from "../../lib/serialize-response.js";
import type { RuntimeAdapter } from "../../runtime-contracts.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { RuntimeProvider } from "../../services/admin-config-records.js";
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
  runtimeAdapters?: Partial<Record<RuntimeProvider, RuntimeAdapter>>;
};

class TenantRuntimeInvalidationError extends Error {
  constructor(
    message: string,
    readonly causes: unknown[]
  ) {
    super(message);
    this.name = "TenantRuntimeInvalidationError";
  }
}

async function invalidateTenantRuntimes(
  app: FastifyInstance,
  stores: TenantSettingsRouteStores,
  tenantId: string
): Promise<string[]> {
  const invalidated = new Set<string>();
  const failures: unknown[] = [];
  const results = await Promise.allSettled(
    Object.values(stores.runtimeAdapters ?? {}).map(async (adapter) => {
      if (!adapter?.invalidateTenantRuntimes) return [];
      return adapter.invalidateTenantRuntimes(tenantId);
    })
  );
  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const sessionId of result.value) invalidated.add(sessionId);
    } else {
      failures.push(result.reason);
      app.log.warn(
        { err: result.reason, tenantId },
        "tenant settings runtime invalidation failed"
      );
    }
  }
  if (failures.length > 0) {
    throw new TenantRuntimeInvalidationError(
      "Tenant settings were saved, but active runtimes could not be refreshed. Retry before relying on the new settings.",
      failures
    );
  }
  return [...invalidated];
}

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
      const invalidatedSessionIds = await invalidateTenantRuntimes(
        app,
        stores,
        request.auth.tenantId
      );
      await createAdminAuditEvent(stores.auditEvents, {
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        type: "admin.tenant_settings.updated",
        payload: {
          runtimeProvider: settings.runtimeProvider,
          enabledRuntimeProviders: settings.enabledRuntimeProviders,
          showEffortSelector: settings.showEffortSelector,
          webSearchMode: settings.webSearchMode,
          approvalPolicy: settings.approvalPolicy,
          approvalReviewer: settings.approvalReviewer,
          allowCommandExecution: settings.allowCommandExecution,
          allowUserTokenForwarding: settings.allowUserTokenForwarding,
          autoApproveReadOnlyTools: settings.autoApproveReadOnlyTools,
          policyEnforcementMode: settings.policyEnforcementMode,
          developerInstructions: settings.developerInstructions,
          enabledToolIds: settings.enabledToolIds,
          enabledMcpServerIds: settings.enabledMcpServerIds,
          invalidatedSessionIds,
          version: settings.version,
          configHash: settings.configHash
        },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
      return serialize(TenantSettingsEnvelopeSchema, { settings });
    } catch (error) {
      if (error instanceof TenantRuntimeInvalidationError) {
        return reply.status(503).send(
          apiError("runtime_refresh_failed", error.message)
        );
      }
      return respondAdminMutationError(reply, error, "Failed to update tenant settings.");
    }
  }));
}
