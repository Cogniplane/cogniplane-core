import type { FastifyInstance } from "fastify";

import { registerAdminArtifactRoutes } from "./admin/admin-artifact-routes.js";
import { registerAdminIntegrationsRoutes } from "./admin/admin-integrations-routes.js";
import { registerAdminMcpServerRoutes } from "./admin/admin-mcp-server-routes.js";
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

  return {
    config: extras.config,
    dynamicConfig: deps.dynamicConfig,
    skillMarketplace: deps.skillMarketplace,
    auditEvents: deps.auditEvents,
    skillBundleStorage: deps.skillBundleStorage,
    runtimeSessions: deps.runtimeSessions,
    runtimeManager: deps.runtimeManager,
    runtimeAdapters: deps.runtimeAdapters,
    tenantMembers: deps.tenantMembers,
    githubConnections: deps.githubConnectionService,
    integrationRegistry: deps.integrationRegistry,
    integrationStates: deps.integrationStates,
    tenantSettings,
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
  await registerAdminArtifactRoutes(app);
  await registerAdminRuntimeRoutes(app, {
    auditEvents: stores.auditEvents,
    runtimeSessions: stores.runtimeSessions,
    runtimeManager: stores.runtimeManager
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
    runtimeAdapters: stores.runtimeAdapters
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
    runtimeAdapters: stores.runtimeAdapters
  });

  await registerAdminMcpServerRoutes(app, {
    dynamicConfig: stores.dynamicConfig,
    auditEvents: stores.auditEvents,
    activations: stores.activations
  });
}
