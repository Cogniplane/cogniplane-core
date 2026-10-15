import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  JiraAccountCandidatesResponseSchema,
  JiraAccountIdSchema,
  JiraAccountSitesResponseSchema,
  JiraCleanupListResponseSchema,
  JiraCleanupSchema,
  JiraConnectionSelectRequestSchema,
  JiraConnectionStatusSchema,
  JiraUserConnectionSchema
} from "@cogniplane/shared-types";

import type { AppConfig } from "../../../config.js";
import { ensureUser } from "../../../lib/db.js";
import { apiError } from "../../../lib/http-errors.js";
import { parseRequestInput } from "../../../lib/route-validation.js";
import { serialize } from "../../../lib/serialize-response.js";
import { withAdmin } from "../../../routes/admin/admin-route-helpers.js";
import { loadIntegrationEnablement } from "../integration-enablement.js";
import type { IntegrationStateStore } from "../integration-state-store.js";
import { JIRA_INTEGRATION_ID, JiraConnectionError, type JiraConnectionService } from "./jira-connection-service.js";

export type JiraConnectionRouteDeps = {
  jiraConnections: Pick<
    JiraConnectionService,
    | "getConnectionStatus" | "getAuthorizationUrl" | "listCandidates" | "listAccountSites"
    | "selectConnection" | "disconnect" | "listPendingCleanups" | "retryCleanup"
  >;
  integrationStates: Pick<IntegrationStateStore, "get">;
  config: AppConfig;
};

const ERROR_STATUS: Record<JiraConnectionError["code"], number> = {
  not_configured: 503,
  account_not_found: 404,
  account_unhealthy: 409,
  site_not_accessible: 422,
  upstream_unavailable: 502,
  connection_changed: 409,
  cleanup_not_found: 404,
  cleanup_incomplete: 502
};

const accountParamsSchema = z.object({ accountId: JiraAccountIdSchema }).strict();
const cleanupParamsSchema = z.object({ cleanupId: z.string().uuid() }).strict();

function sendConnectionError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof JiraConnectionError)) throw error;
  reply.code(ERROR_STATUS[error.code]);
  return apiError(`jira_${error.code}`, error.message);
}

// Member routes. Tenant and user always come from `request.auth`; the browser
// supplies only the account and site it chose, and the service verifies both.
export async function registerJiraConnectionRoutes(app: FastifyInstance, deps: JiraConnectionRouteDeps): Promise<void> {
  async function requireReadsEnabled(tenantId: string, reply: FastifyReply) {
    const enablement = await loadIntegrationEnablement(deps.integrationStates, deps.config, tenantId, JIRA_INTEGRATION_ID);
    if (enablement.tenantReadsEnabled) return null;
    reply.code(403);
    return apiError("jira_integration_disabled", "Your organization has not enabled Jira.");
  }

  app.get("/me/jira-connection", async (request) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const [status, enablement] = await Promise.all([
      deps.jiraConnections.getConnectionStatus(tenantId, userId),
      loadIntegrationEnablement(deps.integrationStates, deps.config, tenantId, JIRA_INTEGRATION_ID)
    ]);
    return serialize(JiraConnectionStatusSchema, { ...status, ...enablement });
  });

  app.post("/me/jira-connection/authorize", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const disabled = await requireReadsEnabled(tenantId, reply);
    if (disabled) return disabled;
    try {
      return await deps.jiraConnections.getAuthorizationUrl({ tenantId, userId });
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.get("/me/jira-connection/accounts", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const disabled = await requireReadsEnabled(tenantId, reply);
    if (disabled) return disabled;
    try {
      const accounts = await deps.jiraConnections.listCandidates(tenantId, userId);
      return serialize(JiraAccountCandidatesResponseSchema, { accounts });
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  // Sites load for one account at a time, when the member chooses it, so
  // that the number of upstream calls stays bounded.
  app.get("/me/jira-connection/accounts/:accountId/sites", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const params = parseRequestInput(reply, accountParamsSchema, request.params);
    if (!params.ok) return params.response;
    const disabled = await requireReadsEnabled(tenantId, reply);
    if (disabled) return disabled;
    try {
      const sites = await deps.jiraConnections.listAccountSites(tenantId, userId, params.value.accountId);
      return serialize(JiraAccountSitesResponseSchema, { sites });
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.put("/me/jira-connection", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    const body = parseRequestInput(reply, JiraConnectionSelectRequestSchema, request.body);
    if (!body.ok) return body.response;
    const disabled = await requireReadsEnabled(tenantId, reply);
    if (disabled) return disabled;
    try {
      const connection = await deps.jiraConnections.selectConnection(tenantId, userId, body.value);
      return { userConnection: serialize(JiraUserConnectionSchema, connection) };
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  // Disconnect stays open when the tenant disables Jira, so members can still
  // remove their remote account. It is idempotent: when no remote account or
  // stored row remains, it also returns 204. It also retries the member's
  // earlier cleanups; 502 `jira_cleanup_incomplete` means one is still
  // pending, while the local connection is already removed.
  app.delete("/me/jira-connection", async (request, reply) => {
    const { userId, tenantId } = request.auth;
    await ensureUser(app.db, userId);
    try {
      await deps.jiraConnections.disconnect(tenantId, userId);
      reply.code(204);
      return null;
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  // Administrator view of remote cleanups that did not finish, for example
  // after a member removal while Pipedream was unavailable. Retry deletes
  // only the accounts of the retired external ID in the record.
  app.get("/admin/integrations/jira/cleanups", withAdmin(app, async (request) => {
    const cleanups = await deps.jiraConnections.listPendingCleanups(request.auth.tenantId);
    return serialize(JiraCleanupListResponseSchema, { cleanups });
  }));

  app.post("/admin/integrations/jira/cleanups/:cleanupId/retry", withAdmin(app, async (request, reply) => {
    const params = parseRequestInput(reply, cleanupParamsSchema, request.params);
    if (!params.ok) return params.response;
    try {
      const outcome = await deps.jiraConnections.retryCleanup(request.auth.tenantId, params.value.cleanupId);
      if (outcome.status === "completed") return { status: "completed", remoteAccountsDeleted: outcome.remoteAccountsDeleted };
      reply.code(502);
      return {
        ...apiError("jira_cleanup_incomplete", outcome.cleanup.lastError ?? "Jira cleanup did not finish."),
        cleanup: serialize(JiraCleanupSchema, outcome.cleanup)
      };
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  }));
}
