import { parseRequestInput } from "../../lib/route-validation.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AdminMcpConnectionTestRequestSchema,
  AdminMcpServerSetupEditSchema,
  AdminMcpWidgetDomainChangeRequestSchema
} from "@cogniplane/shared-types";
import { describeCspSourceError, parseCspSource } from "@cogniplane/shared-types/csp-sources";

import {
  adminIdSchema,
  configError,
  respondAdminMutationError,
  respondAdminNotFound,
  withAdmin
} from "./admin-route-helpers.js";
import { mcpCreateBodySchema, mcpUpdateBodySchema } from "./admin-route-schemas.js";
import type { AdminMcpServerRecord } from "../../services/admin-config-records.js";
import type { ActivationTracker } from "../../services/activation-tracker.js";
import type { AuditEventInput } from "../../services/audit-event-store.js";
import type { AuditEventType } from "../../services/audit-event-types.js";
import type { DataRouteControl } from "../../services/data-route-control.js";
import type { DataSettingChange } from "../../services/mail/setting-change-notices.js";
import type { DynamicConfigService } from "../../services/dynamic-config-service.js";
import type { McpAppCspStore } from "../../services/mcp/mcp-app-csp-store.js";
import { MCP_SERVER_CONFLICT_MESSAGE, McpServerVersionConflictError } from "../../services/mcp-server-store.js";
import {
  McpConnectionTestConflictError,
  McpConnectionTestNotFoundError,
  type McpConnectionTestService
} from "../../services/mcp/mcp-connection-test-service.js";
import { apiError } from "../../lib/http-errors.js";

const serverIdParamsSchema = z.object({ serverId: adminIdSchema });

function respondMcpServerConflict(reply: FastifyReply) {
  reply.code(409);
  return apiError("mcp_server_conflict", MCP_SERVER_CONFLICT_MESSAGE);
}

export async function registerAdminMcpServerRoutes(
  app: FastifyInstance,
  stores: {
    dynamicConfig: Pick<
      DynamicConfigService,
      | "listMcpServers"
      | "createMcpServer"
      | "updateMcpServer"
      | "disableMcpServer"
      | "setMcpServerPublished"
      | "saveMcpServerWithAudience"
      | "setInheritedMcpAudience"
      | "getOrCreateTenantSettings"
    >;
    // Optional: when present, the server list is decorated with activation
    // counts (last 30 days) per server. Failures are swallowed — counts are
    // decorative. Tests that don't supply it just get servers with no counts.
    activations?: Pick<ActivationTracker, "countMcpServerActivations">;
    mcpConnectionTests?: Pick<McpConnectionTestService, "listLatest" | "test">;
    // The content security policy sources that this server's widgets may use.
    mcpAppCsp?: Pick<McpAppCspStore, "listForAdmin" | "approve" | "revoke">;
    // Step-up and owner notice of the routes that change where tool calls go:
    // a server's address and secret, who uses a shared server (audience and
    // publish), and a widget domain. Disable, unpublish, and revoke send data
    // nowhere new.
    dataRoutes: Pick<DataRouteControl, "requireStepUp" | "ownerNotice">;
  }
): Promise<void> {
  const ACTIVATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  const audienceSchema = z.object({ audience: z.enum(["off", "test_users", "members"]) });
  const setupCreateBodySchema = z.intersection(mcpCreateBodySchema, audienceSchema);
  // An edit uses the update schema. It has no defaults, so an omitted
  // upstreamAuthType or credentialScope keeps the stored value. It also names
  // the saved version that its draft started from.
  const setupUpdateBodySchema = z.intersection(mcpUpdateBodySchema, audienceSchema.extend(AdminMcpServerSetupEditSchema.shape));

  function auditPayload(
    mcpServer: AdminMcpServerRecord,
    includeEnabled: boolean,
    audience?: "off" | "test_users" | "members"
  ): Record<string, unknown> {
    return {
      serverId: mcpServer.serverId,
      version: mcpServer.version,
      credentialScope: mcpServer.credentialScope ?? "organization",
      ...(includeEnabled ? { enabled: mcpServer.enabled } : {}),
      ...(audience ? {
        audience,
        isPublished: mcpServer.isPublished,
        isAllowed: audience !== "off"
      } : {})
    };
  }

  function auditInput(
    request: FastifyRequest,
    type: AuditEventType,
    payload: Record<string, unknown>,
    notice?: DataSettingChange
  ): AuditEventInput {
    return {
      tenantId: request.auth.tenantId,
      sessionId: null,
      userId: request.auth.userId,
      type,
      payload,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
      // A data route's owner notice commits with the change and its event.
      ...(notice ? { alsoInTransaction: stores.dataRoutes.ownerNotice(request, notice) } : {})
    };
  }

  // Builds the audit event that commits in the same transaction as the change.
  function auditBuilder(
    request: FastifyRequest,
    type: AuditEventType,
    includeEnabled: boolean,
    notice?: (server: AdminMcpServerRecord) => DataSettingChange
  ): (server: AdminMcpServerRecord) => AuditEventInput {
    return (server) => auditInput(request, type, auditPayload(server, includeEnabled), notice?.(server));
  }

  app.get("/admin/mcp-servers", withAdmin(app, async (request) => {
    const [servers, settings] = await Promise.all([
      stores.dynamicConfig.listMcpServers(request.auth.tenantId, true),
      stores.dynamicConfig.getOrCreateTenantSettings(request.auth.tenantId)
    ]);
    const allowed = new Set(settings.enabledMcpServerIds);
    const latest = stores.mcpConnectionTests
      ? await stores.mcpConnectionTests.listLatest(
        request.auth.tenantId,
        request.auth.userId,
        servers
      )
      : new Map();
    const mcpServers = servers.map((server) => ({
      ...server,
      isAllowed: allowed.has(server.serverId),
      connectionTest: latest.get(server.serverId) ?? null
    }));
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

  app.post("/admin/mcp-servers/:serverId/connection-test", withAdmin(app, async (request, reply) => {
    const params = parseRequestInput(reply, serverIdParamsSchema, request.params);
    if (!params.ok) return params.response;
    const body = parseRequestInput(reply, AdminMcpConnectionTestRequestSchema, request.body);
    if (!body.ok) return body.response;
    if (!stores.mcpConnectionTests) {
      throw new Error("MCP connection testing is unavailable.");
    }
    reply.header("cache-control", "private, no-store");
    try {
      const connectionTest = await stores.mcpConnectionTests.test(
        request.auth.tenantId,
        request.auth.userId,
        params.value.serverId,
        body.value
      );
      return { connectionTest };
    } catch (error) {
      if (error instanceof McpConnectionTestNotFoundError) {
        return respondAdminNotFound(reply, "mcpServer_not_found");
      }
      if (error instanceof McpConnectionTestConflictError) {
        reply.code(409);
        return apiError("conflict", error.message);
      }
      throw error;
    }
  }));

  // Widget domains belong to a proxy server. Only a proxy server serves a widget
  // that declares its own domains.
  async function findProxyServer(request: FastifyRequest, serverId: string) {
    const servers = await stores.dynamicConfig.listMcpServers(request.auth.tenantId, true);
    return servers.find((server) => server.serverId === serverId && server.mode === "proxy") ?? null;
  }

  // Checked before the step-up check of a change, so that a request for a
  // server that does not exist answers 404 and does not spend the token.
  // `own`: the tenant's own server, which an edit changes. `inherited`: a
  // shared system server, whose availability the tenant chooses.
  async function findServer(request: FastifyRequest, serverId: string, owner: "own" | "inherited") {
    const servers = await stores.dynamicConfig.listMcpServers(request.auth.tenantId, true);
    return servers.find((server) => server.serverId === serverId &&
      (owner === "own" ? server.ownerTenantId === request.auth.tenantId : server.ownerTenantId === "system")) ?? null;
  }

  app.get("/admin/mcp-servers/:serverId/widget-domains", withAdmin(app, async (request, reply) => {
    const params = parseRequestInput(reply, serverIdParamsSchema, request.params);
    if (!params.ok) return params.response;
    if (!stores.mcpAppCsp) throw new Error("Widget domain approval is unavailable.");
    if (!await findProxyServer(request, params.value.serverId)) {
      return respondAdminNotFound(reply, "mcp_server_not_found");
    }
    reply.header("cache-control", "private, no-store");
    return { widgetDomains: await stores.mcpAppCsp.listForAdmin(request.auth.tenantId, params.value.serverId) };
  }));

  app.post("/admin/mcp-servers/:serverId/widget-domains/approve", withAdmin(app, async (request, reply) => {
    const params = parseRequestInput(reply, serverIdParamsSchema, request.params);
    if (!params.ok) return params.response;
    const body = parseRequestInput(reply, AdminMcpWidgetDomainChangeRequestSchema, request.body);
    if (!body.ok) return body.response;
    if (!stores.mcpAppCsp) throw new Error("Widget domain approval is unavailable.");
    // An approved source must pass every rule. The rules are the same ones that
    // the widget check applies, so an approval can never be one that the check rejects.
    const parsed = parseCspSource(body.value.source, body.value.directive);
    if (!parsed.ok) {
      reply.code(400);
      return configError(describeCspSourceError(parsed.reason));
    }
    const serverId = params.value.serverId;
    if (!await findProxyServer(request, serverId)) return respondAdminNotFound(reply, "mcp_server_not_found");
    // A widget can load from and send data to an approved domain.
    if (!(await stores.dataRoutes.requireStepUp(request, reply, "POST /admin/mcp-servers/:serverId/widget-domains/approve"))) {
      return reply;
    }
    try {
      await stores.mcpAppCsp.approve(
        request.auth.tenantId,
        serverId,
        { directive: body.value.directive, source: parsed.source.normalized },
        request.auth.userId,
        () => auditInput(request, "admin.mcp_server.widget_domain_approved", {
          serverId, directive: body.value.directive, source: parsed.source.normalized
        }, { setting: "mcp_widget_domain", serverId })
      );
      reply.header("cache-control", "private, no-store");
      return { widgetDomains: await stores.mcpAppCsp.listForAdmin(request.auth.tenantId, serverId) };
    } catch (error) {
      return respondAdminMutationError(reply, error, "The domain could not be approved.");
    }
  }));

  app.post("/admin/mcp-servers/:serverId/widget-domains/revoke", withAdmin(app, async (request, reply) => {
    const params = parseRequestInput(reply, serverIdParamsSchema, request.params);
    if (!params.ok) return params.response;
    const body = parseRequestInput(reply, AdminMcpWidgetDomainChangeRequestSchema, request.body);
    if (!body.ok) return body.response;
    if (!stores.mcpAppCsp) throw new Error("Widget domain approval is unavailable.");
    const serverId = params.value.serverId;
    if (!await findProxyServer(request, serverId)) return respondAdminNotFound(reply, "mcp_server_not_found");
    // A source that the rules reject today can still be stored, for example when
    // the public suffix list changed. Removing it must work, so the raw text is
    // tried as well.
    const parsed = parseCspSource(body.value.source, body.value.directive);
    const sources = parsed.ok ? [parsed.source.normalized, body.value.source] : [body.value.source];
    try {
      await stores.mcpAppCsp.revoke(
        request.auth.tenantId,
        serverId,
        body.value.directive,
        sources,
        () => auditInput(request, "admin.mcp_server.widget_domain_revoked", {
          serverId, directive: body.value.directive, source: sources[0]
        })
      );
      reply.header("cache-control", "private, no-store");
      return { widgetDomains: await stores.mcpAppCsp.listForAdmin(request.auth.tenantId, serverId) };
    } catch (error) {
      return respondAdminMutationError(reply, error, "The domain could not be removed.");
    }
  }));

  async function saveSetup(
    request: FastifyRequest,
    reply: FastifyReply,
    editingId?: string
  ) {
    let body: Omit<z.infer<typeof setupUpdateBodySchema>, "expectedVersion">;
    let serverId: string;
    let editing: { serverId: string; expectedVersion: number } | undefined;
    if (editingId) {
      const bodyResult = parseRequestInput(reply, setupUpdateBodySchema, request.body);
      if (!bodyResult.ok) return bodyResult.response;
      const { expectedVersion, ...fields } = bodyResult.value;
      if (fields.serverId !== editingId) {
        reply.code(400);
        return configError("serverId must match the route parameter.");
      }
      body = fields;
      serverId = editingId;
      editing = { serverId: editingId, expectedVersion };
    } else {
      const bodyResult = parseRequestInput(reply, setupCreateBodySchema, request.body);
      if (!bodyResult.ok) return bodyResult.response;
      body = bodyResult.value;
      serverId = bodyResult.value.serverId;
    }
    const audience = body.audience;
    if (editing) {
      const saved = await findServer(request, editing.serverId, "own");
      if (!saved) return respondAdminNotFound(reply, "mcpServer_not_found");
      // An old draft answers 409 here, so it does not spend the step-up token.
      // The store compares again under the row lock.
      if (saved.version !== editing.expectedVersion) return respondMcpServerConflict(reply);
    }
    if (!(await stores.dataRoutes.requireStepUp(
      request,
      reply,
      editingId ? "PUT /admin/mcp-servers/:serverId/setup" : "POST /admin/mcp-servers/setup"
    ))) return reply;
    try {
      // The audit event and the owner notice commit in the same transaction
      // as the change.
      const mcpServer = await stores.dynamicConfig.saveMcpServerWithAudience(
        request.auth.tenantId,
        {
          ...body,
          serverId,
          description: body.description ?? null,
          actorUserId: request.auth.userId,
          enabled: audience !== "off"
        },
        audience,
        editing,
        (saved) => auditInput(
          request,
          editingId ? "admin.mcp_server.updated" : "admin.mcp_server.created",
          auditPayload(saved, true, audience),
          { setting: "mcp_server", serverId: saved.serverId, created: !editingId }
        )
      );
      if (!mcpServer) {
        return respondAdminNotFound(reply, "mcpServer_not_found");
      }
      if (!editingId) {
        reply.code(201);
      }
      return { mcpServer };
    } catch (error) {
      if (error instanceof McpServerVersionConflictError) return respondMcpServerConflict(reply);
      return respondAdminMutationError(reply, error, "MCP connection could not be saved.");
    }
  }

  app.post("/admin/mcp-servers/setup", withAdmin(app, (request, reply) =>
    saveSetup(request, reply)
  ));

  app.put("/admin/mcp-servers/:serverId/setup", withAdmin(app, async (request, reply) => {
    const paramsResult = parseRequestInput(reply, serverIdParamsSchema, request.params);
    if (!paramsResult.ok) return paramsResult.response;
    return saveSetup(request, reply, paramsResult.value.serverId);
  }));

  app.put("/admin/mcp-servers/:serverId/inherited-availability", withAdmin(app, async (request, reply) => {
    const paramsResult = parseRequestInput(reply, serverIdParamsSchema, request.params);
    if (!paramsResult.ok) return paramsResult.response;
    const bodyResult = parseRequestInput(
      reply,
      z.object({ audience: z.enum(["off", "test_users", "members"]) }),
      request.body
    );
    if (!bodyResult.ok) return bodyResult.response;
    if (!(await findServer(request, paramsResult.value.serverId, "inherited"))) {
      return respondAdminNotFound(reply, "mcpServer_not_found");
    }
    // Turns a shared server on or off for the tenant's members.
    if (!(await stores.dataRoutes.requireStepUp(request, reply, "PUT /admin/mcp-servers/:serverId/inherited-availability"))) {
      return reply;
    }
    try {
      // The audit event and the owner notice commit in the same transaction
      // as the change.
      const mcpServer = await stores.dynamicConfig.setInheritedMcpAudience(
        request.auth.tenantId,
        paramsResult.value.serverId,
        bodyResult.value.audience,
        (server) => auditInput(request, "admin.mcp_server.updated", {
          serverId: server.serverId,
          version: server.version,
          audience: bodyResult.value.audience,
          inherited: true,
          enabled: server.enabled,
          isPublished: server.isPublished,
          isAllowed: bodyResult.value.audience !== "off"
        }, { setting: "mcp_server_audience", serverId: server.serverId })
      );
      return {
        mcpServer: {
          serverId: mcpServer.serverId,
          ownerTenantId: mcpServer.ownerTenantId,
          serverName: mcpServer.serverName,
          description: mcpServer.description,
          transportKind: mcpServer.transportKind,
          mode: mcpServer.mode,
          routePath: mcpServer.routePath,
          upstreamUrl: mcpServer.upstreamUrl,
          upstreamAuthType: mcpServer.upstreamAuthType,
          upstreamAuthName: mcpServer.upstreamAuthName,
          upstreamAuthConfigured: mcpServer.upstreamAuthConfigured,
          credentialScope: mcpServer.credentialScope,
          credentialBindingId: mcpServer.credentialBindingId,
          version: mcpServer.version,
          configHash: mcpServer.configHash,
          enabled: mcpServer.enabled,
          isPublished: mcpServer.isPublished,
          isAllowed: bodyResult.value.audience !== "off",
          createdBy: mcpServer.createdBy,
          createdAt: mcpServer.createdAt,
          updatedAt: mcpServer.updatedAt
        }
      };
    } catch (error) {
      return respondAdminMutationError(reply, error, "Inherited connection availability could not be saved.");
    }
  }));

  app.post("/admin/mcp-servers", withAdmin(app, async (request, reply) => {
    const bodyResult = parseRequestInput(reply, mcpCreateBodySchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = bodyResult.value;
    if (!(await stores.dataRoutes.requireStepUp(request, reply, "POST /admin/mcp-servers"))) return reply;
    try {
      const mcpServer = await stores.dynamicConfig.createMcpServer(request.auth.tenantId, {
        ...body,
        serverId: body.serverId,
        description: body.description ?? null,
        upstreamUrl: body.upstreamUrl ?? null,
        upstreamAuthType: body.upstreamAuthType,
        upstreamAuthName: body.upstreamAuthName ?? null,
        upstreamAuthSecret: body.upstreamAuthSecret ?? null,
        actorUserId: request.auth.userId
      }, auditBuilder(request, "admin.mcp_server.created", true,
        (server) => ({ setting: "mcp_server", serverId: server.serverId, created: true })));
      reply.code(201);
      return { mcpServer };
    } catch (error) {
      return respondAdminMutationError(reply, error, "MCP server ID already exists.");
    }
  }));

  app.put("/admin/mcp-servers/:serverId", withAdmin(app, async (request, reply) => {
    const paramsResult = parseRequestInput(reply, serverIdParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    const bodyResult = parseRequestInput(reply, mcpUpdateBodySchema, request.body);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = bodyResult.value;
    if (body.serverId !== undefined && body.serverId !== paramsResult.value.serverId) {
      reply.code(400);
      return configError("serverId must match the route parameter.");
    }
    if (!(await findServer(request, paramsResult.value.serverId, "own"))) return respondAdminNotFound(reply, "mcpServer_not_found");
    if (!(await stores.dataRoutes.requireStepUp(request, reply, "PUT /admin/mcp-servers/:serverId"))) return reply;

    try {
      const mcpServer = await stores.dynamicConfig.updateMcpServer(request.auth.tenantId, {
        serverId: paramsResult.value.serverId,
        serverName: body.serverName,
        description: body.description ?? null,
        transportKind: body.transportKind,
        mode: body.mode,
        routePath: body.routePath,
        upstreamUrl: body.upstreamUrl,
        upstreamAuthType: body.upstreamAuthType,
        upstreamAuthName: body.upstreamAuthName,
        upstreamAuthSecret: body.upstreamAuthSecret,
        credentialScope: body.credentialScope,
        enabled: body.enabled
      }, auditBuilder(request, "admin.mcp_server.updated", true,
        (server) => ({ setting: "mcp_server", serverId: server.serverId, created: false })));
      if (!mcpServer) return respondAdminNotFound(reply, "mcpServer_not_found");
      return { mcpServer };
    } catch (error) {
      return respondAdminMutationError(reply, error, "Invalid MCP server configuration.");
    }
  }));

  app.post("/admin/mcp-servers/:serverId/disable", withAdmin(app, async (request, reply) => {
    const paramsResult = parseRequestInput(reply, serverIdParamsSchema, request.params);
    if (!paramsResult.ok) {
      return paramsResult.response;
    }

    try {
      const mcpServer = await stores.dynamicConfig.disableMcpServer(
        request.auth.tenantId,
        paramsResult.value.serverId,
        auditBuilder(request, "admin.mcp_server.disabled", false)
      );
      if (!mcpServer) return respondAdminNotFound(reply, "mcpServer_not_found");
      return { mcpServer };
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
      const paramsResult = parseRequestInput(reply, serverIdParamsSchema, request.params);
      if (!paramsResult.ok) {
        return paramsResult.response;
      }
      // Publish sends the tool calls of every member to the server's upstream: a data
      // route, like a change of the audience. Unpublish sends data nowhere new.
      if (isPublished) {
        if (!(await findServer(request, paramsResult.value.serverId, "own"))) {
          return respondAdminNotFound(reply, "mcp_server_not_found");
        }
        if (!(await stores.dataRoutes.requireStepUp(request, reply, "POST /admin/mcp-servers/:serverId/publish"))) {
          return reply;
        }
      }

      try {
        const mcpServer = await stores.dynamicConfig.setMcpServerPublished(
          request.auth.tenantId,
          paramsResult.value.serverId,
          isPublished,
          (server) => auditInput(
            request,
            auditType,
            { serverId: server.serverId, version: server.version },
            isPublished ? { setting: "mcp_server_audience", serverId: server.serverId } : undefined
          )
        );
        if (!mcpServer) {
          return respondAdminNotFound(reply, "mcp_server_not_found");
        }

        return { mcpServer };
      } catch (error) {
        return respondAdminMutationError(reply, error, errorMessage);
      }
    }));
  }
}
