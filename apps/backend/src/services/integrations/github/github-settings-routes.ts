import type { FastifyInstance, FastifyReply } from "fastify";

import {
  GithubAllowedRepositoriesRequestSchema,
  GithubAllowedRepositoriesResponseSchema,
  GithubConnectionConfirmRequestSchema,
  GithubConnectionStatusSchema,
  GithubRepositoryListResponseSchema,
  GithubUserConnectionSchema
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
  GithubConnectionError,
  GithubConnectionNotConfiguredError,
  type GithubConnectionService
} from "./github-connection-service.js";
import { InvalidGithubRepositoryListError } from "./github-repository-allowlist.js";

export type GithubSettingsRouteDeps = {
  githubConnections: Pick<
    GithubConnectionService,
    | "getConnectionStatus"
    | "getAuthorizationUrl"
    | "disconnect"
    | "listAccessibleRepositories"
    | "setAllowedRepositories"
    | "confirm"
  >;
  loadIntegrationEnablement: BuiltinConnectorInput["loadIntegrationEnablement"];
};

const GITHUB_CONNECTION_ERROR_STATUS: Record<GithubConnectionError["code"], number> = {
  not_connected: 404,
  credentials_unusable: 409,
  upstream_unavailable: 502,
  account_changed: 409
};

// Maps the failures of a GitHub repository settings request to a response.
// Anything else is a bug and rethrows to the global error handler.
function sendGithubRepositoryError(reply: FastifyReply, error: unknown) {
  if (error instanceof GithubConnectionNotConfiguredError) {
    reply.code(503);
    return notFoundError("github_integration_not_configured");
  }
  if (error instanceof GithubConnectionError) {
    reply.code(GITHUB_CONNECTION_ERROR_STATUS[error.code]);
    return apiError(`github_${error.code}`, error.message);
  }
  if (error instanceof InvalidGithubRepositoryListError) {
    reply.code(400);
    return apiError("invalid_request", error.message);
  }
  throw error;
}

// Member routes. Tenant and user always come from `request.auth`.
export function registerGithubSettingsRoutes(app: FastifyInstance, deps: GithubSettingsRouteDeps): void {
  app.get("/me/github-connection", async (request) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const [status, enablement] = await Promise.all([
      deps.githubConnections.getConnectionStatus(tenantId, userId),
      deps.loadIntegrationEnablement(tenantId, "github")
    ]);
    return serialize(GithubConnectionStatusSchema, { ...status, ...enablement });
  });

  app.post("/me/github-connection/authorize", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);

    try {
      const { url, browserBinding } = await deps.githubConnections.getAuthorizationUrl({
        tenantId,
        userId,
        ownerSecurityVersion: await connectionSaverVersion(request, app)
      });
      reply.setCookie(browserBinding.name, browserBinding.value, browserBinding.options);
      return { url };
    } catch (error) {
      if (error instanceof GithubConnectionNotConfiguredError) {
        reply.code(503);
        return notFoundError("github_integration_not_configured");
      }
      throw error;
    }
  });

  // The choices for the allowed-repository list: what GitHub lets the member
  // reach. The model has no tool that calls this.
  app.get("/me/github-connection/repositories", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    try {
      const listing = await deps.githubConnections.listAccessibleRepositories(tenantId, userId);
      return serialize(GithubRepositoryListResponseSchema, listing);
    } catch (error) {
      return sendGithubRepositoryError(reply, error);
    }
  });

  // Tenant and user come from `request.auth`. The browser sends the list and
  // the GitHub account it chose the list for. The service validates and
  // normalizes the list, and answers 409 `github_account_changed` when another
  // account is connected now.
  app.put("/me/github-connection/repositories", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const body = parseRequestInput(reply, GithubAllowedRepositoriesRequestSchema, request.body);
    if (!body.ok) return body.response;
    try {
      const allowedRepositories = await deps.githubConnections.setAllowedRepositories(
        tenantId,
        userId,
        body.value.repositories,
        body.value.githubUserId
      );
      return serialize(GithubAllowedRepositoriesResponseSchema, { allowedRepositories });
    } catch (error) {
      return sendGithubRepositoryError(reply, error);
    }
  });

  // The owner confirms a connection that a security change of the account
  // suspended. The browser sends the GitHub account that the page shows.
  app.post("/me/github-connection/confirm", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const body = parseRequestInput(reply, GithubConnectionConfirmRequestSchema, request.body);
    if (!body.ok) return body.response;
    try {
      const userConnection = await deps.githubConnections.confirm(
        tenantId,
        userId,
        body.value.githubUserId,
        await connectionSaverVersion(request, app)
      );
      return { userConnection: serialize(GithubUserConnectionSchema, userConnection) };
    } catch (error) {
      if (error instanceof ConnectionConfirmError) {
        reply.code(connectionConfirmErrorStatus(error));
        return apiError(`github_${error.code}`, error.message);
      }
      throw error;
    }
  });

  app.delete("/me/github-connection", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const removed = await deps.githubConnections.disconnect(tenantId, userId);
    if (!removed) {
      reply.code(404);
      return notFoundError("github_connection_not_found");
    }

    reply.code(204);
    return null;
  });
}
