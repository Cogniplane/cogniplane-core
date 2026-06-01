import type { FastifyInstance } from "fastify";

import { registerAdminArtifactRoutes } from "./admin/admin-artifact-routes.js";
import { registerAdminCrud } from "./admin/admin-crud-routes.js";
import { registerAdminIntegrationsRoutes } from "./admin/admin-integrations-routes.js";
import { registerAdminPiiRoutes } from "./admin/admin-pii-routes.js";
import { registerAdminPolicyRoutes } from "./admin/admin-policy-routes.js";
import { registerAdminRuntimeRoutes } from "./admin/admin-runtime-routes.js";
import { mcpBodySchema } from "./admin/admin-route-schemas.js";
import { registerAdminSessionDetailRoute } from "./admin/admin-session-detail.js";
import { registerAdminSessionRoutes } from "./admin/admin-session-routes.js";
import { registerAdminSkillRoutes } from "./admin/admin-skill-routes.js";
import { registerAdminTenantSettingsRoutes } from "./admin/admin-tenant-settings-routes.js";
import { registerAdminTokenUsageRoutes } from "./admin/admin-token-usage-routes.js";
import { registerAdminUserRoutes } from "./admin/admin-user-routes.js";
import {
  adminIdSchema,
  createAdminAuditEvent,
  parseAdminParams,
  respondAdminMutationError,
  respondAdminNotFound,
  withAdmin
} from "./admin/admin-route-helpers.js";
import { z } from "zod";
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

  // --- MCP Servers CRUD ---
  const MCP_ACTIVATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  registerAdminCrud(app, stores.auditEvents, {
    resource: "mcp-servers",
    bodySchema: mcpBodySchema,
    idField: "serverId",
    listKey: "mcpServers",
    entityName: "mcpServer",
    auditPrefix: "admin.mcp_server",
    conflictMessage: "MCP server ID already exists.",
    updateErrorMessage: "Invalid MCP server configuration.",
    disableErrorMessage: "MCP server cannot be disabled.",
    decorateList: stores.activations
      ? async (tenantId, records) => {
          try {
            const counts = await stores.activations!.countMcpServerActivations(
              tenantId,
              MCP_ACTIVATION_WINDOW_MS
            );
            return records.map((server) => {
              const entry = counts.get(String((server as Record<string, unknown>).serverId));
              return {
                ...server,
                invokedSessions30d: entry?.invokedSessions ?? 0,
                materializedSessions30d: entry?.materializedSessions ?? 0
              };
            });
          } catch (err) {
            app.log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "admin mcp-servers: failed to read activation counts; returning servers without counts"
            );
            return records;
          }
        }
      : undefined,
    store: {
      list: (tenantId, includeDisabled) => stores.dynamicConfig.listMcpServers(tenantId, includeDisabled),
      create: stores.dynamicConfig.createMcpServer.bind(stores.dynamicConfig),
      update: stores.dynamicConfig.updateMcpServer.bind(stores.dynamicConfig),
      disable: stores.dynamicConfig.disableMcpServer.bind(stores.dynamicConfig)
    },
    toCreateInput: (body, userId) => ({
      ...body,
      // serverId presence is validated by the factory before toCreateInput is called
      serverId: body.serverId!,
      description: body.description ?? null,
      upstreamUrl: body.upstreamUrl ?? null,
      actorUserId: userId
    }),
    toUpdateInput: (body, id) => ({
      serverId: id,
      serverName: body.serverName,
      description: body.description ?? null,
      transportKind: body.transportKind,
      mode: body.mode,
      routePath: body.routePath,
      upstreamUrl: body.upstreamUrl ?? null,
      headersAllowlist: body.headersAllowlist,
      enabled: body.enabled
    })
  });

  // --- MCP Servers publish/unpublish ---
  const mcpServerIdParamsSchema = z.object({ serverId: adminIdSchema });

  app.post("/admin/mcp-servers/:serverId/publish", withAdmin(app, async (request, reply) => {
    const paramsResult = parseAdminParams(reply, mcpServerIdParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    try {
      const mcpServer = await stores.dynamicConfig.setMcpServerPublished(
        request.auth.tenantId,
        paramsResult.value.serverId,
        true
      );
      if (!mcpServer) {
        return respondAdminNotFound(reply, "mcp_server_not_found");
      }

      await createAdminAuditEvent(stores.auditEvents, {
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        type: "admin.mcp_server.published",
        payload: { serverId: mcpServer.serverId, version: mcpServer.version },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });

      return { mcpServer };
    } catch (error) {
      return respondAdminMutationError(reply, error, "MCP server cannot be published.");
    }
  }));

  app.post("/admin/mcp-servers/:serverId/unpublish", withAdmin(app, async (request, reply) => {
    const paramsResult = parseAdminParams(reply, mcpServerIdParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    try {
      const mcpServer = await stores.dynamicConfig.setMcpServerPublished(
        request.auth.tenantId,
        paramsResult.value.serverId,
        false
      );
      if (!mcpServer) {
        return respondAdminNotFound(reply, "mcp_server_not_found");
      }

      await createAdminAuditEvent(stores.auditEvents, {
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        type: "admin.mcp_server.unpublished",
        payload: { serverId: mcpServer.serverId, version: mcpServer.version },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });

      return { mcpServer };
    } catch (error) {
      return respondAdminMutationError(reply, error, "MCP server cannot be unpublished.");
    }
  }));
}
