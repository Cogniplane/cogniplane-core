import Fastify from "fastify";
import { describe, expect, onTestFinished, test } from "vitest";
import { registerAdminHistoryRoutes } from "../routes/admin/admin-history-routes.js";
import { AdminHistoryStore } from "../services/admin-history-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

let next = 9007199254740993n;
async function scenario() {
  const tenant = await seedTenant(), foreign = await seedTenant(), actor = await seedUser();
  await seedMembership(tenant, actor, "admin");
  await superuserPool().query("UPDATE users SET display_name='Alex' WHERE user_id=$1", [actor]);
  const add = async (payload: unknown, at: string, type = "admin.tenant_settings.updated", tenantId = tenant, userId: string | null = actor) => {
    const id = String(next++);
    await superuserPool().query("INSERT INTO audit_events(id,tenant_id,user_id,event_type,payload,created_at) VALUES($1,$2,$3,$4,$5,$6)", [id, tenantId, userId, type, JSON.stringify(payload), at]);
    return id;
  };
  return { tenant, foreign, actor, add, store: new AdminHistoryStore(appPool()) };
}

describe.skipIf(!adminDatabaseUrl())("admin history with PostgreSQL RLS", () => {
  test("paginates exact timestamps and bigint IDs, excludes private events and scopes cursors", async () => {
    const s = await scenario();
    const first = await s.add({ version: 1 }, "2026-09-27T12:00:00.000001Z");
    const second = await s.add({ version: 2 }, "2026-09-27T12:00:00.000002Z");
    const third = await s.add({ version: 3 }, "2026-09-27T12:00:00.000002Z");
    const other = await s.add({ version: 99 }, "2026-09-27T12:00:01Z", undefined, s.foreign);
    await s.add({ secret: "private" }, "2026-09-27T12:00:02Z", "session.created");
    const a = await s.store.list(s.tenant, { limit: 1 });
    const b = await s.store.list(s.tenant, { limit: 1, cursor: a.nextCursor! });
    const c = await s.store.list(s.tenant, { limit: 1, cursor: b.nextCursor! });
    expect([a.items[0]?.eventId, b.items[0]?.eventId, c.items[0]?.eventId]).toEqual([third, second, first]);
    expect(c.nextCursor).toBeNull();
    expect(a.items[0]?.actor.name).toBe("Alex");
    expect(await s.store.detail(s.tenant, other)).toBeNull();
    expect(await s.store.detail(s.tenant, third, other)).toBeNull();
    await expect(s.store.list(s.foreign, { limit: 1, cursor: a.nextCursor! })).rejects.toThrow("cursor");
    await expect(s.store.list(s.tenant, { limit: 1, category: "people", cursor: a.nextCursor! })).rejects.toThrow("cursor");
    await expect(s.store.list(s.tenant, { limit: 1, cursor: "broken" })).rejects.toThrow("cursor");
  });
  test("compares preceding or selected settings, handles missing actors and enforces route guards", async () => {
    const s = await scenario();
    const first = await s.add({ version: 1 }, "2026-09-26T12:00:00Z");
    const second = await s.add({ version: 2, allowCommandExecution: false, developerInstructions: "private-value" }, "2026-09-27T12:00:00Z");
    const third = await s.add({ version: 4, allowCommandExecution: true, developerInstructions: "another-private-value" }, "2026-09-27T12:01:00Z");
    const rule = await s.add({ ruleId: "rule-1", effect: "block", secret: "do-not-return" }, "2026-09-27T12:02:00Z", "admin.policy_rule.created", s.tenant, null);
    expect((await s.store.detail(s.tenant, first))?.comparison).toBeNull();
    expect((await s.store.detail(s.tenant, third))?.comparison?.before.eventId).toBe(second);
    const selected = await s.store.detail(s.tenant, first, third);
    expect(selected?.comparison?.before.eventId).toBe(first);
    expect(selected?.comparison?.changes.find(c => c.field === "allowCommandExecution")).toMatchObject({ before: "Not recorded", after: "On", status: "unavailable" });
    expect(JSON.stringify(selected)).not.toContain("private-value");
    expect((await s.store.detail(s.tenant, rule))?.event.actor.name).toBe("Actor no longer available");
    expect((await s.store.list(s.tenant, { limit: 25, section: "agent" })).items.map(e => e.eventId)).toEqual([third, second, first]);
    expect((await s.store.list(s.tenant, { limit: 25, category: "policies" })).items.map(e => e.eventId)).toEqual([rule]);
    await expect(s.store.detail(s.tenant, rule, first)).rejects.toThrow("Only recorded settings");
    await expect(s.store.detail(s.tenant, first, first)).rejects.toThrow("different");
    const app = Fastify(); app.decorate("db", appPool());
    app.addHook("preHandler", async request => { const isAdmin = request.headers["x-member"] !== "yes"; request.auth = { tenantId: s.tenant, userId: s.actor, role: isAdmin ? "admin" : "member", isAdmin }; });
    await registerAdminHistoryRoutes(app); onTestFinished(() => app.close());
    const response = await app.inject(`/admin/history/${third}`);
    expect(response.statusCode).toBe(200); expect(response.body).not.toContain("private-value");
    expect((await app.inject({ url: "/admin/history", headers: { "x-member": "yes" } })).statusCode).toBe(403);
  });
});
