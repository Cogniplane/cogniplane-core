import type { FastifyInstance } from "fastify";

import {
  NotionConnectionConfirmRequestSchema,
  NotionConnectionStatusSchema,
  NotionUserConnectionSchema
} from "@cogniplane/shared-types";

import { ensureUser } from "../../../lib/db.js";
import { apiError, notFoundError } from "../../../lib/http-errors.js";
import { parseRequestInput } from "../../../lib/route-validation.js";
import { serialize } from "../../../lib/serialize-response.js";
import {
  ConnectionConfirmError,
  connectionConfirmErrorStatus,
  connectionSaverVersion
} from "../../auth/security-change.js";
import type { BuiltinConnectorInput } from "../../connectors/connector-module.js";
import {
  NotionConnectionNotConfiguredError,
  type NotionConnectionService
} from "./notion-connection-service.js";

export type NotionSettingsRouteDeps = {
  notionConnections: Pick<
    NotionConnectionService,
    "getConnectionStatus" | "getAuthorizationUrl" | "disconnect" | "confirm"
  >;
  loadIntegrationEnablement: BuiltinConnectorInput["loadIntegrationEnablement"];
};

// Member routes. Tenant and user always come from `request.auth`.
export function registerNotionSettingsRoutes(app: FastifyInstance, deps: NotionSettingsRouteDeps): void {
  app.get("/me/notion-connection", async (request) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const [status, enablement] = await Promise.all([
      deps.notionConnections.getConnectionStatus(tenantId, userId),
      deps.loadIntegrationEnablement(tenantId, "notion")
    ]);
    return serialize(NotionConnectionStatusSchema, { ...status, ...enablement });
  });

  app.post("/me/notion-connection/authorize", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);

    try {
      const { url, browserBinding } = await deps.notionConnections.getAuthorizationUrl({
        tenantId,
        userId,
        ownerSecurityVersion: await connectionSaverVersion(request, app)
      });
      reply.setCookie(browserBinding.name, browserBinding.value, browserBinding.options);
      return { url };
    } catch (error) {
      if (error instanceof NotionConnectionNotConfiguredError) {
        reply.code(503);
        return notFoundError("notion_integration_not_configured");
      }
      throw error;
    }
  });

  // The owner confirms a connection that a security change of the account
  // suspended. The browser sends the Notion user and workspace that the page shows.
  app.post("/me/notion-connection/confirm", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const body = parseRequestInput(reply, NotionConnectionConfirmRequestSchema, request.body);
    if (!body.ok) return body.response;
    try {
      const userConnection = await deps.notionConnections.confirm(
        tenantId,
        userId,
        body.value,
        await connectionSaverVersion(request, app)
      );
      return { userConnection: serialize(NotionUserConnectionSchema, userConnection) };
    } catch (error) {
      if (error instanceof ConnectionConfirmError) {
        reply.code(connectionConfirmErrorStatus(error));
        return apiError(`notion_${error.code}`, error.message);
      }
      throw error;
    }
  });

  app.delete("/me/notion-connection", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const removed = await deps.notionConnections.disconnect(tenantId, userId);
    if (!removed) {
      reply.code(404);
      return notFoundError("notion_connection_not_found");
    }
    reply.code(204);
    return null;
  });
}
