import { describe, expect, test } from "vitest";

import { MessageStore } from "../services/message-store.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenant, seedUser, seedSession } from "./support/fixtures.js";

const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 };

async function seedMessage() {
  const tenantId = await seedTenant();
  const userId = await seedUser();
  const sessionId = await seedSession(tenantId, userId);
  const messages = new MessageStore(appPool());
  const message = await messages.create({ tenantId, userId, sessionId, role: "assistant", status: "streaming", content: "" });
  const cost = async () => (await superuserPool().query<{ cost: string | null }>(
    "SELECT cost_usd::text AS cost FROM messages WHERE message_id = $1", [message.messageId])).rows[0]!.cost;
  const add = (costUsd?: number | null) =>
    messages.addTokenUsage(tenantId, message.messageId, userId, usage, "gpt-6-luna", costUsd);
  return { cost, add };
}

describe.skipIf(!adminDatabaseUrl())("message cost accumulation", () => {
  test("adds the cost of each turn written to the same message", async () => {
    const m = await seedMessage();
    await m.add(0.1);
    await m.add(0.25);
    expect(Number(await m.cost())).toBeCloseTo(0.35, 8);
    // A write without a cost leaves the cost as it is.
    await m.add();
    expect(Number(await m.cost())).toBeCloseTo(0.35, 8);
  });

  test("keeps the cost unknown once one turn has no price", async () => {
    const m = await seedMessage();
    await m.add(0.1);
    expect(Number(await m.cost())).toBeCloseTo(0.1, 8);
    await m.add(null);
    expect(await m.cost()).toBeNull();
    await m.add(0.2);
    expect(await m.cost()).toBeNull();
  });

  test("treats a legacy row with tokens and no cost as unknown", async () => {
    const m = await seedMessage();
    // Usage written without a cost, as the titling path and older rows do.
    await m.add();
    expect(await m.cost()).toBeNull();
    await m.add(0.2);
    expect(await m.cost()).toBeNull();
  });
});
