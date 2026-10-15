import Fastify from "fastify";
import { expect, onTestFinished, test, vi } from "vitest";
import { AdminMcpWidgetDomainsSchema, CSP_SOURCE_ERROR_MESSAGES, type AdminMcpWidgetDomains } from "@cogniplane/shared-types";
import { CSP_SOURCE_VECTORS } from "@cogniplane/shared-types/csp-source-vectors";
import type { Pool } from "../../lib/db.js";
import type { AdminMcpServerRecord } from "../../services/admin-config-records.js";
import { AdminConfigError } from "../../services/admin-config-error.js";
import type { AuditEventInput } from "../../services/audit-event-store.js";
import { FakeDatabase } from "../../test-helpers/fake-database.js";
import { registerAdminMcpServerRoutes } from "./admin-mcp-server-routes.js";

const server: AdminMcpServerRecord = {
  serverId: "research", ownerTenantId: "tenant-a", serverName: "Research", description: null,
  transportKind: "http", mode: "proxy", routePath: "/mcp/research", upstreamUrl: "https://vendor.com/mcp",
  upstreamAuthType: "none", upstreamAuthName: null, upstreamAuthConfigured: false,
  credentialScope: "organization", credentialBindingId: "binding", version: 3, configHash: "a".repeat(64),
  enabled: true, isPublished: true, createdBy: "admin-a", createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z"
};
const managed: AdminMcpServerRecord = { ...server, serverId: "managed", mode: "managed", routePath: "/mcp/managed" };
const view: AdminMcpWidgetDomains = {
  serverId: "research",
  approved: [{ directive: "connectDomains", source: "https://api.vendor.com", approvedBy: "admin-a", approvedAt: "2026-10-14T10:00:00.000Z" }],
  requested: [{ directive: "resourceDomains", source: "https://cdn.vendor.com",
    firstSeenAt: "2026-10-13T10:00:00.000Z", lastSeenAt: "2026-10-14T09:00:00.000Z" }]
};
const base = "/admin/mcp-servers/research/widget-domains";

async function setup(isAdmin = true) {
  const app = Fastify();
  onTestFinished(() => app.close());
  app.decorate("db", new FakeDatabase() as unknown as Pool);
  app.addHook("preHandler", async request => {
    request.auth = { tenantId: "tenant-a", userId: "admin-a", isAdmin, role: isAdmin ? "owner" : "member" };
  });
  const audits: AuditEventInput[] = [];
  const mcpAppCsp = {
    listForAdmin: vi.fn(async () => view),
    approve: vi.fn(async (_tenant: string, _server: string, _entry: unknown, _actor: string, audit: () => AuditEventInput) => {
      audits.push(audit());
      return true;
    }),
    revoke: vi.fn(async (_tenant: string, _server: string, _directive: string, _sources: readonly string[],
      audit: () => AuditEventInput) => {
      audits.push(audit());
      return true;
    })
  };
  const dynamicConfig: Parameters<typeof registerAdminMcpServerRoutes>[1]["dynamicConfig"] = {
    listMcpServers: vi.fn(async () => [server, managed]),
    getOrCreateTenantSettings: vi.fn(),
    createMcpServer: vi.fn(), updateMcpServer: vi.fn(), disableMcpServer: vi.fn(),
    setMcpServerPublished: vi.fn(), saveMcpServerWithAudience: vi.fn(), setInheritedMcpAudience: vi.fn()
  };
  await registerAdminMcpServerRoutes(app, { dynamicConfig, mcpAppCsp });
  return { app, mcpAppCsp, audits, dynamicConfig };
}

test("lists the approved and requested domains of a proxy server, in the response contract", async () => {
  const { app, mcpAppCsp } = await setup();
  const response = await app.inject({ method: "GET", url: base });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(AdminMcpWidgetDomainsSchema.parse(response.json().widgetDomains)).toEqual(view);
  expect(mcpAppCsp.listForAdmin).toHaveBeenCalledExactlyOnceWith("tenant-a", "research");
});

test("rejects a member before any read or change", async () => {
  const { app, mcpAppCsp, dynamicConfig } = await setup(false);
  const payload = { directive: "connectDomains", source: "https://api.vendor.com" };
  expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: `${base}/approve`, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: `${base}/revoke`, payload })).statusCode).toBe(403);
  expect(mcpAppCsp.listForAdmin).not.toHaveBeenCalled();
  expect(mcpAppCsp.approve).not.toHaveBeenCalled();
  expect(mcpAppCsp.revoke).not.toHaveBeenCalled();
  expect(dynamicConfig.listMcpServers).not.toHaveBeenCalled();
});

test("answers 404 for an unknown server and for a managed server, which has no widget domains", async () => {
  const { app, mcpAppCsp } = await setup();
  const payload = { directive: "connectDomains", source: "https://api.vendor.com" };
  for (const serverId of ["unknown", "managed"]) {
    const url = `/admin/mcp-servers/${serverId}/widget-domains`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `${url}/approve`, payload })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `${url}/revoke`, payload })).statusCode).toBe(404);
  }
  expect(mcpAppCsp.listForAdmin).not.toHaveBeenCalled();
  expect(mcpAppCsp.approve).not.toHaveBeenCalled();
  expect(mcpAppCsp.revoke).not.toHaveBeenCalled();
});

test("approves a normalized source for the admin's tenant and records who did it", async () => {
  const { app, mcpAppCsp, audits } = await setup();
  const response = await app.inject({
    method: "POST", url: `${base}/approve`,
    headers: { "user-agent": "vitest" },
    payload: { directive: "connectDomains", source: " HTTPS://API.Vendor.com:443 " }
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().widgetDomains).toEqual(view);
  expect(mcpAppCsp.approve).toHaveBeenCalledExactlyOnceWith(
    "tenant-a", "research", { directive: "connectDomains", source: "https://api.vendor.com" }, "admin-a", expect.any(Function)
  );
  expect(audits).toEqual([expect.objectContaining({
    tenantId: "tenant-a", userId: "admin-a", sessionId: null, type: "admin.mcp_server.widget_domain_approved",
    payload: { serverId: "research", directive: "connectDomains", source: "https://api.vendor.com" },
    userAgent: "vitest"
  })]);
});

test.each(CSP_SOURCE_VECTORS.map((vector) => [vector.name, vector] as const))(
  "applies the shared source rules to an approval of %s",
  async (_name, vector) => {
    const { app, mcpAppCsp } = await setup();
    const response = await app.inject({
      method: "POST", url: `${base}/approve`, payload: { directive: vector.directive, source: vector.source }
    });
    if (vector.reason === null) {
      expect(response.statusCode).toBe(200);
      expect(mcpAppCsp.approve).toHaveBeenCalledExactlyOnceWith(
        "tenant-a", "research", { directive: vector.directive, source: vector.normalized }, "admin-a", expect.any(Function)
      );
    } else {
      // The empty source and the over-long source fail the request schema before the rules run.
      expect(response.statusCode).toBe(400);
      expect(mcpAppCsp.approve).not.toHaveBeenCalled();
      if (vector.reason !== "empty" && vector.reason !== "too_long") {
        expect(response.json().message).toBe(CSP_SOURCE_ERROR_MESSAGES[vector.reason]);
      }
    }
  }
);

test("rejects an unknown source list, extra fields and caller-supplied identity", async () => {
  const { app, mcpAppCsp } = await setup();
  for (const payload of [
    {}, { source: "https://api.vendor.com" }, { directive: "connectDomains" },
    { directive: "scriptDomains", source: "https://api.vendor.com" },
    { directive: "connectDomains", source: "https://api.vendor.com", tenantId: "tenant-b" },
    { directive: "connectDomains", source: "https://api.vendor.com", approvedBy: "someone-else" },
    { directive: "connectDomains", source: 42 }
  ]) {
    expect((await app.inject({ method: "POST", url: `${base}/approve`, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${base}/revoke`, payload })).statusCode).toBe(400);
  }
  expect(mcpAppCsp.approve).not.toHaveBeenCalled();
  expect(mcpAppCsp.revoke).not.toHaveBeenCalled();
});

test("returns the store's own message when the approval limit is reached", async () => {
  const { app, mcpAppCsp } = await setup();
  mcpAppCsp.approve.mockRejectedValueOnce(new AdminConfigError("A server can have at most 200 approved domains. Remove one first."));
  const response = await app.inject({
    method: "POST", url: `${base}/approve`, payload: { directive: "connectDomains", source: "https://api.vendor.com" }
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().message).toContain("at most 200 approved domains");
});

test("leaves an unexpected store error to the global error handler instead of answering as bad input", async () => {
  const { app, mcpAppCsp } = await setup();
  mcpAppCsp.approve.mockRejectedValueOnce(new Error("connection refused"));
  const response = await app.inject({
    method: "POST", url: `${base}/approve`, payload: { directive: "connectDomains", source: "https://api.vendor.com" }
  });
  expect(response.statusCode).toBe(500);
  expect(response.json().code).toBeUndefined();
});

test("removes an approval, tries the normal form and the spelling that was sent, and audits it", async () => {
  const { app, mcpAppCsp, audits } = await setup();
  const response = await app.inject({
    method: "POST", url: `${base}/revoke`, payload: { directive: "connectDomains", source: "HTTPS://API.vendor.com" }
  });
  expect(response.statusCode).toBe(200);
  expect(mcpAppCsp.revoke).toHaveBeenCalledExactlyOnceWith(
    "tenant-a", "research", "connectDomains", ["https://api.vendor.com", "HTTPS://API.vendor.com"], expect.any(Function)
  );
  expect(audits).toEqual([expect.objectContaining({
    tenantId: "tenant-a", userId: "admin-a", type: "admin.mcp_server.widget_domain_revoked",
    payload: { serverId: "research", directive: "connectDomains", source: "https://api.vendor.com" }
  })]);
});

test("can remove an approval that today's rules would no longer accept", async () => {
  const { app, mcpAppCsp } = await setup();
  const response = await app.inject({
    method: "POST", url: `${base}/revoke`, payload: { directive: "connectDomains", source: "https://*.old-suffix.example" }
  });
  expect(response.statusCode).toBe(200);
  expect(mcpAppCsp.revoke).toHaveBeenCalledExactlyOnceWith(
    "tenant-a", "research", "connectDomains", ["https://*.old-suffix.example"], expect.any(Function)
  );
});
