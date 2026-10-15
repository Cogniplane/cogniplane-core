import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AdminConfigError } from "../../services/admin-config-error.js";
import type { TenantMemberRecord } from "../../services/admin-config-records.js";
import type { AuditEventInput } from "../../services/audit-event-store.js";
import { FakePool } from "../../test-helpers/fake-pool.js";
import { registerAdminUserRoutes } from "./admin-user-routes.js";

function member(userId: string, overrides: Partial<TenantMemberRecord> = {}): TenantMemberRecord {
  return {
    userId, tenantId: "tenant-A", email: `${userId}@example.com`, displayName: null, role: "member",
    isBetaTester: false, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...overrides
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function buildApp(options: { isAdmin?: boolean; setUserBetaTester?: (tenantId: string, userId: string, value: boolean) => Promise<TenantMemberRecord | null> } = {}) {
  const tenantMembers = {
    listTenantMembers: vi.fn(async (tenantId: string) => [member("ana", { tenantId }), member("bo", { tenantId, role: "admin" })]),
    setUserBetaTester: vi.fn(options.setUserBetaTester ?? (async (tenantId: string, userId: string, isBetaTester: boolean) =>
      member(userId, { tenantId, isBetaTester })))
  };
  const auditEvents = { create: vi.fn(async (_input: AuditEventInput) => undefined) };
  const app = Fastify();
  apps.push(app);
  app.decorate("db", new FakePool().onQuery(/INSERT INTO users/, () => ({ rows: [], rowCount: 1 })).asPool());
  app.addHook("preHandler", async (request) => {
    const isAdmin = options.isAdmin ?? true;
    request.auth = { tenantId: "tenant-A", userId: "admin-1", isAdmin, role: isAdmin ? "admin" : "member" };
  });
  await registerAdminUserRoutes(app, { tenantMembers, auditEvents });
  return { app, tenantMembers, auditEvents };
}

const setBeta = (userId: string, payload: Record<string, unknown>, query = "") => ({
  method: "POST" as const,
  url: `/admin/users/${userId}/set-beta-tester${query}`,
  payload
});

describe("admin user routes", () => {
  test("lists the members of the caller's tenant", async () => {
    const { app, tenantMembers } = await buildApp();

    const response = await app.inject({ method: "GET", url: "/admin/users?tenantId=tenant-B" });

    expect(response.statusCode).toBe(200);
    expect(response.json().users.map((user: TenantMemberRecord) => [user.userId, user.tenantId])).toEqual([
      ["ana", "tenant-A"],
      ["bo", "tenant-A"]
    ]);
    expect(tenantMembers.listTenantMembers).toHaveBeenCalledWith("tenant-A");
  });

  test.each([
    ["GET", "/admin/users", undefined],
    ["POST", "/admin/users/ana/set-beta-tester", { isBetaTester: true }]
  ] as const)("refuses a member on %s %s before reading or writing", async (method, url, payload) => {
    const { app, tenantMembers, auditEvents } = await buildApp({ isAdmin: false });

    const response = await app.inject({ method, url, payload });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "admin_required" });
    expect(tenantMembers.listTenantMembers).not.toHaveBeenCalled();
    expect(tenantMembers.setUserBetaTester).not.toHaveBeenCalled();
    expect(auditEvents.create).not.toHaveBeenCalled();
  });

  test("marks a member as a beta tester in the caller's tenant and audits it", async () => {
    const { app, tenantMembers, auditEvents } = await buildApp();

    const response = await app.inject({ ...setBeta("bo", { isBetaTester: true, tenantId: "tenant-B" }), headers: { "user-agent": "test-agent" } });

    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ userId: "bo", tenantId: "tenant-A", isBetaTester: true });
    expect(tenantMembers.setUserBetaTester).toHaveBeenCalledWith("tenant-A", "bo", true);
    expect(auditEvents.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-A",
      userId: "admin-1",
      type: "admin.user.beta_tester_updated",
      payload: { targetUserId: "bo", isBetaTester: true },
      userAgent: "test-agent"
    }));
  });

  test("answers 404 for someone who is not a member, without an audit event", async () => {
    const { app, auditEvents } = await buildApp({ setUserBetaTester: async () => null });

    const response = await app.inject(setBeta("ghost", { isBetaTester: true }));

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "user_not_found" });
    expect(auditEvents.create).not.toHaveBeenCalled();
  });

  test.each([
    ["a user id with characters outside the id format", "Ana!", { isBetaTester: true }],
    ["a missing flag", "ana", {}],
    ["a flag that is not a boolean", "ana", { isBetaTester: "yes" }]
  ])("rejects %s before writing", async (_case, userId, payload) => {
    const { app, tenantMembers } = await buildApp();

    const response = await app.inject(setBeta(encodeURIComponent(userId), payload));

    expect(response.statusCode).toBe(400);
    expect(tenantMembers.setUserBetaTester).not.toHaveBeenCalled();
  });

  // The route rethrows unexpected errors; the app's global error handler (not
  // registered here) turns them into an opaque 500.
  test("turns a configuration error into 400 and rethrows an unexpected error", async () => {
    const config = await buildApp({ setUserBetaTester: async () => { throw new AdminConfigError("Members cannot be changed now."); } });
    const configResponse = await config.app.inject(setBeta("ana", { isBetaTester: true }));
    expect(configResponse.statusCode).toBe(400);
    expect(configResponse.json()).toEqual({ error: "invalid_config", message: "Members cannot be changed now." });

    const crash = await buildApp({ setUserBetaTester: async () => { throw new Error("connection to 10.0.0.5 refused"); } });
    const crashResponse = await crash.app.inject(setBeta("ana", { isBetaTester: true }));
    expect(crashResponse.statusCode).toBe(500);
  });
});
