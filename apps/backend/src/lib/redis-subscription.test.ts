import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { RedisSubscription, type SubscriberRedis } from "./redis-subscription.js";

const CHANNEL = "test:channel";

/** One connection. The test settles its subscribe call. */
class FakeConnection extends EventEmitter {
  disconnects = 0;
  subscribed: string[] = [];
  private settle?: { resolve: () => void; reject: (error: Error) => void };

  subscribe(channel: string): Promise<number> {
    this.subscribed.push(channel);
    return new Promise<number>((resolve, reject) => {
      this.settle = { resolve: () => resolve(1), reject };
    });
  }

  succeed(): void { this.settle?.resolve(); }
  fail(error = new Error("connect ECONNREFUSED")): void { this.settle?.reject(error); }

  disconnect(): void {
    this.disconnects += 1;
    // ioredis rejects the queued command of a closed connection.
    this.settle?.reject(new Error("Connection is closed."));
  }
}

function fixture(options: { attemptTimeoutMs?: number } = {}) {
  const connections: FakeConnection[] = [];
  const messages: string[] = [];
  const warn = vi.fn();
  const { subscription, ready } = RedisSubscription.open({
    connect: () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection as unknown as SubscriberRedis;
    },
    channel: CHANNEL,
    name: "test channel",
    logger: { warn },
    onMessage: (payload) => messages.push(payload),
    retryMinMs: 1_000,
    retryMaxMs: 4_000,
    attemptTimeoutMs: options.attemptTimeoutMs ?? 5_000
  });
  return { subscription, ready, connections, messages, warn };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a failed first subscribe logs once, closes its connection, and a retry subscribes later", async () => {
  const { subscription, ready, connections, messages, warn } = fixture();
  connections[0]!.fail();

  await expect(ready).resolves.toBe(false);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]![1]).toBe("Redis subscribe failed; retrying in the background: test channel");
  expect(connections[0]!.disconnects).toBe(1);
  expect(connections[0]!.listenerCount("message")).toBe(0);
  // The failed connection keeps an error listener while it closes.
  expect(connections[0]!.listenerCount("error")).toBe(1);
  expect(subscription.isSubscribed).toBe(false);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(connections).toHaveLength(2);
  connections[1]!.succeed();
  await vi.advanceTimersByTimeAsync(0);
  expect(subscription.isSubscribed).toBe(true);

  // One handler: the message arrives once, and the old connection delivers nothing.
  connections[1]!.emit("message", CHANNEL, "payload-1");
  connections[0]!.emit("message", CHANNEL, "stale");
  connections[1]!.emit("message", "other:channel", "ignored");
  expect(messages).toEqual(["payload-1"]);

  subscription.close();
  expect(connections[1]!.disconnects).toBe(1);
  connections[1]!.emit("message", CHANNEL, "after-close");
  expect(messages).toEqual(["payload-1"]);
});

test("one attempt runs at a time, and the retry delay doubles up to its maximum", async () => {
  const { subscription, connections } = fixture();
  connections[0]!.fail();
  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(999);
  expect(connections).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(connections).toHaveLength(2);
  connections[1]!.fail();
  await vi.advanceTimersByTimeAsync(1_999);
  expect(connections).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(connections).toHaveLength(3);
  connections[2]!.fail();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(connections).toHaveLength(4);
  connections[3]!.fail();
  // The maximum holds: 4 s, not 8 s.
  await vi.advanceTimersByTimeAsync(4_000);
  expect(connections).toHaveLength(5);

  subscription.close();
});

test("an attempt that does not answer times out, and its late result is ignored", async () => {
  const { subscription, ready, connections, warn } = fixture({ attemptTimeoutMs: 500 });

  await vi.advanceTimersByTimeAsync(500);
  await expect(ready).resolves.toBe(false);
  expect(warn).toHaveBeenCalledOnce();
  expect(connections[0]!.disconnects).toBe(1);

  connections[0]!.succeed();
  await vi.advanceTimersByTimeAsync(0);
  expect(subscription.isSubscribed).toBe(false);

  subscription.close();
});

test("close during the first attempt ends it, logs nothing, and starts no retry", async () => {
  const { subscription, ready, connections, warn } = fixture();

  subscription.close();

  await expect(ready).resolves.toBe(false);
  expect(connections[0]!.disconnects).toBe(1);
  expect(connections[0]!.listenerCount("message")).toBe(0);
  expect(warn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(connections).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("close while a retry waits cancels it", async () => {
  const { subscription, connections } = fixture();
  connections[0]!.fail();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);

  subscription.close();

  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(connections).toHaveLength(1);
});

test("an error on a subscribed connection is logged with fixed text; ioredis reconnects it", async () => {
  const { subscription, ready, connections, warn } = fixture();
  connections[0]!.succeed();
  await expect(ready).resolves.toBe(true);

  connections[0]!.emit("error", new Error("read ECONNRESET"));

  expect(warn).toHaveBeenCalledWith({ err: expect.any(Error) }, "Redis subscriber error: test channel");
  // No new connection: after a successful subscribe, ioredis resubscribes by itself.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(connections).toHaveLength(1);
  subscription.close();
});
