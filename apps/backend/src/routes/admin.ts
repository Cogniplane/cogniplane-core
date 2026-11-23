import type { FastifyInstance } from "fastify";

import type { AppDependencies } from "../app-dependencies.js";
import type { AppConfig } from "../config.js";
import type { DataRouteControl } from "../services/data-route-control.js";
import { PersonAccessService } from "../services/person-access-service.js";
import { registerAdminArtifactRoutes } from "./admin/admin-artifact-routes.js";
import { registerAdminHistoryRoutes } from "./admin/admin-history-routes.js";
import {
  buildAdminIntegrationsRouteStores,
  registerAdminIntegrationsRoutes,
  type AdminIntegrationsRouteStores
} from "./admin/admin-integrations-routes.js";
import {
  buildAdminMcpServerRouteStores,
  registerAdminMcpServerRoutes,
  type AdminMcpServerRouteStores
} from "./admin/admin-mcp-server-routes.js";
import {
  buildAdminModelRouteStores,
  registerAdminModelRoutes,
  type ModelAdminRouteStores
} from "./admin/admin-model-routes.js";
import {
  registerAdminModelSpendingRoutes,
  type AdminModelSpendingRouteStores
} from "./admin/admin-model-spending-routes.js";
import {
  registerAdminPersonAccessRoutes,
  type AdminPersonAccessRouteStores
} from "./admin/admin-person-access-routes.js";
import {
  buildAdminPiiRouteStores,
  registerAdminPiiRoutes,
  type AdminPiiRouteStores
} from "./admin/admin-pii-routes.js";
import {
  buildAdminPolicyRouteStores,
  registerAdminPolicyRoutes,
  type PolicyRouteStores
} from "./admin/admin-policy-routes.js";
import {
  buildAdminRuntimeRouteStores,
  registerAdminRuntimeRoutes,
  type AdminRuntimeRouteStores
} from "./admin/admin-runtime-routes.js";
import { registerAdminSessionDetailRoute } from "./admin/admin-session-detail.js";
import { registerAdminSessionRoutes } from "./admin/admin-session-routes.js";
import {
  buildAdminSkillRouteStores,
  registerAdminSkillRoutes,
  type AdminSkillRouteStores
} from "./admin/admin-skill-routes.js";
import {
  buildAdminTenantSettingsRouteStores,
  registerAdminTenantSettingsRoutes,
  type TenantSettingsRouteStores
} from "./admin/admin-tenant-settings-routes.js";
import { registerAdminTokenUsageRoutes } from "./admin/admin-token-usage-routes.js";
import {
  buildAdminUserRouteStores,
  registerAdminUserRoutes,
  type AdminUserRouteStores
} from "./admin/admin-user-routes.js";

/**
 * The admin routes' dependencies, one entry for each feature. Each feature
 * file owns the type of its entry and the function that builds it, so a
 * feature's wiring changes and is tested without the other features.
 */
export type AdminRouteFeatures = {
  skills: AdminSkillRouteStores;
  users: AdminUserRouteStores;
  /** Absent in a test: the route is not registered. */
  personAccess?: AdminPersonAccessRouteStores;
  /** Absent in a test: the routes are not registered. */
  modelSpending?: AdminModelSpendingRouteStores;
  runtime: AdminRuntimeRouteStores;
  /** Absent in a test: the routes are not registered. */
  pii?: AdminPiiRouteStores;
  tenantSettings: TenantSettingsRouteStores;
  models: ModelAdminRouteStores;
  policy: PolicyRouteStores;
  integrations: AdminIntegrationsRouteStores;
  mcpServers: AdminMcpServerRouteStores;
};

export function buildAdminRouteFeatures(
  deps: AppDependencies,
  extras: {
    config: AppConfig;
    /**
     * Step-up and owner notice of the data routes (tenant settings, MCP
     * servers, integrations), of a Policy Center change that makes the policy
     * weaker, and of a skill release.
     */
    dataRoutes: DataRouteControl;
  }
): AdminRouteFeatures {
  return {
    skills: buildAdminSkillRouteStores(deps, extras),
    users: buildAdminUserRouteStores(deps),
    personAccess: new PersonAccessService(deps),
    modelSpending: deps.modelSpending,
    runtime: buildAdminRuntimeRouteStores(deps),
    pii: buildAdminPiiRouteStores(deps),
    tenantSettings: buildAdminTenantSettingsRouteStores(deps, extras),
    models: buildAdminModelRouteStores(deps),
    policy: buildAdminPolicyRouteStores(deps, extras),
    integrations: buildAdminIntegrationsRouteStores(deps, extras),
    mcpServers: buildAdminMcpServerRouteStores(deps, extras)
  };
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  features: AdminRouteFeatures
): Promise<void> {
  await registerAdminSkillRoutes(app, features.skills);
  await registerAdminUserRoutes(app, features.users);
  if (features.personAccess) await registerAdminPersonAccessRoutes(app, features.personAccess);
  await registerAdminTokenUsageRoutes(app);
  await registerAdminHistoryRoutes(app);
  if (features.modelSpending) await registerAdminModelSpendingRoutes(app, features.modelSpending);
  await registerAdminSessionRoutes(app);
  await registerAdminSessionDetailRoute(app);
  await registerAdminArtifactRoutes(app);
  await registerAdminRuntimeRoutes(app, features.runtime);
  if (features.pii) await registerAdminPiiRoutes(app, features.pii);
  await registerAdminTenantSettingsRoutes(app, features.tenantSettings);
  await registerAdminModelRoutes(app, features.models);
  await registerAdminPolicyRoutes(app, features.policy);
  await registerAdminIntegrationsRoutes(app, features.integrations);
  await registerAdminMcpServerRoutes(app, features.mcpServers);
}
