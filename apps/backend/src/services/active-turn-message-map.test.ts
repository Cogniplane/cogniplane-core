import { describe, expect, test, vi } from "vitest";

import { ActiveTurnMessageMap } from "./active-turn-message-map.js";

describe("ActiveTurnMessageMap", () => {
  test("set + get round-trip on (sessionId, runtimeId)", () => {
    const map = new ActiveTurnMessageMap();
    map.set("s1", "r1", "msg-1", "claude-sonnet-4-6");
    expect(map.get("s1", "r1")).toEqual({
      assistantMessageId: "msg-1",
      modelName: "claude-sonnet-4-6"
    });
  });

  test("different runtimeId on the same session is isolated", () => {
    const map = new ActiveTurnMessageMap();
    map.set("s1", "r1", "msg-1", "claude-sonnet-4-6");
    map.set("s1", "r2", "msg-2", "claude-sonnet-4-6");
    expect(map.get("s1", "r1")?.assistantMessageId).toBe("msg-1");
    expect(map.get("s1", "r2")?.assistantMessageId).toBe("msg-2");
  });

  test("clear removes the mapping", () => {
    const map = new ActiveTurnMessageMap();
    map.set("s1", "r1", "msg-1", null);
    map.clear("s1", "r1");
    expect(map.get("s1", "r1")).toBeNull();
  });

  test("evicts entries older than 15 minutes on read", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-11T10:00:00Z"));
      const map = new ActiveTurnMessageMap();
      map.set("s1", "r1", "msg-1", null);
      vi.setSystemTime(new Date("2026-05-11T10:16:00Z")); // 16 minutes later
      expect(map.get("s1", "r1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
