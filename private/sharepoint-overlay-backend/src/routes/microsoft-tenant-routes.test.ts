import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AuditEventInput } from "../../../../apps/backend/src/services/audit-event-store.js";
import { devDataRoutes } from "../../../../apps/backend/src/test-helpers/data-routes.js";
import { InMemoryAuditEventStore } from "../../../../apps/backend/src/test-helpers/in-memory-audit-events.js";
import { registerMicrosoftTenantRoutes } from "./microsoft-tenant-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function buildApp() {
  const auditEvents = new InMemoryAuditEventStore();
  // The audit events that the service writes in the change's transaction.
  const changeAudits: AuditEventInput[] = [];
  const invalidateTenantRuntimes = vi.fn(async () => ["runtime-1"]);
  const microsoftConnections = {
    setTenantMicrosoftConfig: vi.fn(async (_tenantId: string, _patch: unknown, audit?: () => AuditEventInput) => {
      if (audit) changeAudits.push(audit());
    }),
    removeTenantMicrosoftConfig: vi.fn(async () => {})
  };
  const app = Fastify();
  apps.push(app);
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "admin-1", tenantId: "tenant-1", isAdmin: true, role: "owner" };
  });
  registerMicrosoftTenantRoutes(app, {
    microsoftConnections, auditEvents, runtimeInvalidator: { invalidateTenantRuntimes }, dataRoutes: devDataRoutes()
  });
  return { app, auditEvents, changeAudits, invalidateTenantRuntimes, microsoftConnections };
}

describe("Microsoft tenant settings routes", () => {
  test("PUT writes an audit event, with the change, that names the changed fields and never the secret", async () => {
    const { app, auditEvents, changeAudits, invalidateTenantRuntimes } = await buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/tenant/settings/microsoft",
      payload: { clientSecret: "super-secret-value", entraTenantId: "common" }
    });

    expect(response.statusCode).toBe(200);
    expect(auditEvents.events).toEqual([]);
    expect(changeAudits).toHaveLength(1);
    expect(changeAudits[0]).toMatchObject({
      userId: "admin-1",
      type: "tenant.integration.updated",
      payload: { integrationId: "microsoft", configChanged: true, changedFields: ["clientSecret", "entraTenantId"] }
    });
    expect(JSON.stringify(changeAudits)).not.toContain("super-secret-value");
    expect(invalidateTenantRuntimes).not.toHaveBeenCalled();
  });

  test("DELETE writes an audit event and resets the tenant's runtimes", async () => {
    const { app, auditEvents, invalidateTenantRuntimes, microsoftConnections } = await buildApp();

    const response = await app.inject({ method: "DELETE", url: "/tenant/settings/microsoft" });

    expect(response.statusCode).toBe(204);
    expect(microsoftConnections.removeTenantMicrosoftConfig).toHaveBeenCalledWith("tenant-1");
    expect(auditEvents.events.map((event) => [event.type, event.payload]))
      .toEqual([["tenant.integration.config_cleared", { integrationId: "microsoft" }]]);
    expect(invalidateTenantRuntimes).toHaveBeenCalledWith("tenant-1", expect.objectContaining({
      workspaceResetReason: expect.stringContaining("Microsoft 365")
    }));
  });

  test("DELETE still resets the runtimes when the audit write fails", async () => {
    const { app, auditEvents, invalidateTenantRuntimes, microsoftConnections } = await buildApp();
    auditEvents.create = async () => { throw new Error("audit unavailable"); };

    const response = await app.inject({ method: "DELETE", url: "/tenant/settings/microsoft" });

    expect(response.statusCode).toBe(500);
    expect(microsoftConnections.removeTenantMicrosoftConfig).toHaveBeenCalled();
    expect(invalidateTenantRuntimes).toHaveBeenCalledTimes(1);
  });
});
