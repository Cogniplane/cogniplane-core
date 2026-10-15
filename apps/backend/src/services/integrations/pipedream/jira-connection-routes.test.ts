import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";

import type { Pool } from "../../../lib/db.js";
import { FakeDatabase } from "../../../test-helpers/fake-database.js";
import { createTestConfig } from "../../../test-helpers/test-config.js";
import { JiraConnectionError, type JiraCleanupOutcome } from "./jira-connection-service.js";
import { registerJiraConnectionRoutes, type JiraConnectionRouteDeps } from "./jira-connection-routes.js";

const SITE = "11111111-2222-4333-8444-555555555555";
const connection = {
  accountId: "apn_mine",
  accountName: "me@example.test",
  site: { siteId: SITE, name: "Acme", url: "https://acme.atlassian.net" },
  connectedAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:00:00.000Z"
};

const CLEANUP_ID = "00000000-0000-4000-8000-000000000001";
const cleanup = {
  cleanupId: CLEANUP_ID,
  userId: "user-2",
  accountId: "apn_old",
  reason: "member_removed" as const,
  attempts: 1,
  lastError: "Pipedream is unavailable. Try again later.",
  createdAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:00:00.000Z"
};

async function createApp(options: { readsEnabled?: boolean; isAdmin?: boolean } = {}) {
  const jiraConnections = {
    getConnectionStatus: vi.fn(async () => ({
      configured: true, userConnection: connection, authorizationStarted: true, cleanupPending: false
    })),
    getAuthorizationUrl: vi.fn(async () => ({ url: "https://pipedream.com/_static/connect.html?app=jira" })),
    listCandidates: vi.fn(async () => [{ accountId: "apn_mine", accountName: null, healthy: true, createdAt: null }]),
    listAccountSites: vi.fn(async () => [connection.site]),
    selectConnection: vi.fn(async () => connection),
    disconnect: vi.fn(async () => true),
    listPendingCleanups: vi.fn(async () => [cleanup]),
    retryCleanup: vi.fn(async (): Promise<JiraCleanupOutcome> => ({ status: "completed", remoteAccountsDeleted: 2 }))
  } satisfies JiraConnectionRouteDeps["jiraConnections"];
  const app = Fastify();
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "user-1",
      tenantId: request.headers["x-tenant-id"]?.toString() || "tenant-a",
      isAdmin: options.isAdmin ?? false,
      role: options.isAdmin ? "admin" as const : "member" as const
    };
  });
  await registerJiraConnectionRoutes(app, {
    jiraConnections,
    integrationStates: {
      async get(tenantId: string, integrationId: string) {
        return {
          tenantId, integrationId, readsEnabled: options.readsEnabled ?? true, writesEnabled: false,
          config: {}, createdAt: "x", updatedAt: "x", updatedBy: null
        };
      }
    },
    config: createTestConfig({})
  });
  return { app, jiraConnections };
}

describe("Jira connection routes", () => {
  test("status merges tenant enablement", async () => {
    const { app } = await createApp();
    const response = await app.inject({ method: "GET", url: "/me/jira-connection" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: true, tenantReadsEnabled: true, userConnection: { accountId: "apn_mine" } });
  });

  test("uses the authenticated tenant and user, never body fields", async () => {
    const { app, jiraConnections } = await createApp();
    const response = await app.inject({
      method: "PUT",
      url: "/me/jira-connection",
      headers: { "x-tenant-id": "tenant-b", "x-user-id": "user-9" },
      payload: { accountId: "apn_mine", siteId: SITE }
    });
    expect(response.statusCode).toBe(200);
    expect(jiraConnections.selectConnection).toHaveBeenCalledWith("tenant-b", "user-9", { accountId: "apn_mine", siteId: SITE });
  });

  test("rejects extra identity fields and malformed IDs", async () => {
    const { app, jiraConnections } = await createApp();
    for (const payload of [
      { accountId: "apn_mine", siteId: SITE, tenantId: "tenant-x" },
      { accountId: "../apn", siteId: SITE },
      { accountId: "apn_mine", siteId: "acme.atlassian.net" }
    ]) {
      const response = await app.inject({ method: "PUT", url: "/me/jira-connection", payload });
      expect(response.statusCode).toBe(400);
    }
    expect(jiraConnections.selectConnection).not.toHaveBeenCalled();
  });

  test("blocks authorize, account listing, and selection when the tenant disables Jira", async () => {
    const { app, jiraConnections } = await createApp({ readsEnabled: false });
    expect((await app.inject({ method: "POST", url: "/me/jira-connection/authorize" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/me/jira-connection/accounts" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/me/jira-connection/accounts/apn_mine/sites" })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/me/jira-connection", payload: { accountId: "apn_mine", siteId: SITE } })).statusCode).toBe(403);
    expect(jiraConnections.getAuthorizationUrl).not.toHaveBeenCalled();
    // Disconnect stays available so the member can remove the remote account.
    expect((await app.inject({ method: "DELETE", url: "/me/jira-connection" })).statusCode).toBe(204);
  });

  test("maps service errors to safe statuses", async () => {
    const { app, jiraConnections } = await createApp();
    jiraConnections.selectConnection.mockRejectedValueOnce(new JiraConnectionError("account_not_found", "Jira account not found."));
    const notFound = await app.inject({ method: "PUT", url: "/me/jira-connection", payload: { accountId: "apn_x", siteId: SITE } });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({ error: "jira_account_not_found", message: "Jira account not found." });

    jiraConnections.disconnect.mockRejectedValueOnce(new JiraConnectionError("upstream_unavailable", "Pipedream is unavailable. Try again later."));
    expect((await app.inject({ method: "DELETE", url: "/me/jira-connection" })).statusCode).toBe(502);

    jiraConnections.disconnect.mockRejectedValueOnce(new JiraConnectionError("cleanup_incomplete", "Some accounts remain."));
    const incomplete = await app.inject({ method: "DELETE", url: "/me/jira-connection" });
    expect(incomplete.statusCode).toBe(502);
    expect(incomplete.json()).toEqual({ error: "jira_cleanup_incomplete", message: "Some accounts remain." });

    jiraConnections.selectConnection.mockRejectedValueOnce(new JiraConnectionError("connection_changed", "Changed."));
    expect((await app.inject({ method: "PUT", url: "/me/jira-connection", payload: { accountId: "apn_x", siteId: SITE } })).statusCode)
      .toBe(409);
  });

  test("loads sites for one account of the authenticated member", async () => {
    const { app, jiraConnections } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/me/jira-connection/accounts/apn_mine/sites",
      headers: { "x-tenant-id": "tenant-b", "x-user-id": "user-9" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sites: [connection.site] });
    expect(jiraConnections.listAccountSites).toHaveBeenCalledWith("tenant-b", "user-9", "apn_mine");

    expect((await app.inject({ method: "GET", url: "/me/jira-connection/accounts/..%2Fapn/sites" })).statusCode).toBe(400);
    jiraConnections.listAccountSites.mockRejectedValueOnce(new JiraConnectionError("upstream_unavailable", "Could not list Jira sites for this account."));
    expect((await app.inject({ method: "GET", url: "/me/jira-connection/accounts/apn_mine/sites" })).statusCode).toBe(502);
  });

  test("limits cleanup listing and retry to tenant administrators", async () => {
    const member = await createApp();
    expect((await member.app.inject({ method: "GET", url: "/admin/integrations/jira/cleanups" })).statusCode).toBe(403);
    expect((await member.app.inject({ method: "POST", url: `/admin/integrations/jira/cleanups/${CLEANUP_ID}/retry` })).statusCode)
      .toBe(403);
    expect(member.jiraConnections.listPendingCleanups).not.toHaveBeenCalled();
    expect(member.jiraConnections.retryCleanup).not.toHaveBeenCalled();

    const { app, jiraConnections } = await createApp({ isAdmin: true });
    const list = await app.inject({ method: "GET", url: "/admin/integrations/jira/cleanups", headers: { "x-tenant-id": "tenant-b" } });
    expect(list.json()).toEqual({ cleanups: [cleanup] });
    expect(jiraConnections.listPendingCleanups).toHaveBeenCalledWith("tenant-b");

    const done = await app.inject({ method: "POST", url: `/admin/integrations/jira/cleanups/${CLEANUP_ID}/retry` });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ status: "completed", remoteAccountsDeleted: 2 });
    expect(jiraConnections.retryCleanup).toHaveBeenCalledWith("tenant-a", CLEANUP_ID);

    jiraConnections.retryCleanup.mockResolvedValueOnce({ status: "failed", cleanup: { ...cleanup, attempts: 2 } });
    const failed = await app.inject({ method: "POST", url: `/admin/integrations/jira/cleanups/${CLEANUP_ID}/retry` });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: "jira_cleanup_incomplete", cleanup: { attempts: 2 } });

    jiraConnections.retryCleanup.mockRejectedValueOnce(new JiraConnectionError("cleanup_not_found", "Jira cleanup not found."));
    expect((await app.inject({ method: "POST", url: `/admin/integrations/jira/cleanups/${CLEANUP_ID}/retry` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/admin/integrations/jira/cleanups/not-a-uuid/retry" })).statusCode).toBe(400);
  });

  test("returns 204 from disconnect when no connection exists", async () => {
    const { app, jiraConnections } = await createApp();
    jiraConnections.disconnect.mockResolvedValueOnce(false);
    const response = await app.inject({ method: "DELETE", url: "/me/jira-connection" });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
  });
});
