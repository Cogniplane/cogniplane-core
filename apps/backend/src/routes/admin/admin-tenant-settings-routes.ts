import type { FastifyInstance } from "fastify";

import {
  ManagedToolsListResponseSchema,
  TenantSettingsEnvelopeSchema
} from "@cogniplane/shared-types";

import { apiError } from "../../lib/http-errors.js";
import { serialize } from "../../lib/serialize-response.js";
import { AVAILABLE_MODELS } from "../../domain/models.js";
import type { RuntimeAdapter } from "../../runtime-contracts.js";
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
  runtimeAdapter: RuntimeAdapter;
  /**
   * The tenant's admin-added custom models (id + supported efforts are all
   * this route needs). Merged with AVAILABLE_MODELS when validating
   * enabledModelIds / modelDefaultEfforts so availability settings can
   * reference custom models. Optional: absent in minimal test wirings.
   */
  listCustomModels?: (
    tenantId: string
  ) => Promise<{ id: string; supportedEfforts: readonly string[] }[]>;
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
  // Deep Agents is the sole adapter, so this is a single direct call — the old
  // Promise.allSettled fan-out existed to tolerate one provider failing among
  // several. The settings row is already persisted by the caller; a failure
  // here means the live runtimes still hold the old config, so surface it as a
  // retryable error rather than silently reporting success.
  try {
    return await stores.runtimeAdapter.invalidateTenantRuntimes(tenantId);
  } catch (err) {
    app.log.warn({ err, tenantId }, "tenant settings runtime invalidation failed");
    throw new TenantRuntimeInvalidationError(
      "Tenant settings were saved, but active runtimes could not be refreshed. Retry before relying on the new settings.",
      [err]
    );
  }
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

    // Semantic validation against the model catalog (the zod schema only
    // checks shapes): unknown model ids are rejected rather than silently
    // stored, and a default effort must be one the model actually supports.
    // The catalog here is built-ins + the tenant's custom models.
    const customModels = stores.listCustomModels
      ? await stores.listCustomModels(request.auth.tenantId)
      : [];
    const modelsById = new Map<string, { supportedEfforts: readonly string[] }>([
      ...AVAILABLE_MODELS.map((m) => [m.id, m] as const),
      ...customModels.map((m) => [m.id, m] as const)
    ]);
    const unknownIds = (parseResult.data.enabledModelIds ?? []).filter(
      (id) => !modelsById.has(id)
    );
    if (unknownIds.length > 0) {
      return reply.status(400).send({
        error: "validation_error",
        message: `Unknown model ids: ${unknownIds.join(", ")}`
      });
    }
    for (const [modelId, effort] of Object.entries(parseResult.data.modelDefaultEfforts ?? {})) {
      const model = modelsById.get(modelId);
      if (!model) {
        return reply.status(400).send({
          error: "validation_error",
          message: `Unknown model id in modelDefaultEfforts: ${modelId}`
        });
      }
      if (!model.supportedEfforts.includes(effort)) {
        return reply.status(400).send({
          error: "validation_error",
          message: `Effort "${effort}" is not supported by model "${modelId}".`
        });
      }
    }

    let updateInput = parseResult.data;
    if (request.auth.role !== "owner") {
      const current = await stores.dynamicConfig.getOrCreateTenantSettings(request.auth.tenantId);
      const sensitiveChanges =
        (parseResult.data.allowCommandExecution !== undefined &&
          parseResult.data.allowCommandExecution !== current.allowCommandExecution) ||
        (parseResult.data.allowUserTokenForwarding !== undefined &&
          parseResult.data.allowUserTokenForwarding !== current.allowUserTokenForwarding);
      if (sensitiveChanges) {
        return reply.status(403).send(apiError("owner_required_for_sensitive_settings"));
      }

      // Admin forms submit the full settings snapshot. Remove unchanged
      // owner-only fields so an admin's stale form can never overwrite a
      // concurrent owner decision.
      const {
        allowCommandExecution: _allowCommandExecution,
        allowUserTokenForwarding: _allowUserTokenForwarding,
        ...adminUpdateInput
      } = parseResult.data;
      updateInput = adminUpdateInput;
    }

    try {
      const settings = await stores.dynamicConfig.updateTenantSettings(
        request.auth.tenantId,
        updateInput
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
          enabledProviders: settings.enabledProviders,
          enabledModelIds: settings.enabledModelIds,
          modelDefaultEfforts: settings.modelDefaultEfforts,
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
