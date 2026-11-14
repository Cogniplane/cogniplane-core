import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Redis } from "ioredis";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, test, vi } from "vitest";
import { RedisSubscription } from "../lib/redis-subscription.js";
import { TurnCoordinationBus, type StopSignal } from "../services/turn-coordination-bus.js";

/** A loopback port with no listener: a connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// The suite skips without INTEGRATION_REDIS_URL so a local database-only run
// stays green. CI sets INTEGRATION_REQUIRE_REDIS=1 to make a missing URL fail
// the file instead: "3 skipped, exit 0" reads as a pass.
if (process.env.INTEGRATION_REQUIRE_REDIS === "1" && !process.env.INTEGRATION_REDIS_URL) {
  throw new Error("INTEGRATION_REQUIRE_REDIS=1 but INTEGRATION_REDIS_URL is not set.");
}

describe.skipIf(!process.env.INTEGRATION_REDIS_URL)("cross-replica turn event stream", () => {
  test("delivers Stop to another replica with its execution generation", async () => {
    const redis = new Redis(process.env.INTEGRATION_REDIS_URL!);
    const bus = new TurnCoordinationBus(redis, { warn: () => {} });
    const signal: StopSignal = { tenantId: "test", sessionId: randomUUID(), executionId: randomUUID(),
      ownerId: "replica-a", userId: "editor" };
    try {
      let receive!: (value: typeof signal) => void;
      const received = new Promise<typeof signal>(resolve => { receive = resolve; });
      await bus.subscribeStop(receive);
      await bus.publishStop(signal);
      expect(await received).toEqual(signal);
    } finally {
      bus.close();
      await redis.quit();
    }
  });

  test("replays, follows, and rejects a trimmed sequence", async () => {
    const redis = new Redis(process.env.INTEGRATION_REDIS_URL!);
    const bus = new TurnCoordinationBus(redis, { warn: () => {} });
    const turn = { tenantId: "test", sessionId: randomUUID(), executionId: randomUUID() };
    const key = `cogniplane:turn-events:v1:${turn.tenantId}:${turn.sessionId}:${turn.executionId}`;
    const reader = bus.reader();
    try {
      const start = { type: EventType.RUN_STARTED, threadId: turn.sessionId, runId: "run" } as BaseEvent;
      await bus.append(turn, { sequence: 1, event: start, bytes: 1 });
      expect(await bus.replay(turn, 0)).toMatchObject([{ sequence: 1, event: start }]);
      const next = bus.waitForEvents(reader, turn, 1);
      const finish = { type: EventType.RUN_FINISHED, threadId: turn.sessionId, runId: "run" } as BaseEvent;
      await bus.append(turn, { sequence: 2, event: finish, bytes: 1 });
      expect(await next).toMatchObject([{ sequence: 2, event: finish }]);
      for (let sequence = 3; sequence <= 4; sequence += 1) {
        await bus.append(turn, { sequence, event: {
          type: EventType.CUSTOM, name: "large", value: { text: "x".repeat(600_000) }
        } as BaseEvent, bytes: 600_000 });
      }
      expect(await bus.replay(turn, 0)).toBeNull();
      expect((await bus.replay(turn, 3))?.map(entry => entry.sequence)).toEqual([4]);
      expect(await bus.waitForEvents(reader, turn, 1)).toBeNull();
    } finally {
      reader.disconnect();
      await redis.del(key, `${key}:sizes`, `${key}:total`);
      await redis.quit();
    }
  });

  test("rejects a missing middle event during replay and follow", async () => {
    const redis = new Redis(process.env.INTEGRATION_REDIS_URL!);
    const bus = new TurnCoordinationBus(redis, { warn: () => {} });
    const turn = { tenantId: "test", sessionId: randomUUID(), executionId: randomUUID() };
    const key = `cogniplane:turn-events:v1:${turn.tenantId}:${turn.sessionId}:${turn.executionId}`;
    const reader = bus.reader();
    const event = { type: EventType.CUSTOM, name: "test", value: {} } as BaseEvent;
    try {
      await bus.append(turn, { sequence: 1, event, bytes: 1 });
      await bus.append(turn, { sequence: 3, event, bytes: 1 });
      expect(await bus.replay(turn, 0)).toBeNull();
      expect(await bus.waitForEvents(reader, turn, 1)).toBeNull();
    } finally {
      reader.disconnect();
      await redis.del(key, `${key}:sizes`, `${key}:total`);
      await redis.quit();
    }
  });

  test("a subscription whose first attempt fails subscribes on a retry, and close ends it", async () => {
    const redis = new Redis(process.env.INTEGRATION_REDIS_URL!);
    const channel = `cogniplane:test:${randomUUID()}`;
    const port = await closedPort();
    const clients: Redis[] = [];
    const warn = vi.fn();
    let receive!: (payload: string) => void;
    const received = new Promise<string>((resolve) => { receive = resolve; });
    const { subscription, ready } = RedisSubscription.open({
      // The first attempt goes to a refused port, as during a Redis outage.
      connect: () => {
        const client = clients.length === 0
          ? new Redis({ host: "127.0.0.1", port, lazyConnect: true, maxRetriesPerRequest: 1 })
          : redis.duplicate();
        clients.push(client);
        return client;
      },
      channel,
      name: "integration test",
      logger: { warn },
      onMessage: receive,
      retryMinMs: 100
    });
    try {
      expect(await ready).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      // The failed connection stops: no reconnect loop is left behind.
      // (ioredis keeps the status "reconnecting" after disconnect() clears its
      // reconnect timer, so count the attempts instead.)
      let attempts = 0;
      clients[0]!.on("connecting", () => { attempts += 1; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(attempts).toBe(0);

      await vi.waitFor(() => expect(subscription.isSubscribed).toBe(true), { timeout: 5_000 });
      expect(clients).toHaveLength(2);
      await redis.publish(channel, "hello");
      expect(await received).toBe("hello");

      subscription.close();
      await vi.waitFor(() => expect(clients[1]!.status).toBe("end"));
      expect(await redis.publish(channel, "after close")).toBe(0);
    } finally {
      subscription.close();
      await redis.quit();
    }
  });

  test("disconnect ends a reader blocked in XREAD at once", async () => {
    const redis = new Redis(process.env.INTEGRATION_REDIS_URL!);
    const bus = new TurnCoordinationBus(redis, { warn: () => {} });
    const turn = { tenantId: "test", sessionId: randomUUID(), executionId: randomUUID() };
    const reader = bus.reader();
    try {
      // XREAD BLOCK waits up to 10 s for an event that never comes.
      const waiting = bus.waitForEvents(reader, turn, 0);
      await vi.waitFor(() => expect(reader.status).toBe("ready"));
      const started = Date.now();
      reader.disconnect();
      await expect(waiting).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      reader.disconnect();
      await redis.quit();
    }
  });
});
