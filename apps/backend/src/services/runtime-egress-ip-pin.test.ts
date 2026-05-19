import { describe, expect, test, vi } from "vitest";

import { RuntimeEgressIpPinStore } from "./runtime-egress-ip-pin.js";

describe("RuntimeEgressIpPinStore", () => {
  test("first observation pins and reports `pinned`", () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    const result = store.checkAndPin("r1", "203.0.113.5");
    expect(result).toEqual({ kind: "pinned", ip: "203.0.113.5" });
  });

  test("subsequent matching IP returns `ok`", () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    store.checkAndPin("r1", "203.0.113.5");
    expect(store.checkAndPin("r1", "203.0.113.5")).toEqual({ kind: "ok", ip: "203.0.113.5" });
  });

  test("mismatch returns `mismatch` with expected + observed", () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    store.checkAndPin("r1", "203.0.113.5");
    const result = store.checkAndPin("r1", "198.51.100.42");
    expect(result).toEqual({
      kind: "mismatch",
      expectedIp: "203.0.113.5",
      observedIp: "198.51.100.42"
    });
  });

  test("strips ::ffff: prefix so dual-stack v4-mapped peers match v4 pins", () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    store.checkAndPin("r1", "203.0.113.5");
    expect(store.checkAndPin("r1", "::ffff:203.0.113.5").kind).toBe("ok");
  });

  test("different runtimeIds are isolated", () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    store.checkAndPin("r1", "203.0.113.5");
    expect(store.checkAndPin("r2", "198.51.100.42").kind).toBe("pinned");
    expect(store.checkAndPin("r1", "203.0.113.5").kind).toBe("ok");
  });

  test("rejects non-IP inputs as a mismatch (defense in depth)", () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    const result = store.checkAndPin("r1", "not-an-ip");
    expect(result.kind).toBe("mismatch");
  });

  test("evicts entries older than ttlMs and re-pins on next observation", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-11T10:00:00Z"));
      const store = new RuntimeEgressIpPinStore(60_000);
      store.checkAndPin("r1", "203.0.113.5");
      vi.setSystemTime(new Date("2026-05-11T10:02:00Z")); // 2 min later, TTL is 60s
      const result = store.checkAndPin("r1", "198.51.100.42");
      // Stale entry evicted; new IP becomes the pin.
      expect(result.kind).toBe("pinned");
    } finally {
      vi.useRealTimers();
    }
  });

  test("clear removes the pin so the next request re-pins", () => {
    const store = new RuntimeEgressIpPinStore(60_000);
    store.checkAndPin("r1", "203.0.113.5");
    store.clear("r1");
    expect(store.checkAndPin("r1", "198.51.100.42").kind).toBe("pinned");
  });
});
