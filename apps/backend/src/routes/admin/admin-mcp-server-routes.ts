import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  adminIdSchema,
  configError,
  createAdminAuditEvent,
  parseAdminBody,
  parseAdminParams,
  respondAdminMutationError,
  respondAdminNotFound,
  withAdmin
} from "./admin-route-helpers.js";
import { mcpBodySchema } from "./admin-route-schemas.js";
import type { AdminMcpServerRecord } from "../../services/admin-config-records.js";
import type { ActivationTracker } from "../../services/activation-tracker.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { AuditEventType } from "../../services/audit-event-types.js";
import type { DynamicConfigService } from "../../services/dynamic-config-service.js";

const serverIdParamsSchema = z.object({ serverId: adminIdSchema });

export async function registerAdminMcpServerRoutes(
  app: FastifyInstance,
  stores: {
    dynamicConfig: DynamicConfigService;
    auditEvents: AuditEventStore;
    // Optional: when present, the server list is decorated with activation
    // counts (last 30 days) per server. Failures are swallowed — counts are
    // decorative. Tests that don't supply it just get servers with no counts.
    activations?: ActivationTracker;
  }
): Promise<void> {
  const ACTIVATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

  // Shared mutation tail: 404 on a missing server, otherwise audit and
  // return the `{ mcpServer }` envelope (201 on create).
  async function finalizeMutation(
    reply: FastifyReply,
    input: {
      mcpServer: AdminMcpServerRecord | null;
      tenantId: string;
      userId: string;
      auditType: AuditEventType;
      includeEnabled: boolean;
      created?: boolean;
      ipAddress?: string;
      userAgent?: string;
    }
  ) {
    if (!input.mcpServer) {
      return respondAdminNotFound(reply, "mcpServer_not_found");
    }

    await createAdminAuditEvent(stores.auditEvents, {
      tenantId: input.tenantId,
      userId: input.userId,
      type: input.auditType,
      payload: {
        serverId: input.mcpServer.serverId,
        version: input.mcpServer.version,
        ...(input.includeEnabled ? { enabled: input.mcpServer.enabled } : {})
      },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent
    });

    if (input.created) {
      reply.code(201);
    }

    return { mcpServer: input.mcpServer };
  }

  app.get("/admin/mcp-servers", withAdmin(app, async (request) => {
    const mcpServers = await stores.dynamicConfig.listMcpServers(request.auth.tenantId, true);
    if (!stores.activations) {
      return { mcpServers };
    }

    try {
      const counts = await stores.activations.countMcpServerActivations(
        request.auth.tenantId,
        ACTIVATION_WINDOW_MS
      );
      return {
        mcpServers: mcpServers.map((server) => {
          const entry = counts.get(server.serverId);
          return {
            ...server,
            invokedSessions30d: entry?.invokedSessions ?? 0,
            materializedSessions30d: entry?.materializedSessions ?? 0
          };
        })
      };
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "admin mcp-servers: failed to read activation counts; returning servers without counts"
      );
      return { mcpServers };
    }
  }));

  app.post("/admin/mcp-servers", withAdmin(app, async (request, reply) => {
    const bodyResult = parseAdminBody(reply, mcpBodySchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = bodyResult.value;
    if (!body.serverId) {
      reply.code(400);
      return configError("serverId is required.");
    }

    try {
      const mcpServer = await stores.dynamicConfig.createMcpServer(request.auth.tenantId, {
        ...body,
        serverId: body.serverId,
        description: body.description ?? null,
        upstreamUrl: body.upstreamUrl ?? null,
        actorUserId: request.auth.userId
      });
      return await finalizeMutation(reply, {
        mcpServer,
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        auditType: "admin.mcp_server.created",
        includeEnabled: true,
        created: true,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    } catch (error) {
      return respondAdminMutationError(reply, error, "MCP server ID already exists.");
    }
  }));

  app.put("/admin/mcp-servers/:serverId", withAdmin(app, async (request, reply) => {
    const paramsResult = parseAdminParams(reply, serverIdParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const bodyResult = parseAdminBody(reply, mcpBodySchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = bodyResult.value;
    if (body.serverId !== undefined && body.serverId !== paramsResult.value.serverId) {
      reply.code(400);
      return configError("serverId must match the route parameter.");
    }

    try {
      const mcpServer = await stores.dynamicConfig.updateMcpServer(request.auth.tenantId, {
        serverId: paramsResult.value.serverId,
        serverName: body.serverName,
        description: body.description ?? null,
        transportKind: body.transportKind,
        mode: body.mode,
        routePath: body.routePath,
        upstreamUrl: body.upstreamUrl ?? null,
        headersAllowlist: body.headersAllowlist,
        enabled: body.enabled
      });
      return await finalizeMutation(reply, {
        mcpServer,
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        auditType: "admin.mcp_server.updated",
        includeEnabled: true,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    } catch (error) {
      return respondAdminMutationError(reply, error, "Invalid MCP server configuration.");
    }
  }));

  app.post("/admin/mcp-servers/:serverId/disable", withAdmin(app, async (request, reply) => {
    const paramsResult = parseAdminParams(reply, serverIdParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    try {
      const mcpServer = await stores.dynamicConfig.disableMcpServer(
        request.auth.tenantId,
        paramsResult.value.serverId
      );
      return await finalizeMutation(reply, {
        mcpServer,
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        auditType: "admin.mcp_server.disabled",
        includeEnabled: false,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
    } catch (error) {
      return respondAdminMutationError(reply, error, "MCP server cannot be disabled.");
    }
  }));

  registerPublishRoute(true, "publish", "admin.mcp_server.published", "MCP server cannot be published.");
  registerPublishRoute(false, "unpublish", "admin.mcp_server.unpublished", "MCP server cannot be unpublished.");

  function registerPublishRoute(
    isPublished: boolean,
    action: "publish" | "unpublish",
    auditType: AuditEventType,
    errorMessage: string
  ): void {
    app.post(`/admin/mcp-servers/:serverId/${action}`, withAdmin(app, async (request, reply) => {
      const paramsResult = parseAdminParams(reply, serverIdParamsSchema, request.params);
      if (!paramsResult.ok) {
        return paramsResult.response;
      }

      try {
        const mcpServer = await stores.dynamicConfig.setMcpServerPublished(
          request.auth.tenantId,
          paramsResult.value.serverId,
          isPublished
        );
        if (!mcpServer) {
          return respondAdminNotFound(reply, "mcp_server_not_found");
        }

        await createAdminAuditEvent(stores.auditEvents, {
          tenantId: request.auth.tenantId,
          userId: request.auth.userId,
          type: auditType,
          payload: { serverId: mcpServer.serverId, version: mcpServer.version },
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"]
        });

        return { mcpServer };
      } catch (error) {
        return respondAdminMutationError(reply, error, errorMessage);
      }
    }));
  }
}
