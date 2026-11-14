import { test, expect, vi } from "vitest";
import type { Redis } from "ioredis";

import { RedisPolicyInvalidationBus } from "./policy-cache-invalidation.js";

const CHANNEL = "cogniplane:policy-cache:invalidate:v1";

type Listener = (channel: string, message: string) => void;

/**
 * Minimal ioredis stand-in for the pub/sub calls this bus uses. Each
 * `duplicate()` returns a new connection, because the bus subscribes on a copy
 * of the publisher: a subscriber connection cannot issue ordinary commands.
 */
class FakeRedis {
  readonly messageListeners: Listener[] = [];
  readonly errorListeners: ((err: Error) => void)[] = [];
  readonly subscribed: string[] = [];
  readonly published: { channel: string; message: string }[] = [];
  readonly duplicates: FakeRedis[] = [];
  /** Subscribe results of the next connections, in order; default success. */
  readonly subscribeResults: Array<Error | undefined> = [];
  subscribeResult: Error | undefined;
  disconnectCalls = 0;

  get duplicated(): FakeRedis | undefined {
    return this.duplicates.at(-1);
  }

  duplicate(): FakeRedis {
    const connection = new FakeRedis();
    connection.subscribeResult = this.subscribeResults.shift();
    this.duplicates.push(connection);
    return connection;
  }

  on(event: string, listener: Listener | ((err: Error) => void)): this {
    if (event === "message") this.messageListeners.push(listener as Listener);
    if (event === "error") this.errorListeners.push(listener as (err: Error) => void);
    return this;
  }

  removeAllListeners(event: string): this {
    if (event === "message") this.messageListeners.length = 0;
    return this;
  }

  async subscribe(channel: string): Promise<void> {
    if (this.subscribeResult) throw this.subscribeResult;
    this.subscribed.push(channel);
  }

  async publish(channel: string, message: string): Promise<void> {
    this.published.push({ channel, message });
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }

  /** Drive every registered listener, as ioredis does on an incoming message. */
  emit(channel: string, message: string) {
    for (const listener of [...this.messageListeners]) listener(channel, message);
  }
}

function busWith() {
  const publisher = new FakeRedis();
  const warn = vi.fn();
  const bus = new RedisPolicyInvalidationBus(publisher as unknown as Redis, { warn });
  return { bus, publisher, warn };
}

/** Subscribes and returns the connection that holds the subscription. */
async function subscribed(bus: RedisPolicyInvalidationBus, publisher: FakeRedis, onInvalidate: (tenantId: string) => void) {
  const subscription = bus.subscribe(onInvalidate);
  await subscription.ready;
  return { subscription, subscriber: publisher.duplicated! };
}

test("subscribe invalidates the tenant named in a message on the policy channel", async () => {
  const { bus, publisher } = busWith();
  const invalidated: string[] = [];

  const { subscriber } = await subscribed(bus, publisher, (tenantId) => invalidated.push(tenantId));
  subscriber.emit(CHANNEL, "tenant-1");

  expect(subscriber.subscribed).toEqual([CHANNEL]);
  expect(invalidated).toEqual(["tenant-1"]);
});

test("subscribe ignores messages delivered on a different channel", async () => {
  const { bus, publisher } = busWith();
  const invalidated: string[] = [];

  const { subscriber } = await subscribed(bus, publisher, (tenantId) => invalidated.push(tenantId));
  // A shared connection can receive other channels; those must not evict caches.
  subscriber.emit("cogniplane:some-other-channel", "tenant-1");

  expect(invalidated).toEqual([]);
});

test("subscribe ignores an empty tenant id", async () => {
  const { bus, publisher, warn } = busWith();
  const invalidated: string[] = [];

  const { subscriber } = await subscribed(bus, publisher, (tenantId) => invalidated.push(tenantId));
  subscriber.emit(CHANNEL, "");

  expect(invalidated).toEqual([]);
  expect(warn).toHaveBeenCalled();
});

test("subscribe ignores an over-long tenant id instead of passing it to the cache", async () => {
  const { bus, publisher, warn } = busWith();
  const invalidated: string[] = [];

  const { subscriber } = await subscribed(bus, publisher, (tenantId) => invalidated.push(tenantId));
  // Anything on the channel is untrusted input; an unbounded key would let a
  // publisher drive unbounded work in every replica that receives it.
  subscriber.emit(CHANNEL, "t".repeat(513));

  expect(invalidated).toEqual([]);
  expect(warn).toHaveBeenCalled();
});

test("subscribe accepts a tenant id at the maximum allowed length", async () => {
  const { bus, publisher } = busWith();
  const invalidated: string[] = [];
  const atLimit = "t".repeat(512);

  const { subscriber } = await subscribed(bus, publisher, (tenantId) => invalidated.push(tenantId));
  subscriber.emit(CHANNEL, atLimit);

  // The bound is inclusive: a legitimate id of exactly 512 must still work.
  expect(invalidated).toEqual([atLimit]);
});

test("close drops the listener and closes the connection", async () => {
  const { bus, publisher } = busWith();
  const invalidated: string[] = [];

  const { subscription, subscriber } = await subscribed(bus, publisher, (tenantId) => invalidated.push(tenantId));
  await subscription.close();

  expect(subscriber.disconnectCalls).toBe(1);
  expect(subscriber.messageListeners).toHaveLength(0);

  // A message arriving after teardown must not reach a torn-down cache.
  subscriber.emit(CHANNEL, "tenant-1");
  expect(invalidated).toEqual([]);
});

test("a failed first subscribe does not reject, and a background retry subscribes", async () => {
  vi.useFakeTimers();
  try {
    const { bus, publisher, warn } = busWith();
    publisher.subscribeResults.push(new Error("connect ECONNREFUSED"));
    const invalidated: string[] = [];

    const subscription = bus.subscribe((tenantId) => invalidated.push(tenantId));
    await expect(subscription.ready).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }),
      "Redis subscribe failed; retrying in the background: policy cache invalidation");
    expect(publisher.duplicates[0]!.disconnectCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(publisher.duplicates).toHaveLength(2);
    publisher.duplicates[1]!.emit(CHANNEL, "tenant-1");
    expect(invalidated).toEqual(["tenant-1"]);

    await subscription.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publisher.duplicates).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("publish sends the tenant id on the policy channel", async () => {
  const { bus, publisher } = busWith();

  await bus.publish("tenant-1");

  expect(publisher.published).toEqual([{ channel: CHANNEL, message: "tenant-1" }]);
});

test("publish and subscribe agree on the channel name", async () => {
  const { bus, publisher } = busWith();
  const invalidated: string[] = [];

  const { subscriber } = await subscribed(bus, publisher, (tenantId) => invalidated.push(tenantId));
  await bus.publish("tenant-1");
  // Round-trip the published message through the subscriber: a rename on one
  // side only would silently stop invalidating caches across replicas.
  subscriber.emit(publisher.published[0]!.channel, publisher.published[0]!.message);

  expect(invalidated).toEqual(["tenant-1"]);
});

test("subscriber connection errors are logged instead of thrown", async () => {
  const { bus, publisher, warn } = busWith();
  const { subscriber } = await subscribed(bus, publisher, () => {});

  // ioredis emits 'error' on a dropped connection; an unhandled listener here
  // would take down the process.
  expect(subscriber.errorListeners).toHaveLength(1);
  subscriber.errorListeners[0]!(new Error("connection lost"));

  expect(warn).toHaveBeenCalled();
});
