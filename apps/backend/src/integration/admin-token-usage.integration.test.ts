import Fastify from "fastify";
import { describe, expect, onTestFinished, test } from "vitest";

import { registerAdminTokenUsageRoutes } from "../routes/admin/admin-token-usage-routes.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedSession, seedTenant, seedUser } from "./support/fixtures.js";

// The person page reads one member's usage for the current UTC calendar month.
// These tests prove the SQL filter, not a fake of it: month edges, other
// members, other tenants, and a member who ranks outside the top-50 byUser
// list that the unfiltered report returns.

const NOW = new Date("2026-03-15T12:00:00.000Z");

async function seedUsage(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
  createdAt: string;
  totalTokens: number;
  modelName?: string;
  costUsd?: number;
  role?: "assistant" | "user";
}): Promise<void> {
  const input_tokens = Math.floor(input.totalTokens / 2);
  await superuserPool().query(
    `
      INSERT INTO messages
        (message_id, tenant_id, session_id, user_id, role, status, content_text, created_at, updated_at,
         input_tokens, output_tokens, total_tokens, model_name, cost_usd)
      VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'completed', '', $5::timestamptz, $5::timestamptz,
              $6, $7, $8, $9, $10)
    `,
    [
      input.tenantId,
      input.sessionId,
      input.userId,
      input.role ?? "assistant",
      input.createdAt,
      input_tokens,
      input.totalTokens - input_tokens,
      input.totalTokens,
      input.modelName ?? "model-a",
      input.costUsd ?? 0
    ]
  );
}

async function buildApp(tenantId: string, adminId: string) {
  const app = Fastify();
  app.decorate("db", appPool());
  app.addHook("preHandler", async (request) => {
    request.auth = { tenantId, userId: adminId, role: "admin", isAdmin: true };
  });
  await registerAdminTokenUsageRoutes(app, { now: () => NOW });
  onTestFinished(() => app.close());
  return app;
}

async function seedScenario() {
  const tenantId = await seedTenant();
  const otherTenantId = await seedTenant();
  const adminId = await seedUser();
  const targetId = await seedUser();
  const otherId = await seedUser();
  await seedMembership(tenantId, adminId, "admin");
  await seedMembership(otherTenantId, adminId, "admin");
  for (const userId of [targetId, otherId]) await seedMembership(tenantId, userId);
  await seedMembership(otherTenantId, targetId);

  const targetSession = await seedSession(tenantId, targetId);
  const usage = (createdAt: string, totalTokens: number, extra: Partial<Parameters<typeof seedUsage>[0]> = {}) =>
    seedUsage({ tenantId, userId: targetId, sessionId: targetSession, createdAt, totalTokens, ...extra });

  // Month edges: the last instant before the month and the first instant of
  // the next month are excluded; the first and last instants are included.
  await usage("2026-02-28T23:59:59.999Z", 1000);
  await usage("2026-03-01T00:00:00.000Z", 10, { modelName: "model-a", costUsd: 0.01 });
  await usage("2026-03-31T23:59:59.999Z", 20, { modelName: "model-b", costUsd: 0.02 });
  await usage("2026-04-01T00:00:00.000Z", 3000);
  // User turns never count as model usage.
  await usage("2026-03-10T00:00:00.000Z", 4000, { role: "user" });

  // Another member of the same tenant.
  await seedUsage({
    tenantId, userId: otherId, sessionId: await seedSession(tenantId, otherId),
    createdAt: "2026-03-10T00:00:00.000Z", totalTokens: 5000
  });

  // The same person in another tenant.
  await seedUsage({
    tenantId: otherTenantId, userId: targetId, sessionId: await seedSession(otherTenantId, targetId),
    createdAt: "2026-03-10T00:00:00.000Z", totalTokens: 7000, modelName: "model-foreign"
  });

  // Fifty heavier members push the target out of the unfiltered top 50.
  for (let index = 0; index < 50; index += 1) {
    const heavyId = await seedUser();
    await seedMembership(tenantId, heavyId);
    await seedUsage({
      tenantId, userId: heavyId, sessionId: await seedSession(tenantId, heavyId),
      createdAt: "2026-03-05T00:00:00.000Z", totalTokens: 100
    });
  }

  return { tenantId, otherTenantId, adminId, targetId, otherId };
}

describe.skipIf(!adminDatabaseUrl())("admin token usage for one member", () => {
  // node-postgres turns a DATE into a Date at local midnight. East of UTC that
  // instant is the previous UTC day, so the day must reach JSON as text.
  test("keeps each day's date on a server east of UTC", async () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "Europe/Paris";
    onTestFinished(() => {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    });
    // Setting TZ only moves the clock in a child process, not in a worker thread.
    expect(new Date(2026, 2, 1).getTimezoneOffset()).toBe(-60);
    const s = await seedScenario();
    const app = await buildApp(s.tenantId, s.adminId);

    const body = (await app.inject({
      method: "GET",
      url: `/admin/token-usage?period=current_month&userId=${s.targetId}`
    })).json();

    expect(body.usage.daily.map((d: { date: string }) => d.date)).toEqual(["2026-03-01", "2026-03-31"]);
  });

  test("scopes daily, model, user, and total aggregations to one member and the exact UTC month", async () => {
    const s = await seedScenario();
    const app = await buildApp(s.tenantId, s.adminId);

    const unfiltered = (await app.inject({ method: "GET", url: "/admin/token-usage?period=current_month" })).json();
    expect(unfiltered.usage.byUser).toHaveLength(50);
    expect(unfiltered.usage.byUser.map((row: { userId: string }) => row.userId)).not.toContain(s.targetId);

    const res = await app.inject({
      method: "GET",
      url: `/admin/token-usage?period=current_month&userId=${s.targetId}`
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      days: 31,
      period: "current_month",
      range: { from: "2026-03-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z" },
      userId: s.targetId
    });
    expect(body.usage.totals).toEqual({
      inputTokens: 15, outputTokens: 15, totalTokens: 30, costUsd: 0.03, messageCount: 2
    });
    expect(body.usage.daily.map((d: { date: string; totalTokens: number }) => [d.date, d.totalTokens])).toEqual([
      ["2026-03-01", 10],
      ["2026-03-31", 20]
    ]);
    expect(body.usage.byUser).toEqual([
      { userId: s.targetId, inputTokens: 15, outputTokens: 15, totalTokens: 30, costUsd: 0.03 }
    ]);
    expect(body.usage.byModel.map((m: { modelName: string; totalTokens: number }) => [m.modelName, m.totalTokens])).toEqual([
      ["model-b", 20],
      ["model-a", 10]
    ]);
  });

  test("returns only the other tenant's usage when an admin there asks for the same person", async () => {
    const s = await seedScenario();
    const app = await buildApp(s.otherTenantId, s.adminId);
    const body = (await app.inject({
      method: "GET",
      url: `/admin/token-usage?period=current_month&userId=${s.targetId}`
    })).json();
    expect(body.usage.totals).toMatchObject({ totalTokens: 7000, messageCount: 1 });
    expect(body.usage.byModel.map((m: { modelName: string }) => m.modelName)).toEqual(["model-foreign"]);
  });

  test("returns empty aggregations for a member without usage", async () => {
    const s = await seedScenario();
    const app = await buildApp(s.tenantId, s.adminId);
    const body = (await app.inject({
      method: "GET",
      url: `/admin/token-usage?period=current_month&userId=${s.adminId}`
    })).json();
    expect(body.usage).toEqual({
      daily: [],
      byUser: [],
      byModel: [],
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, messageCount: 0 }
    });
  });
});
