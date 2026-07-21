import type { FastifyInstance } from "fastify";

import { MODEL_PROVIDERS } from "@cogniplane/shared-types";
import type { ModelProvider } from "@cogniplane/shared-types";

import { registerAdminArtifactRoutes } from "./admin/admin-artifact-routes.js";
import { registerAdminIntegrationsRoutes } from "./admin/admin-integrations-routes.js";
import { registerAdminMcpServerRoutes } from "./admin/admin-mcp-server-routes.js";
import { registerAdminModelRoutes } from "./admin/admin-model-routes.js";
import { registerAdminPiiRoutes } from "./admin/admin-pii-routes.js";
import { registerAdminPolicyRoutes } from "./admin/admin-policy-routes.js";
import { registerAdminRuntimeRoutes } from "./admin/admin-runtime-routes.js";
import { registerAdminSessionDetailRoute } from "./admin/admin-session-detail.js";
import { registerAdminSessionRoutes } from "./admin/admin-session-routes.js";
import { registerAdminSkillRoutes } from "./admin/admin-skill-routes.js";
import { registerAdminTenantSettingsRoutes } from "./admin/admin-tenant-settings-routes.js";
import { registerAdminTokenUsageRoutes } from "./admin/admin-token-usage-routes.js";
import { registerAdminUserRoutes } from "./admin/admin-user-routes.js";
import type { AppConfig } from "../config.js";
import type { AppDependencies } from "../app-dependencies.js";
import { buildOpenRouterCatalogFetcher } from "../services/openrouter-catalog.js";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function buildAdminRouteStores(
  deps: AppDependencies,
  extras: {
    config: AppConfig;
  }
) {
  const tenantSettings = {
    async getMarketplaceManifestUrl(tenantId: string): Promise<string | null> {
      return (await deps.tenantOrgSettings.get(tenantId)).skillMarketplaceManifestUrl;
    }
  };

  // Per-provider key source for GET /admin/models: a tenant-stored key wins
  // over the platform env fallback, matching credential resolution order.
  const providerKeySources = async (tenantId: string) => {
    const orgSettings = await deps.tenantOrgSettings.get(tenantId);
    return Object.fromEntries(
      MODEL_PROVIDERS.map((provider) => [
        provider,
        orgSettings.providerKeys[provider]
          ? "tenant"
          : deps.providerCredentials.platformProviders.has(provider)
            ? "platform"
            : "none"
      ])
    ) as Record<ModelProvider, "tenant" | "platform" | "none">;
  };

  return {
    config: extras.config,
    dynamicConfig: deps.dynamicConfig,
    skillMarketplace: deps.skillMarketplace,
    auditEvents: deps.auditEvents,
    skillBundleStorage: deps.skillBundleStorage,
    runtimeSessions: deps.runtimeSessions,
    deepAgentsAdapter: deps.deepAgentsAdapter,
    runtimeAdapter: deps.runtimeAdapter,
    tenantMembers: deps.tenantMembers,
    githubConnections: deps.githubConnectionService,
    integrationRegistry: deps.integrationRegistry,
    integrationStates: deps.integrationStates,
    tenantSettings,
    providerKeySources,
    customModels: deps.customModels,
    // One process-wide cached fetcher: the OpenRouter catalog is global, not
    // tenant-scoped, so all tenants share the cache.
    fetchOpenRouterCatalog: buildOpenRouterCatalogFetcher(),
    activations: deps.activationTracker,
    piiCircuitBreaker: deps.piiCircuitBreaker,
    piiProtection: deps.piiProtection,
    piiAnalytics: deps.piiAnalytics,
    platformEvents: deps.platformEvents,
    managedToolCatalog: deps.managedToolCatalog,
    policyRules: deps.policyRules,
    policyDecisions: deps.policyDecisions,
    policyService: deps.policyService
  };
}

export type AdminRouteStores = ReturnType<typeof buildAdminRouteStores>;

export async function registerAdminRoutes(
  app: FastifyInstance,
  stores: AdminRouteStores
): Promise<void> {
  await registerAdminSkillRoutes(app, {
    dynamicConfig: stores.dynamicConfig,
    skillMarketplace: stores.skillMarketplace,
    auditEvents: stores.auditEvents,
    skillBundleStorage: stores.skillBundleStorage,
    githubConnections: stores.githubConnections,
    tenantSettings: stores.tenantSettings,
    activations: stores.activations
  });
  await registerAdminUserRoutes(app, {
    tenantMembers: stores.tenantMembers,
    auditEvents: stores.auditEvents
  });
  await registerAdminTokenUsageRoutes(app);
  await registerAdminSessionRoutes(app);
  await registerAdminSessionDetailRoute(app);
  await registerAdminArtifactRoutes(app, { auditEvents: stores.auditEvents });
  await registerAdminRuntimeRoutes(app, {
    auditEvents: stores.auditEvents,
    runtimeSessions: stores.runtimeSessions,
    deepAgentsAdapter: stores.deepAgentsAdapter
  });
  if (stores.piiCircuitBreaker) {
    await registerAdminPiiRoutes(app, {
      piiCircuitBreaker: stores.piiCircuitBreaker,
      piiProtection: stores.piiProtection,
      piiAnalytics: stores.piiAnalytics,
      platformEvents: stores.platformEvents
    });
  }
  await registerAdminTenantSettingsRoutes(app, {
    dynamicConfig: stores.dynamicConfig,
    auditEvents: stores.auditEvents,
    managedToolCatalog: stores.managedToolCatalog,
    runtimeAdapter: stores.runtimeAdapter,
    // Custom models never advertise reasoning efforts (see CustomModelStore).
    // Guarded: test wirings pass partial store literals without customModels.
    listCustomModels: stores.customModels
      ? async (tenantId) =>
          (await stores.customModels.list(tenantId)).map((record) => ({
            id: record.modelId,
            supportedEfforts: []
          }))
      : undefined
  });
  await registerAdminModelRoutes(app, {
    customModels: stores.customModels,
    dynamicConfig: stores.dynamicConfig,
    auditEvents: stores.auditEvents,
    providerKeySources: stores.providerKeySources,
    fetchOpenRouterCatalog: stores.fetchOpenRouterCatalog
  });
  await registerAdminPolicyRoutes(app, {
    policyRules: stores.policyRules,
    policyDecisions: stores.policyDecisions,
    policyService: stores.policyService,
    auditEvents: stores.auditEvents
  });
  await registerAdminIntegrationsRoutes(app, {
    config: stores.config,
    integrationRegistry: stores.integrationRegistry,
    integrationStates: stores.integrationStates,
    auditEvents: stores.auditEvents,
    runtimeAdapter: stores.runtimeAdapter
  });

  await registerAdminMcpServerRoutes(app, {
    dynamicConfig: stores.dynamicConfig,
    auditEvents: stores.auditEvents,
    activations: stores.activations
  });
}
