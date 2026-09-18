import { test, expect, vi } from "vitest";
import type { Redis } from "ioredis";

import { RedisPolicyInvalidationBus } from "./policy-cache-invalidation.js";

const CHANNEL = "cogniplane:policy-cache:invalidate:v1";

type Listener = (channel: string, message: string) => void;

/**
 * Minimal ioredis stand-in for the pub/sub surface this bus uses. `duplicate()`
 * returns a second instance because the bus subscribes on a copy of the
 * publisher — a subscriber connection cannot issue ordinary commands.
 */
class FakeRedis {
  readonly messageListeners: Listener[] = [];
  readonly errorListeners: ((err: Error) => void)[] = [];
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];
  readonly published: { channel: string; message: string }[] = [];
  duplicated: FakeRedis | undefined;
  quitCalls = 0;

  duplicate(): FakeRedis {
    this.duplicated = new FakeRedis();
    return this.duplicated;
  }

  on(event: string, listener: Listener | ((err: Error) => void)): this {
    if (event === "message") this.messageListeners.push(listener as Listener);
    if (event === "error") this.errorListeners.push(listener as (err: Error) => void);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    if (event === "message") {
      const index = this.messageListeners.indexOf(listener);
      if (index >= 0) this.messageListeners.splice(index, 1);
    }
    return this;
  }

  async subscribe(channel: string): Promise<void> {
    this.subscribed.push(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.unsubscribed.push(channel);
  }

  async publish(channel: string, message: string): Promise<void> {
    this.published.push({ channel, message });
  }

  async quit(): Promise<void> {
    this.quitCalls += 1;
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
  // `duplicate()` runs in the constructor, so the subscriber exists by now.
  const subscriber = publisher.duplicated!;
  return { bus, publisher, subscriber, warn };
}

test("subscribe invalidates the tenant named in a message on the policy channel", async () => {
  const { bus, subscriber } = busWith();
  const invalidated: string[] = [];

  await bus.subscribe((tenantId) => invalidated.push(tenantId));
  subscriber.emit(CHANNEL, "tenant-1");

  expect(subscriber.subscribed).toEqual([CHANNEL]);
  expect(invalidated).toEqual(["tenant-1"]);
});

test("subscribe ignores messages delivered on a different channel", async () => {
  const { bus, subscriber } = busWith();
  const invalidated: string[] = [];

  await bus.subscribe((tenantId) => invalidated.push(tenantId));
  // A shared connection can receive other channels; those must not evict caches.
  subscriber.emit("cogniplane:some-other-channel", "tenant-1");

  expect(invalidated).toEqual([]);
});

test("subscribe ignores an empty tenant id", async () => {
  const { bus, subscriber, warn } = busWith();
  const invalidated: string[] = [];

  await bus.subscribe((tenantId) => invalidated.push(tenantId));
  subscriber.emit(CHANNEL, "");

  expect(invalidated).toEqual([]);
  expect(warn).toHaveBeenCalled();
});

test("subscribe ignores an over-long tenant id instead of passing it to the cache", async () => {
  const { bus, subscriber, warn } = busWith();
  const invalidated: string[] = [];

  await bus.subscribe((tenantId) => invalidated.push(tenantId));
  // Anything on the channel is untrusted input; an unbounded key would let a
  // publisher drive unbounded work in every replica that receives it.
  subscriber.emit(CHANNEL, "t".repeat(513));

  expect(invalidated).toEqual([]);
  expect(warn).toHaveBeenCalled();
});

test("subscribe accepts a tenant id at the maximum allowed length", async () => {
  const { bus, subscriber } = busWith();
  const invalidated: string[] = [];
  const atLimit = "t".repeat(512);

  await bus.subscribe((tenantId) => invalidated.push(tenantId));
  subscriber.emit(CHANNEL, atLimit);

  // The bound is inclusive: a legitimate id of exactly 512 must still work.
  expect(invalidated).toEqual([atLimit]);
});

test("the returned teardown unsubscribes, drops the listener, and closes the connection", async () => {
  const { bus, subscriber } = busWith();
  const invalidated: string[] = [];

  const stop = await bus.subscribe((tenantId) => invalidated.push(tenantId));
  await stop();

  expect(subscriber.unsubscribed).toEqual([CHANNEL]);
  expect(subscriber.quitCalls).toBe(1);
  expect(subscriber.messageListeners).toHaveLength(0);

  // A message arriving after teardown must not reach a torn-down cache.
  subscriber.emit(CHANNEL, "tenant-1");
  expect(invalidated).toEqual([]);
});

test("publish sends the tenant id on the policy channel", async () => {
  const { bus, publisher } = busWith();

  await bus.publish("tenant-1");

  expect(publisher.published).toEqual([{ channel: CHANNEL, message: "tenant-1" }]);
});

test("publish and subscribe agree on the channel name", async () => {
  const { bus, publisher, subscriber } = busWith();
  const invalidated: string[] = [];

  await bus.subscribe((tenantId) => invalidated.push(tenantId));
  await bus.publish("tenant-1");
  // Round-trip the published message through the subscriber: a rename on one
  // side only would silently stop invalidating caches across replicas.
  subscriber.emit(publisher.published[0]!.channel, publisher.published[0]!.message);

  expect(invalidated).toEqual(["tenant-1"]);
});

test("subscriber connection errors are logged instead of thrown", async () => {
  const { subscriber, warn } = busWith();

  // ioredis emits 'error' on a dropped connection; an unhandled listener here
  // would take down the process.
  expect(subscriber.errorListeners).toHaveLength(1);
  subscriber.errorListeners[0]!(new Error("connection lost"));

  expect(warn).toHaveBeenCalled();
});
