import type { FastifyInstance } from "fastify";

import {
  ManagedToolsListResponseSchema,
  TenantSettingsEnvelopeSchema
} from "@cogniplane/shared-types";

import { apiError } from "../../lib/http-errors.js";
import { serialize } from "../../lib/serialize-response.js";
import { pruneUnknownModelIds } from "../../domain/model-availability.js";
import { AVAILABLE_MODELS } from "../../domain/models.js";
import type { DynamicConfigService } from "../../services/dynamic-config-service.js";
import { TenantSettingsConflictError } from "../../services/tenant-settings-store.js";
import type { ManagedToolCatalog } from "../../services/managed-tools/catalog.js";
import { tenantSettingsBodySchema } from "./admin-route-schemas.js";
import {
  respondAdminMutationError,
  withAdmin
} from "./admin-route-helpers.js";

export type TenantSettingsRouteStores = {
  dynamicConfig: Pick<DynamicConfigService, "getOrCreateTenantSettings" | "updateTenantSettings">;
  managedToolCatalog: Pick<ManagedToolCatalog, "listTenantConfigurable">;
  /**
   * The tenant's admin-added custom models (id + supported efforts are all
   * this route needs). Merged with AVAILABLE_MODELS when validating
   * enabledModelIds / modelDefaultEfforts so availability settings can
   * reference custom models. Optional: absent in minimal test wirings.
   */
  listCustomModels?: (
    tenantId: string
  ) => Promise<{ id: string; provider: import("@cogniplane/shared-types").ModelProvider; supportedEfforts: readonly string[] }[]>;
};

export async function registerAdminTenantSettingsRoutes(
  app: FastifyInstance,
  stores: TenantSettingsRouteStores
): Promise<void> {
  app.get("/admin/tenant-settings", withAdmin(app, async (request, _reply) => {
    const [settings, customModels] = await Promise.all([
      stores.dynamicConfig.getOrCreateTenantSettings(request.auth.tenantId),
      stores.listCustomModels ? stores.listCustomModels(request.auth.tenantId) : Promise.resolve([])
    ]);
    const knownModelIds = new Set([
      ...AVAILABLE_MODELS.map((m) => m.id),
      ...customModels.map((m) => m.id)
    ]);
    return serialize(TenantSettingsEnvelopeSchema, {
      settings: pruneUnknownModelIds(settings, knownModelIds)
    });
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
    if (parseResult.data.defaultModelId && !modelsById.has(parseResult.data.defaultModelId)) {
      return reply.status(400).send({
        error: "validation_error",
        message: `Unknown default model: ${parseResult.data.defaultModelId}`
      });
    }
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
    if (parseResult.data.enabledProviders !== undefined ||
        parseResult.data.enabledModelIds !== undefined ||
        parseResult.data.defaultModelId !== undefined) {
      const current = await stores.dynamicConfig.getOrCreateTenantSettings(request.auth.tenantId);
      const enabledProviders = parseResult.data.enabledProviders ?? current.enabledProviders;
      const enabledModelIds = parseResult.data.enabledModelIds === undefined
        ? current.enabledModelIds : parseResult.data.enabledModelIds;
      const effectiveDefaultId = parseResult.data.defaultModelId === undefined
        ? current.defaultModelId : parseResult.data.defaultModelId;
      if (effectiveDefaultId) {
        const provider = AVAILABLE_MODELS.find((item) => item.id === effectiveDefaultId)?.provider
          ?? customModels.find((item) => item.id === effectiveDefaultId)?.provider;
        const available = Boolean(provider && enabledProviders.includes(provider) &&
          (enabledModelIds === null || enabledModelIds.includes(effectiveDefaultId)));
        if (!available && parseResult.data.defaultModelId !== undefined) {
          return reply.status(400).send({
            error: "validation_error",
            message: "Enable the default model and its provider before selecting it."
          });
        }
        if (!available) {
          updateInput = { ...updateInput, defaultModelId: null };
        }
      }
      // The effective default was checked against this snapshot. Reject a
      // concurrent settings change rather than writing a stale decision.
      updateInput = { ...updateInput, expectedVersion: parseResult.data.expectedVersion ?? current.version };
    }
    if (request.auth.role !== "owner") {
      const current = await stores.dynamicConfig.getOrCreateTenantSettings(request.auth.tenantId);
      const sensitiveChanges =
        parseResult.data.allowCommandExecution !== undefined &&
        parseResult.data.allowCommandExecution !== current.allowCommandExecution;
      if (sensitiveChanges) {
        return reply.status(403).send(apiError("owner_required_for_sensitive_settings"));
      }

      // Admin forms submit the full settings snapshot. Remove unchanged
      // owner-only fields so an admin's stale form can never overwrite a
      // concurrent owner decision.
      const {
        allowCommandExecution: _allowCommandExecution,
        ...adminUpdateInput
      } = updateInput;
      updateInput = adminUpdateInput;
    }

    try {
      // The audit event commits in the same transaction as the change.
      const settings = await stores.dynamicConfig.updateTenantSettings(
        request.auth.tenantId,
        updateInput,
        (saved) => ({
          tenantId: request.auth.tenantId,
          sessionId: null,
          userId: request.auth.userId,
          type: "admin.tenant_settings.updated",
          payload: {
            showEffortSelector: saved.showEffortSelector,
            webSearchMode: saved.webSearchMode,
            approvalPolicy: saved.approvalPolicy,
            approvalReviewer: saved.approvalReviewer,
            allowCommandExecution: saved.allowCommandExecution,
            autoApproveReadOnlyTools: saved.autoApproveReadOnlyTools,
            policyEnforcementMode: saved.policyEnforcementMode,
            developerInstructions: saved.developerInstructions,
            enabledToolIds: saved.enabledToolIds,
            enabledMcpServerIds: saved.enabledMcpServerIds,
            enabledProviders: saved.enabledProviders,
            enabledModelIds: saved.enabledModelIds,
            defaultModelId: saved.defaultModelId,
            modelDefaultEfforts: saved.modelDefaultEfforts,
            approvedSandboxEgressDomains: saved.approvedSandboxEgressDomains,
            // Cached sessions compare the bundle hash and refresh capabilities
            // in place before their next turn. Do not dispose their E2B sandbox:
            // that would erase agent-created workspace files for a settings save.
            // One setting is the exception: the network of a sandbox is fixed when
            // it is created, so a sandbox that does not match the approved hosts is
            // replaced by the check at the start of the next turn.
            runtimeRefresh: "next_turn_in_place",
            version: saved.version,
            configHash: saved.configHash
          },
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"]
        })
      );
      return serialize(TenantSettingsEnvelopeSchema, { settings });
    } catch (error) {
      if (error instanceof TenantSettingsConflictError) {
        return reply.status(409).send({ error: "settings_conflict", message: error.message });
      }
      return respondAdminMutationError(reply, error, "Failed to update tenant settings.");
    }
  }));
}
