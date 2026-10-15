import type { Redis } from "ioredis";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, test } from "vitest";

import { TurnCoordinationBus, type TurnKey } from "./turn-coordination-bus.js";

type StreamRow = [string, string[]];

/**
 * The part of a Redis stream that replay() reads: XRANGE and XREVRANGE over
 * "<sequence>-0" ids, with "-", "+", and exclusive "(" bounds.
 */
class FakeStreams {
  readonly streams = new Map<string, StreamRow[]>();

  add(key: string, sequence: number, fields: string[]) {
    const rows = this.streams.get(key) ?? [];
    rows.push([`${sequence}-0`, fields]);
    rows.sort((a, b) => Number(a[0].split("-")[0]) - Number(b[0].split("-")[0]));
    this.streams.set(key, rows);
  }

  private range(key: string, start: string, end: string): StreamRow[] {
    const id = (row: StreamRow) => Number(row[0].split("-")[0]);
    const low = start === "-" ? -Infinity : Number(start.replace("(", "").split("-")[0]);
    const exclusive = start.startsWith("(");
    const high = end === "+" ? Infinity : Number(end.split("-")[0]);
    return (this.streams.get(key) ?? []).filter((row) => (exclusive ? id(row) > low : id(row) >= low) && id(row) <= high);
  }

  async xrange(key: string, start: string, end: string, ...countArgs: (string | number)[]): Promise<StreamRow[]> {
    const rows = this.range(key, start, end);
    return countArgs[0] === "COUNT" ? rows.slice(0, Number(countArgs[1])) : rows;
  }

  async xrevrange(key: string, end: string, start: string, ...countArgs: (string | number)[]): Promise<StreamRow[]> {
    const rows = this.range(key, start, end).reverse();
    return countArgs[0] === "COUNT" ? rows.slice(0, Number(countArgs[1])) : rows;
  }
}

const turn: TurnKey = { tenantId: "tenant-a", sessionId: "session-1", executionId: "exec-1" };
const key = (t: TurnKey) => `cogniplane:turn-events:v1:${t.tenantId}:${t.sessionId}:${t.executionId}`;
const event = (sequence: number): BaseEvent => ({ type: EventType.CUSTOM, name: "step", value: { sequence } } as BaseEvent);

function bus(sequences: number[], forTurn = turn) {
  const redis = new FakeStreams();
  for (const sequence of sequences) redis.add(key(forTurn), sequence, ["event", JSON.stringify(event(sequence))]);
  return { bus: new TurnCoordinationBus(redis as unknown as Redis), redis };
}

const sequencesOf = (entries: { sequence: number }[] | null) => entries?.map((entry) => entry.sequence) ?? null;

describe("TurnCoordinationBus.replay", () => {
  test("returns every event after the requested sequence, with its parsed event and size", async () => {
    const { bus: b } = bus([1, 2, 3]);

    const entries = await b.replay(turn, 1);

    expect(sequencesOf(entries)).toEqual([2, 3]);
    expect(entries![0]).toEqual({ sequence: 2, event: event(2), bytes: Buffer.byteLength(JSON.stringify(event(2))) });
    expect(sequencesOf(await b.replay(turn, 0))).toEqual([1, 2, 3]);
    // A caller that has everything gets an empty list, not a reset.
    expect(await b.replay(turn, 3)).toEqual([]);
  });

  test("starts an empty stream from the beginning only", async () => {
    const { bus: b } = bus([]);

    expect(await b.replay(turn, 0)).toEqual([]);
    expect(await b.replay(turn, 2)).toBeNull();
  });

  test("refuses a sequence the stream has trimmed away or never reached", async () => {
    // Events 1 and 2 were trimmed; 3 to 5 remain.
    const { bus: b } = bus([3, 4, 5]);

    expect(await b.replay(turn, 0)).toBeNull();
    expect(await b.replay(turn, 1)).toBeNull();
    expect(sequencesOf(await b.replay(turn, 2))).toEqual([3, 4, 5]);
    expect(await b.replay(turn, 6)).toBeNull();
  });

  test("refuses a stream with a gap after the requested sequence", async () => {
    const { bus: b } = bus([1, 2, 4]);

    expect(await b.replay(turn, 0)).toBeNull();
    expect(sequencesOf(await b.replay(turn, 2))).toBeNull();
    expect(await b.replay(turn, 4)).toEqual([]);
  });

  test("treats a row without an event field as a gap", async () => {
    const { bus: b, redis } = bus([1]);
    redis.add(key(turn), 2, ["other", "x"]);
    redis.add(key(turn), 3, ["event", JSON.stringify(event(3))]);

    expect(await b.replay(turn, 1)).toBeNull();
  });

  test("reads only the stream of its own tenant, session, and execution", async () => {
    const other: TurnKey = { ...turn, tenantId: "tenant-b" };
    const { bus: b, redis } = bus([1, 2]);
    redis.add(key(other), 1, ["event", JSON.stringify(event(99))]);

    expect(await b.replay(other, 0)).toEqual([{ sequence: 1, event: event(99), bytes: Buffer.byteLength(JSON.stringify(event(99))) }]);
    expect(sequencesOf(await b.replay({ ...turn, executionId: "exec-2" }, 0))).toEqual([]);
  });
});
