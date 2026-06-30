import { describe, expect, test, vi } from "vitest";
import type { Redis } from "ioredis";

import { RuntimeEgressIpPinStore } from "./runtime-egress-ip-pin.js";

function createFakePinRedis() {
  const store = new Map<string, string>();
  const ttlByKey = new Map<string, number>();
  return {
    store,
    ttlByKey,
    redis: {
      async eval(_script: string, _keyCount: number, key: string, ip: string, ttlMs: string) {
        const existing = store.get(key);
        if (existing) return [0, existing];
        store.set(key, ip);
        ttlByKey.set(key, Number(ttlMs));
        return [1, ip];
      },
      async del(key: string) {
        ttlByKey.delete(key);
        return store.delete(key) ? 1 : 0;
      }
    } as unknown as Pick<Redis, "eval" | "del">
  };
}

describe("RuntimeEgressIpPinStore", () => {
  test("first observation pins and reports `pinned`", async () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    const result = await store.checkAndPin("r1", "203.0.113.5");
    expect(result).toEqual({ kind: "pinned", ip: "203.0.113.5" });
  });

  test("subsequent matching IP returns `ok`", async () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    await store.checkAndPin("r1", "203.0.113.5");
    await expect(store.checkAndPin("r1", "203.0.113.5")).resolves.toEqual({ kind: "ok", ip: "203.0.113.5" });
  });

  test("mismatch returns `mismatch` with expected + observed", async () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    await store.checkAndPin("r1", "203.0.113.5");
    const result = await store.checkAndPin("r1", "198.51.100.42");
    expect(result).toEqual({
      kind: "mismatch",
      expectedIp: "203.0.113.5",
      observedIp: "198.51.100.42"
    });
  });

  test("strips ::ffff: prefix so dual-stack v4-mapped peers match v4 pins", async () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    await store.checkAndPin("r1", "203.0.113.5");
    expect((await store.checkAndPin("r1", "::ffff:203.0.113.5")).kind).toBe("ok");
  });

  test("different runtimeIds are isolated", async () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    await store.checkAndPin("r1", "203.0.113.5");
    expect((await store.checkAndPin("r2", "198.51.100.42")).kind).toBe("pinned");
    expect((await store.checkAndPin("r1", "203.0.113.5")).kind).toBe("ok");
  });

  test("rejects non-IP inputs as a mismatch (defense in depth)", async () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    const result = await store.checkAndPin("r1", "not-an-ip");
    expect(result.kind).toBe("mismatch");
  });

  test("evicts entries older than ttlMs and re-pins on next observation", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-11T10:00:00Z"));
      const store = new RuntimeEgressIpPinStore(60_000);
      await store.checkAndPin("r1", "203.0.113.5");
      vi.setSystemTime(new Date("2026-05-11T10:02:00Z")); // 2 min later, TTL is 60s
      const result = await store.checkAndPin("r1", "198.51.100.42");
      // Stale entry evicted; new IP becomes the pin.
      expect(result.kind).toBe("pinned");
    } finally {
      vi.useRealTimers();
    }
  });

  test("clear removes the pin so the next request re-pins", async () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    await store.checkAndPin("r1", "203.0.113.5");
    await store.clear("r1");
    expect((await store.checkAndPin("r1", "198.51.100.42")).kind).toBe("pinned");
  });

  test("Redis shares pins across independent backend store instances", async () => {
    const fake = createFakePinRedis();
    const replicaA = new RuntimeEgressIpPinStore(60_000, fake.redis);
    const replicaB = new RuntimeEgressIpPinStore(60_000, fake.redis);

    expect((await replicaA.checkAndPin("r1", "203.0.113.5")).kind).toBe("pinned");
    await expect(replicaB.checkAndPin("r1", "203.0.113.5")).resolves.toEqual({
      kind: "ok",
      ip: "203.0.113.5"
    });
    await expect(replicaB.checkAndPin("r1", "198.51.100.42")).resolves.toEqual({
      kind: "mismatch",
      expectedIp: "203.0.113.5",
      observedIp: "198.51.100.42"
    });
    expect(fake.ttlByKey.get("runtime-egress-ip:r1")).toBe(60_000);
  });

  test("Redis clear is visible to every backend store instance", async () => {
    const fake = createFakePinRedis();
    const replicaA = new RuntimeEgressIpPinStore(60_000, fake.redis);
    const replicaB = new RuntimeEgressIpPinStore(60_000, fake.redis);

    await replicaA.checkAndPin("r1", "203.0.113.5");
    await replicaA.clear("r1");
    expect((await replicaB.checkAndPin("r1", "198.51.100.42")).kind).toBe("pinned");
  });
});
