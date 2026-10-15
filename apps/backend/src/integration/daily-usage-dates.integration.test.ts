import Fastify from "fastify";
import { describe, expect, onTestFinished, test } from "vitest";

import { registerMessageFeedbackRoutes } from "../routes/message-feedback-routes.js";
import { registerSettingsRoutes, type SettingsRouteStores } from "../routes/settings.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedMembership, seedSession, seedTenant, seedUser } from "./support/fixtures.js";

// node-postgres returns a DATE column as a JS Date at local midnight. These
// routes must still report each day as "YYYY-MM-DD", whatever the server time
// zone, and must count only the caller's tenant (and user, for /me).

const DAY_MS = 24 * 60 * 60 * 1000;
// Noon UTC two days ago: inside the default 30-day window, away from midnight.
const twoDaysAgo = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS - 2 * DAY_MS + 12 * 60 * 60 * 1000);
const fortyDaysAgo = new Date(twoDaysAgo.getTime() - 38 * DAY_MS);
const expectedDate = twoDaysAgo.toISOString().slice(0, 10);

/**
 * Run the test east of UTC, where a DATE read as a local-midnight Date and
 * printed with toISOString() lands on the previous day. Setting TZ only moves
 * the clock in a child process, not in a worker thread, so check that it took.
 */
function runEastOfUtc() {
  const previousTz = process.env.TZ;
  process.env.TZ = "Europe/Paris";
  onTestFinished(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
  expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-60);
}

async function seedAssistantMessage(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
  at: Date;
  totalTokens: number | null;
  role?: "assistant" | "user";
  feedback?: "thumbs_up" | "thumbs_down";
}): Promise<void> {
  await superuserPool().query(
    `
      INSERT INTO messages
        (message_id, tenant_id, session_id, user_id, role, status, content_text, created_at, updated_at,
         input_tokens, output_tokens, total_tokens, model_name, cost_usd, feedback_rating, feedback_given_at)
      VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'completed', '', $5::timestamptz, $5::timestamptz,
              $6, $7, $8, 'model-a', 0.5, $9, CASE WHEN $9::text IS NULL THEN NULL ELSE $5::timestamptz END)
    `,
    [
      input.tenantId, input.sessionId, input.userId, input.role ?? "assistant", input.at.toISOString(),
      input.totalTokens === null ? null : Math.floor(input.totalTokens / 2),
      input.totalTokens === null ? null : input.totalTokens - Math.floor(input.totalTokens / 2),
      input.totalTokens, input.feedback ?? null
    ]
  );
}

async function seedScenario() {
  const tenantId = await seedTenant();
  const otherTenantId = await seedTenant();
  const userId = await seedUser();
  const otherUserId = await seedUser();
  await seedMembership(tenantId, userId, "admin");
  await seedMembership(tenantId, otherUserId);
  await seedMembership(otherTenantId, userId);
  const session = await seedSession(tenantId, userId);
  const otherSession = await seedSession(tenantId, otherUserId);
  const foreignSession = await seedSession(otherTenantId, userId);

  // Counted for /me (this user) and for the tenant feedback report.
  await seedAssistantMessage({ tenantId, userId, sessionId: session, at: twoDaysAgo, totalTokens: 100, feedback: "thumbs_up" });
  await seedAssistantMessage({ tenantId, userId, sessionId: session, at: twoDaysAgo, totalTokens: 50, feedback: "thumbs_down" });
  // Not counted: user turns, turns without token data, and turns outside the window.
  // The user turn carries feedback too, so only the role filter can exclude it.
  await seedAssistantMessage({ tenantId, userId, sessionId: session, at: twoDaysAgo, totalTokens: 999, role: "user", feedback: "thumbs_down" });
  await seedAssistantMessage({ tenantId, userId, sessionId: session, at: twoDaysAgo, totalTokens: null });
  await seedAssistantMessage({ tenantId, userId, sessionId: session, at: fortyDaysAgo, totalTokens: 999, feedback: "thumbs_up" });
  // Another member: counted for the tenant feedback report only.
  await seedAssistantMessage({ tenantId, userId: otherUserId, sessionId: otherSession, at: twoDaysAgo, totalTokens: 7, feedback: "thumbs_up" });
  // The same person in another tenant: never counted.
  await seedAssistantMessage({ tenantId: otherTenantId, userId, sessionId: foreignSession, at: twoDaysAgo, totalTokens: 999, feedback: "thumbs_down" });

  return { tenantId, userId };
}

async function buildApp(tenantId: string, userId: string) {
  const app = Fastify();
  app.decorate("db", appPool());
  app.addHook("preHandler", async (request) => {
    request.auth = { tenantId, userId, role: "admin", isAdmin: true };
  });
  // /me/token-usage reads only app.db. Any other settings dependency in use
  // would be a test bug, so each one fails loudly.
  const unused = new Proxy({}, {
    get(_target, property) {
      throw new Error(`/me/token-usage must not use settings dependency "${String(property)}"`);
    }
  });
  await registerSettingsRoutes(app, unused as SettingsRouteStores);
  await registerMessageFeedbackRoutes(app, {
    messages: { async updateFeedback() { throw new Error("feedback writes are not part of this test"); } }
  });
  onTestFinished(() => app.close());
  return app;
}

describe.skipIf(!adminDatabaseUrl())("daily usage and feedback dates", () => {
  test("/me/token-usage reports the caller's days as YYYY-MM-DD", async () => {
    runEastOfUtc();
    const { tenantId, userId } = await seedScenario();
    const app = await buildApp(tenantId, userId);

    const response = await app.inject({ method: "GET", url: "/me/token-usage" });

    expect(response.statusCode).toBe(200);
    const { usage, days } = response.json();
    expect(days).toBe(30);
    expect(usage.daily).toEqual([{ date: expectedDate, inputTokens: 75, outputTokens: 75, totalTokens: 150, costUsd: 1 }]);
    expect(usage.totals).toEqual({ inputTokens: 75, outputTokens: 75, totalTokens: 150, costUsd: 1, messageCount: 2 });
    expect(usage.byModel).toEqual([{ modelName: "model-a", inputTokens: 75, outputTokens: 75, totalTokens: 150, costUsd: 1 }]);
  });

  test("/admin/message-feedback reports the tenant's days as YYYY-MM-DD", async () => {
    runEastOfUtc();
    const { tenantId, userId } = await seedScenario();
    const app = await buildApp(tenantId, userId);

    const response = await app.inject({ method: "GET", url: "/admin/message-feedback" });

    expect(response.statusCode).toBe(200);
    const { stats } = response.json();
    expect(stats.daily).toEqual([{ date: expectedDate, thumbsUp: 2, thumbsDown: 1 }]);
    expect(stats.totals).toEqual({ thumbsUp: 2, thumbsDown: 1, total: 3, ratePercent: 67 });
    expect(stats.byModel).toEqual([{ modelName: "model-a", thumbsUp: 2, thumbsDown: 1, total: 3, ratePercent: 67 }]);
  });
});
