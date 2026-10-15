import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, test } from "vitest";
import { TurnCoordinationBus, type StopSignal } from "../services/turn-coordination-bus.js";

// The suite skips without INTEGRATION_REDIS_URL so a local database-only run
// stays green. CI sets INTEGRATION_REQUIRE_REDIS=1 to make a missing URL fail
// the file instead: "3 skipped, exit 0" reads as a pass.
if (process.env.INTEGRATION_REQUIRE_REDIS === "1" && !process.env.INTEGRATION_REDIS_URL) {
  throw new Error("INTEGRATION_REQUIRE_REDIS=1 but INTEGRATION_REDIS_URL is not set.");
}

describe.skipIf(!process.env.INTEGRATION_REDIS_URL)("cross-replica turn event stream", () => {
  test("delivers Stop to another replica with its execution generation", async () => {
    const redis = new Redis(process.env.INTEGRATION_REDIS_URL!);
    const bus = new TurnCoordinationBus(redis);
    const signal: StopSignal = { tenantId: "test", sessionId: randomUUID(), executionId: randomUUID(),
      ownerId: "replica-a", userId: "editor" };
    try {
      let receive!: (value: typeof signal) => void;
      const received = new Promise<typeof signal>(resolve => { receive = resolve; });
      await bus.subscribeStop(receive);
      await bus.publishStop(signal);
      expect(await received).toEqual(signal);
    } finally {
      await bus.close();
      await redis.quit();
    }
  });

  test("replays, follows, and rejects a trimmed sequence", async () => {
    const redis = new Redis(process.env.INTEGRATION_REDIS_URL!);
    const bus = new TurnCoordinationBus(redis);
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
    const bus = new TurnCoordinationBus(redis);
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
});
