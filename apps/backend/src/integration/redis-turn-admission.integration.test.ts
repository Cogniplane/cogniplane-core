// Redis that stops answering must not hold turn admission. The shared Redis
// client of lib/redis.ts goes through a TCP proxy to a real Redis server.
// While the proxy holds every byte (a half-open connection after a failover),
// POST /messages answers 503 within 3 seconds and keeps no turn slot and no
// lease, so the session takes a new message when Redis answers again. The
// turn event reader keeps its long blocking read.

import { randomUUID } from "node:crypto";
import net from "node:net";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import { closeRedis, getRedis, REDIS_COMMAND_TIMEOUT_MS } from "../lib/redis.js";
import { RedisRequestLimits } from "../services/redis-request-limits.js";
import { READER_COMMAND_TIMEOUT_MS, TurnCoordinationBus } from "../services/turn-coordination-bus.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { adminDatabaseUrl, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";
import { buildMessageApp } from "./support/message-app.js";

if (process.env.INTEGRATION_REQUIRE_REDIS === "1" && !process.env.INTEGRATION_REDIS_URL) {
  throw new Error("INTEGRATION_REQUIRE_REDIS=1 but INTEGRATION_REDIS_URL is not set.");
}

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  const { FakeStreamingChatModel } = await import("@langchain/core/utils/testing");
  const { AIMessage } = await import("@langchain/core/messages");
  class ReplyModel extends FakeStreamingChatModel {
    override bindTools() { return this.withConfig({}); }
  }
  return { ...actual, initChatModel: async () => new ReplyModel({ sleep: 0, responses: [new AIMessage("Done.")] }) };
});

/**
 * Forwards TCP to Redis. `stall()` holds the bytes of both directions, as a
 * half-open connection does; `resume()` delivers them in order and forwards
 * again.
 */
async function startProxy(target: URL) {
  let stalled = false;
  const held: Array<() => void> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 6379), target.hostname);
    sockets.add(client).add(upstream);
    const relay = (from: net.Socket, to: net.Socket) => from.on("data", (chunk) => {
      if (stalled) held.push(() => to.write(chunk));
      else to.write(chunk);
    });
    relay(client, upstream);
    relay(upstream, client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on("close", close).on("error", close);
    upstream.on("close", close).on("error", close);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(target.toString());
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as net.AddressInfo).port);
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: url.toString(),
    stall: () => { stalled = true; },
    resume: () => {
      stalled = false;
      for (const deliver of held.splice(0)) deliver();
    }
  };
}

describe.skipIf(!adminDatabaseUrl() || !process.env.INTEGRATION_REDIS_URL)("turn admission while Redis does not answer", () => {
  test("POST /messages answers 503 within 3 seconds, holds no slot or lease, and the session takes the next message", async () => {
    const proxy = await startProxy(new URL(process.env.INTEGRATION_REDIS_URL!));
    const config = createTestConfig({ REDIS_URL: proxy.url });
    // The production client: lib/redis.ts with its command limit.
    const redis = getRedis(config)!;
    expect(redis.options.commandTimeout).toBe(REDIS_COMMAND_TIMEOUT_MS);
    const limits = RedisRequestLimits.fromAppConfig(redis, config);

    const tenantId = await seedTenant();
    const userId = await seedUser();
    await seedMembership(tenantId, userId);
    // The message route takes a UUID session id.
    const sessionId = randomUUID();
    await superuserPool().query(
      "INSERT INTO sessions (session_id, tenant_id, user_id, session_name) VALUES ($1, $2, $3, 'Redis outage')",
      [sessionId, tenantId, userId]
    );
    try {
    const h = await buildMessageApp({ tenantId, auth: { userId }, consumeRateLimit: (input) => limits.consumeRateLimit(input) });

    const first = await h.send(sessionId, "Hello");
    expect(first.statusCode).toBe(200);

    proxy.stall();
    const started = Date.now();
    const refused = await h.send(sessionId, "Are you there?");
    const elapsed = Date.now() - started;
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ message: "Request limits are temporarily unavailable." });
    expect(elapsed).toBeLessThan(3_000);
    // No lease was taken for the refused request: the lease of the first turn is finished.
    const leases = await superuserPool().query(
      "SELECT status FROM session_executions WHERE tenant_id = $1 AND session_id = $2", [tenantId, sessionId]
    );
    expect(leases.rows).toEqual([{ status: "finished" }]);
    expect(h.quota).toHaveBeenCalledTimes(1);

    proxy.resume();
    // The same session takes a new message: no slot or lease was left behind.
    const next = await h.send(sessionId, "Back again");
    expect(next.statusCode).toBe(200);
    expect(next.body).toContain("RUN_FINISHED");
    expect(h.quota).toHaveBeenCalledTimes(2);
    } finally {
      const keys = [
        ...await redis.keys(`rl:message_turn:*:${tenantId}`),
        ...await redis.keys(`rl:message_turn:*:${userId}`)
      ];
      if (keys.length) await redis.del(...keys);
      await closeRedis();
    }
  }, 60_000);

  test("the turn event reader waits its full block time, and the shared client stops a blocking read at its own limit", async () => {
    const config = createTestConfig({ REDIS_URL: process.env.INTEGRATION_REDIS_URL });
    const redis = getRedis(config)!;
    const bus = new TurnCoordinationBus(redis);
    const reader = bus.reader();
    onTestFinished(() => { reader.disconnect(); });
    expect(reader.options.commandTimeout).toBe(READER_COMMAND_TIMEOUT_MS);

    const turn = { tenantId: "tenant-none", sessionId: `session-${Date.now()}`, executionId: "execution-none" };
    const started = Date.now();
    // No events: Redis answers the 10-second block with nil, not a timeout.
    await expect(bus.waitForEvents(reader, turn, 0)).resolves.toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_500);

    const shared = Date.now();
    await expect(redis.call("XREAD", "BLOCK", 4_000, "STREAMS", `cogniplane:test:none:${turn.sessionId}`, "0-0"))
      .rejects.toThrow(/timed out/i);
    expect(Date.now() - shared).toBeLessThan(REDIS_COMMAND_TIMEOUT_MS + 1_000);
    // Redis still ends the block on the connection; QUIT waits behind it.
    await new Promise((resolve) => setTimeout(resolve, 4_000 - (Date.now() - shared) + 200));
    await closeRedis();
  }, 40_000);
});
