import Fastify from "fastify";
import { afterEach, describe, expect, test } from "vitest";

import type { Pool } from "../../lib/db.js";
import { currentUtcMonth, registerAdminTokenUsageRoutes } from "./admin-token-usage-routes.js";

// SQL filtering is proven against real Postgres in
// src/integration/admin-token-usage.integration.test.ts. These tests cover
// request parsing, the bound values each aggregation receives, and the
// response contract that existing consumers rely on.

type Captured = { text: string; values: unknown[] };

async function buildApp(opts: { isAdmin?: boolean; now?: Date } = {}) {
  const captured: Captured[] = [];
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      if (!text.includes("FROM messages")) return { rows: [], rowCount: 0 };
      captured.push({ text, values });
      if (text.includes("COUNT(*)")) {
        return { rows: [{ input_tokens: 4, output_tokens: 6, total_tokens: 10, cost_usd: 0.5, message_count: 2 }] };
      }
      return { rows: [] };
    },
    release: () => {}
  };
  const db = {
    connect: async () => client,
    query: async () => ({ rows: [], rowCount: 0 })
  } as unknown as Pool;

  const app = Fastify();
  app.decorate("db", db);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: "admin-1",
      tenantId: "tenant-a",
      isAdmin: opts.isAdmin ?? true,
      role: opts.isAdmin === false ? "member" : "admin"
    };
  });
  await registerAdminTokenUsageRoutes(app, opts.now ? { now: () => opts.now! } : {});
  await app.ready();
  apps.push(app);
  return { app, captured };
}

const apps: Array<Awaited<ReturnType<typeof Fastify>>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe("currentUtcMonth", () => {
  test("returns the half-open UTC calendar month, across year ends", () => {
    expect(currentUtcMonth(new Date("2026-12-31T23:59:59.999Z"))).toEqual({
      from: new Date("2026-12-01T00:00:00.000Z"),
      to: new Date("2027-01-01T00:00:00.000Z")
    });
    expect(currentUtcMonth(new Date("2026-03-01T00:00:00.000Z")).from.toISOString()).toBe(
      "2026-03-01T00:00:00.000Z"
    );
  });
});

describe("GET /admin/token-usage", () => {
  test("rejects non-admins", async () => {
    const { app } = await buildApp({ isAdmin: false });
    expect((await app.inject({ method: "GET", url: "/admin/token-usage" })).statusCode).toBe(403);
  });

  test("keeps the rolling-window contract when no filter is given", async () => {
    const { app, captured } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/admin/token-usage?days=7" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toBe(7);
    expect(body).not.toHaveProperty("period");
    expect(body).not.toHaveProperty("range");
    expect(body).not.toHaveProperty("userId");
    expect(body.usage.totals).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10, costUsd: 0.5, messageCount: 2 });
    expect(captured).toHaveLength(4);
    for (const query of captured) expect(query.values).toEqual(["tenant-a", 7]);
  });

  test("binds the user and the exact UTC month to every aggregation", async () => {
    const { app, captured } = await buildApp({ now: new Date("2026-02-14T09:30:00Z") });
    const res = await app.inject({
      method: "GET",
      url: "/admin/token-usage?userId=user-42&period=current_month"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      days: 28,
      period: "current_month",
      range: { from: "2026-02-01T00:00:00.000Z", to: "2026-03-01T00:00:00.000Z" },
      userId: "user-42"
    });
    expect(captured).toHaveLength(4);
    for (const query of captured) {
      expect(query.values).toEqual(["tenant-a", "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", "user-42"]);
    }
  });

  test("filters one user over the rolling window", async () => {
    const { app, captured } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/admin/token-usage?userId=user-42" });
    expect(res.json()).toMatchObject({ days: 30, userId: "user-42" });
    for (const query of captured) expect(query.values).toEqual(["tenant-a", 30, "user-42"]);
  });

  test.each([
    ["an invalid user ID", "userId=Not%20An%20Id"],
    ["an empty user ID", "userId="],
    ["an unknown period", "period=last_month"]
  ])("rejects %s without querying", async (_label, query) => {
    const { app, captured } = await buildApp();
    const res = await app.inject({ method: "GET", url: `/admin/token-usage?${query}` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_query" });
    expect(captured).toHaveLength(0);
  });
});
