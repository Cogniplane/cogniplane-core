import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";

import { FakePool, type QueryResultRow } from "../test-helpers/fake-pool.js";
import { registerMessageFeedbackRoutes } from "./message-feedback-routes.js";

const MESSAGE_ID = "0b6a3b4c-58b7-4c5e-9d8a-2f0e4a7c1d93";

type Rows = { totals: QueryResultRow[]; daily: QueryResultRow[]; byModel: QueryResultRow[] };

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function buildApp(options: { isAdmin?: boolean; rows?: Partial<Rows>; updated?: boolean } = {}) {
  const rows: Rows = { totals: [], daily: [], byModel: [], ...options.rows };
  const pool = new FakePool()
    .onQuery(/INSERT INTO users/, () => ({ rows: [], rowCount: 1 }))
    // The grouped queries first: the totals pattern also matches the per-model query.
    .onQuery(/GROUP BY DATE\(/, () => ({ rows: rows.daily, rowCount: rows.daily.length }))
    .onQuery(/GROUP BY COALESCE\(model_name/, () => ({ rows: rows.byModel, rowCount: rows.byModel.length }))
    .onQuery(/COUNT\(\*\)::int\s+AS total\s+FROM messages/, () => ({ rows: rows.totals, rowCount: rows.totals.length }));
  const updateFeedback = vi.fn(async () => options.updated ?? true);
  const app = Fastify();
  apps.push(app);
  app.decorate("db", pool.asPool());
  app.addHook("preHandler", async (request) => {
    const isAdmin = options.isAdmin ?? true;
    request.auth = { tenantId: "tenant-A", userId: "user-1", isAdmin, role: isAdmin ? "admin" : "member" };
  });
  await registerMessageFeedbackRoutes(app, { messages: { updateFeedback } });
  return { app, pool, updateFeedback };
}

/** The tenant and window bound to each report query. */
const reportValues = (pool: FakePool) =>
  pool.queries.filter((query) => query.text.includes("FROM messages")).map((query) => query.values);

describe("PATCH /messages/:messageId/feedback", () => {
  test("stores the rating for the caller's tenant and user, with no notes by default", async () => {
    const { app, updateFeedback } = await buildApp();

    const response = await app.inject({ method: "PATCH", url: `/messages/${MESSAGE_ID}/feedback`, payload: { rating: "thumbs_up", tenantId: "tenant-B" } });

    expect(response.statusCode).toBe(204);
    expect(updateFeedback).toHaveBeenCalledWith("tenant-A", MESSAGE_ID, "user-1", "thumbs_up", null);
  });

  test("passes notes through", async () => {
    const { app, updateFeedback } = await buildApp();

    await app.inject({ method: "PATCH", url: `/messages/${MESSAGE_ID}/feedback`, payload: { rating: "thumbs_down", notes: "Wrong file." } });

    expect(updateFeedback).toHaveBeenCalledWith("tenant-A", MESSAGE_ID, "user-1", "thumbs_down", "Wrong file.");
  });

  test("answers 404 when the message is not the caller's", async () => {
    const { app } = await buildApp({ updated: false });

    const response = await app.inject({ method: "PATCH", url: `/messages/${MESSAGE_ID}/feedback`, payload: { rating: "thumbs_up" } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "message_not_found" });
  });

  test.each([
    ["a message id that is not a UUID", "/messages/not-a-uuid/feedback", { rating: "thumbs_up" }],
    ["an unknown rating", `/messages/${MESSAGE_ID}/feedback`, { rating: "meh" }],
    ["notes over 2,000 characters", `/messages/${MESSAGE_ID}/feedback`, { rating: "thumbs_up", notes: "x".repeat(2001) }]
  ])("rejects %s before writing", async (_case, url, payload) => {
    const { app, updateFeedback } = await buildApp();

    const response = await app.inject({ method: "PATCH", url, payload });

    expect(response.statusCode).toBe(400);
    expect(updateFeedback).not.toHaveBeenCalled();
  });
});

describe("GET /admin/message-feedback", () => {
  test("refuses a member before any report query", async () => {
    const { app, pool } = await buildApp({ isAdmin: false });

    const response = await app.inject({ method: "GET", url: "/admin/message-feedback" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "admin_required" });
    expect(reportValues(pool)).toEqual([]);
  });

  test.each([
    [undefined, 30],
    ["1", 1],
    ["7", 7],
    ["365", 365],
    ["0", 30],
    ["366", 30],
    ["soon", 30]
  ])("reads days=%s as a %i-day window for the caller's tenant", async (days, window) => {
    const { app, pool } = await buildApp();

    const response = await app.inject({ method: "GET", url: days === undefined ? "/admin/message-feedback" : `/admin/message-feedback?days=${days}&tenantId=tenant-B` });

    expect(response.statusCode).toBe(200);
    expect(response.json().days).toBe(window);
    expect(reportValues(pool)).toEqual([["tenant-A", window], ["tenant-A", window], ["tenant-A", window]]);
  });

  test("rejects a repeated days parameter", async () => {
    const { app } = await buildApp();

    const response = await app.inject({ method: "GET", url: "/admin/message-feedback?days=7&days=30" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_query" });
  });

  test("reports totals, days, and models with a rounded rate", async () => {
    const { app } = await buildApp({
      rows: {
        totals: [{ thumbs_up: 2, thumbs_down: 1, total: 3 }],
        daily: [{ date: "2026-10-01", thumbs_up: 2, thumbs_down: 1 }],
        byModel: [
          { model_name: "model-a", thumbs_up: 1, thumbs_down: 2, total: 3 },
          { model_name: "unknown", thumbs_up: 0, thumbs_down: 0, total: 0 }
        ]
      }
    });

    const { stats } = (await app.inject({ method: "GET", url: "/admin/message-feedback" })).json();

    expect(stats).toEqual({
      totals: { thumbsUp: 2, thumbsDown: 1, total: 3, ratePercent: 67 },
      daily: [{ date: "2026-10-01", thumbsUp: 2, thumbsDown: 1 }],
      byModel: [
        { modelName: "model-a", thumbsUp: 1, thumbsDown: 2, total: 3, ratePercent: 33 },
        { modelName: "unknown", thumbsUp: 0, thumbsDown: 0, total: 0, ratePercent: null }
      ]
    });
  });

  test("reports zeros and no rate when there is no feedback", async () => {
    const { app } = await buildApp();

    const { stats } = (await app.inject({ method: "GET", url: "/admin/message-feedback" })).json();

    expect(stats).toEqual({ totals: { thumbsUp: 0, thumbsDown: 0, total: 0, ratePercent: null }, daily: [], byModel: [] });
  });
});
