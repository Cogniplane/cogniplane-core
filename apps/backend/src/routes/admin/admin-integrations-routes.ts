import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  AdminIntegrationEnvelopeSchema,
  AdminIntegrationsListResponseSchema
} from "@cogniplane/shared-types";

import type { AppConfig } from "../../config.js";
import { encrypt } from "../../lib/crypto-utils.js";
import { apiError } from "../../lib/http-errors.js";
import { serialize } from "../../lib/serialize-response.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import {
  getIntegrationDescriptor,
  type IntegrationDescriptor
} from "../../services/integrations/integration-registry.js";
import type { IntegrationRegistryService } from "../../services/integrations/integration-registry-service.js";
import type { IntegrationStateStore } from "../../services/integrations/integration-state-store.js";
import type { RuntimeAdapter } from "../../runtime-contracts.js";
import type { RuntimeProvider } from "../../services/admin-config-records.js";
import {
  createAdminAuditEvent,
  respondAdminMutationError,
  respondAdminNotFound,
  withAdmin,
  parseAdminBody,
  parseAdminParams
} from "./admin-route-helpers.js";

export type AdminIntegrationsRouteStores = {
  config: AppConfig;
  integrationRegistry: IntegrationRegistryService;
  integrationStates: IntegrationStateStore;
  auditEvents: AuditEventStore;
  runtimeAdapters: Partial<Record<RuntimeProvider, RuntimeAdapter>>;
};

const integrationIdParamsSchema = z.object({
  integrationId: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/)
});

const updateIntegrationBodySchema = z.object({
  readsEnabled: z.boolean().optional(),
  writesEnabled: z.boolean().optional(),
  config: z.record(z.string(), z.string()).optional()
});

function encryptPasswordFields(
  descriptor: IntegrationDescriptor,
  rawConfig: Record<string, string>,
  existingConfig: Record<string, unknown>,
  encryptionSecret: string
): Record<string, unknown> {
  const next = { ...existingConfig };
  for (const [key, value] of Object.entries(rawConfig)) {
    const field = descriptor.configFields?.find((f) => f.key === key);
    if (!field) continue;
    if (field.type === "password") {
      // Empty string means "leave existing value alone" — frontend pattern:
      // password fields render with a placeholder and submit empty when
      // unchanged. Actual rotations send a non-empty new secret.
      if (value.length === 0) continue;
      next[key] = encrypt(value, encryptionSecret);
    } else {
      next[key] = value;
    }
  }
  return next;
}


async function invalidateAndAudit(
  stores: AdminIntegrationsRouteStores,
  request: import("fastify").FastifyRequest,
  integrationId: string
): Promise<void> {
  const tenantId = request.auth.tenantId;
  const collected = new Set<string>();
  for (const adapter of Object.values(stores.runtimeAdapters)) {
    if (!adapter?.invalidateIntegrationRuntimesForTenant) continue;
    const ids = await adapter.invalidateIntegrationRuntimesForTenant(tenantId, integrationId);
    for (const id of ids) collected.add(id);
  }
  if (collected.size > 0) {
    await createAdminAuditEvent(stores.auditEvents, {
      tenantId,
      userId: request.auth.userId,
      type: "tenant.integration.runtime_invalidated",
      payload: { integrationId, runtimeIds: [...collected] },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
  }
}

export async function registerAdminIntegrationsRoutes(
  app: FastifyInstance,
  stores: AdminIntegrationsRouteStores
): Promise<void> {
  app.get(
    "/admin/integrations",
    withAdmin(app, async (request, _reply) => {
      const integrations = await stores.integrationRegistry.getIntegrationsForAdmin(
        request.auth.tenantId
      );
      return serialize(AdminIntegrationsListResponseSchema, { integrations });
    })
  );

  app.put(
    "/admin/integrations/:integrationId",
    withAdmin(app, async (request, reply) => {
      const paramsResult = parseAdminParams(reply, integrationIdParamsSchema, request.params);
      if (!paramsResult.ok) return paramsResult.response;

      const bodyResult = parseAdminBody(reply, updateIntegrationBodySchema, request.body);
      if (!bodyResult.ok) return bodyResult.response;

      const { integrationId } = paramsResult.value;
      const descriptor = getIntegrationDescriptor(integrationId);
      if (!descriptor) {
        return respondAdminNotFound(reply, "integration_not_found");
      }

      if (descriptor.status === "coming_soon") {
        reply.code(400);
        return apiError("integration_unavailable", "Integration is not yet available.");
      }

      const existing = await stores.integrationStates.get(request.auth.tenantId, integrationId);
      const existingConfig = existing?.config ?? {};

      const nextConfig = bodyResult.value.config
        ? encryptPasswordFields(
            descriptor,
            bodyResult.value.config,
            existingConfig,
            stores.config.DATA_ENCRYPTION_SECRET
          )
        : existingConfig;

      const wantsReads = bodyResult.value.readsEnabled ?? existing?.readsEnabled ?? false;
      const wantsWrites = bodyResult.value.writesEnabled ?? existing?.writesEnabled ?? false;
      const ready =
        !wantsReads && !wantsWrites
          ? true
          : await stores.integrationRegistry.isReadyToEnable(
              request.auth.tenantId,
              integrationId,
              nextConfig
            );
      if (!ready) {
        reply.code(400);
        return apiError(
          "integration_config_required",
          "Required configuration fields are missing for this integration."
        );
      }

      try {
        const updated = await stores.integrationStates.upsert(
          request.auth.tenantId,
          integrationId,
          {
            readsEnabled: wantsReads,
            writesEnabled: wantsWrites,
            config: nextConfig,
            updatedBy: request.auth.userId
          }
        );

        await createAdminAuditEvent(stores.auditEvents, {
          tenantId: request.auth.tenantId,
          userId: request.auth.userId,
          type: "tenant.integration.updated",
          payload: {
            integrationId,
            readsEnabled: updated.readsEnabled,
            writesEnabled: updated.writesEnabled,
            configChanged: bodyResult.value.config !== undefined
          },
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"]
        });

        const togglesChanged =
          (existing?.readsEnabled ?? false) !== updated.readsEnabled ||
          (existing?.writesEnabled ?? false) !== updated.writesEnabled;
        if (togglesChanged) {
          await invalidateAndAudit(stores, request, integrationId);
        }

        const refreshed = await stores.integrationRegistry.getIntegrationsForAdmin(
          request.auth.tenantId
        );
        const integration = refreshed.find((entry) => entry.id === integrationId);
        return serialize(AdminIntegrationEnvelopeSchema, { integration });
      } catch (error) {
        return respondAdminMutationError(reply, error, "Failed to update integration.");
      }
    })
  );

  app.delete(
    "/admin/integrations/:integrationId/config",
    withAdmin(app, async (request, reply) => {
      const paramsResult = parseAdminParams(reply, integrationIdParamsSchema, request.params);
      if (!paramsResult.ok) return paramsResult.response;

      const { integrationId } = paramsResult.value;
      const descriptor = getIntegrationDescriptor(integrationId);
      if (!descriptor) {
        return respondAdminNotFound(reply, "integration_not_found");
      }

      try {
        await stores.integrationStates.clearConfig(
          request.auth.tenantId,
          integrationId,
          request.auth.userId
        );

        await createAdminAuditEvent(stores.auditEvents, {
          tenantId: request.auth.tenantId,
          userId: request.auth.userId,
          type: "tenant.integration.config_cleared",
          payload: { integrationId },
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"]
        });

        await invalidateAndAudit(stores, request, integrationId);

        const refreshed = await stores.integrationRegistry.getIntegrationsForAdmin(
          request.auth.tenantId
        );
        const integration = refreshed.find((entry) => entry.id === integrationId);
        return serialize(AdminIntegrationEnvelopeSchema, { integration });
      } catch (error) {
        return respondAdminMutationError(reply, error, "Failed to clear integration configuration.");
      }
    })
  );
}
