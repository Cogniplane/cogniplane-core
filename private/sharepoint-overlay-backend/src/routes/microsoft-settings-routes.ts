import type { FastifyInstance } from "fastify";

import {
  MicrosoftConnectionConfirmRequestSchema,
  MicrosoftConnectionStatusSchema,
  MicrosoftUserConnectionSchema
} from "../../../sharepoint-overlay-contracts/src/index.js";

import { ensureUser } from "../../../../apps/backend/src/lib/db.js";
import { apiError, notFoundError } from "../../../../apps/backend/src/lib/http-errors.js";
import { parseRequestInput } from "../../../../apps/backend/src/lib/route-validation.js";
import { serialize } from "../../../../apps/backend/src/lib/serialize-response.js";
import {
  ConnectionConfirmError,
  connectionConfirmErrorStatus,
  connectionSaverVersion
} from "../../../../apps/backend/src/services/auth/security-change.js";
import type { AttachOverlaysInput } from "../../../../apps/backend/src/overlay-contracts.js";
import {
  MicrosoftConnectionNotConfiguredError,
  type MicrosoftConnectionService
} from "../services/microsoft-connection-service.js";

export type MicrosoftSettingsRoutesDeps = {
  microsoftConnections: MicrosoftConnectionService;
  loadIntegrationEnablement: AttachOverlaysInput["loadIntegrationEnablement"];
};

export function registerMicrosoftSettingsRoutes(
  app: FastifyInstance,
  deps: MicrosoftSettingsRoutesDeps
): void {
  app.get("/me/microsoft-connection", async (request) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const [status, enablement] = await Promise.all([
      deps.microsoftConnections.getConnectionStatus(tenantId, userId),
      deps.loadIntegrationEnablement(tenantId, "microsoft")
    ]);
    return serialize(MicrosoftConnectionStatusSchema, { ...status, ...enablement });
  });

  app.post("/me/microsoft-connection/authorize", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);

    try {
      const { url, browserBinding } = await deps.microsoftConnections.getAuthorizationUrl({
        tenantId,
        userId,
        ownerSecurityVersion: await connectionSaverVersion(request, app)
      });
      reply.setCookie(browserBinding.name, browserBinding.value, browserBinding.options);
      return { url };
    } catch (error) {
      if (error instanceof MicrosoftConnectionNotConfiguredError) {
        reply.code(503);
        return notFoundError("microsoft_integration_not_configured");
      }
      throw error;
    }
  });

  // The owner confirms a connection that a security change of the account
  // suspended. The browser sends the Microsoft account that the page shows.
  app.post("/me/microsoft-connection/confirm", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const body = parseRequestInput(reply, MicrosoftConnectionConfirmRequestSchema, request.body);
    if (!body.ok) return body.response;
    try {
      const userConnection = await deps.microsoftConnections.confirm(
        tenantId,
        userId,
        body.value.microsoftUserId,
        await connectionSaverVersion(request, app)
      );
      return { userConnection: serialize(MicrosoftUserConnectionSchema, userConnection) };
    } catch (error) {
      if (error instanceof ConnectionConfirmError) {
        reply.code(connectionConfirmErrorStatus(error));
        return apiError(`microsoft_${error.code}`, error.message);
      }
      throw error;
    }
  });

  app.delete("/me/microsoft-connection", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const removed = await deps.microsoftConnections.disconnect(tenantId, userId);
    if (!removed) {
      reply.code(404);
      return notFoundError("microsoft_connection_not_found");
    }
    reply.code(204);
    return null;
  });
}
