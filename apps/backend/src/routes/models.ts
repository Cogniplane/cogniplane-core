import type { FastifyInstance } from "fastify";

import { ModelsListResponseSchema } from "@cogniplane/shared-types";
import type { ModelProvider } from "@cogniplane/shared-types";

import type { AppDependencies } from "../app-dependencies.js";
import { AVAILABLE_MODELS } from "../domain/models.js";
import { listEnabledModels, withEffectiveDefaultEffort } from "../domain/model-availability.js";
import { toAvailableModel } from "../services/custom-model-store.js";
import { serialize } from "../lib/serialize-response.js";

export function buildModelRouteStores(
  deps: AppDependencies,
  extras: {
    /** The providers the tenant currently has a key for (tenant or platform). */
    configuredProviders: (tenantId: string) => Promise<Set<ModelProvider>>;
  }
) {
  return {
    dynamicConfig: deps.dynamicConfig,
    customModels: deps.customModels,
    runtimeAdapter: deps.runtimeAdapter,
    configuredProviders: extras.configuredProviders
  };
}

export type ModelRouteStores = ReturnType<typeof buildModelRouteStores>;

export async function registerModelRoutes(app: FastifyInstance, stores: ModelRouteStores): Promise<void> {
  app.get("/models", async (request) => {
    const tenantId = request.auth.tenantId;

    // A model is selectable iff the admin enabled its provider and the model
    // itself (tenant_settings), AND a key is configured for that provider
    // (server- or tenant-level). An empty list is the "configure a model
    // provider key" empty state. The catalog is built-ins merged with the
    // tenant's admin-added custom models.
    const [configured, settings, customs] = await Promise.all([
      stores.configuredProviders(tenantId),
      stores.dynamicConfig.getOrCreateTenantSettings(tenantId),
      stores.customModels ? stores.customModels.list(tenantId) : Promise.resolve([])
    ]);
    const catalog = [...AVAILABLE_MODELS, ...customs.map(toAvailableModel)];
    const models = listEnabledModels(settings, catalog)
      .filter((model) => configured.has(model.provider))
      .map((model) => withEffectiveDefaultEffort(model, settings));

    return serialize(ModelsListResponseSchema, {
      models,
      showEffortSelector: models.length > 0 ? settings.showEffortSelector : false
    });
  });
}
