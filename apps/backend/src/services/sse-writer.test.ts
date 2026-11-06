import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { SSE_DRAIN_DEADLINE_MS, SseWriter } from "./sse-writer.js";

/** A response whose socket buffer stays full until the test emits "drain". */
class BlockedResponse extends EventEmitter {
  readonly writes: string[] = [];
  writableEnded = false;
  destroyed = false;
  destroyCalls = 0;
  accepts = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.accepts;
  }

  end(): void {
    this.writableEnded = true;
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.destroyed = true;
    // Node emits "close" on a later tick.
    process.nextTick(() => this.emit("close"));
  }
}

const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a drain releases the write, clears its deadline, and keeps the response open", async () => {
  const raw = new BlockedResponse();
  const writer = new SseWriter(raw);

  // Each stall gets one listener and one deadline; neither builds up.
  for (const frame of ["a", "b", "c"]) {
    const pending = writer.write(frame);
    expect(raw.listenerCount("drain")).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(SSE_DRAIN_DEADLINE_MS - 1);
    raw.emit("drain");
    await pending;
    expect(raw.listenerCount("drain")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  }

  await vi.advanceTimersByTimeAsync(SSE_DRAIN_DEADLINE_MS);
  expect(raw.destroyCalls).toBe(0);
  expect(writer.isClosed).toBe(false);
  raw.accepts = true;
  await writer.write("d");
  expect(vi.getTimerCount()).toBe(0);
  expect(raw.writes).toEqual(["a", "b", "c", "d"]);
});

test("a disconnect releases the write and detaches its drain listener", async () => {
  const raw = new BlockedResponse();
  const writer = new SseWriter(raw);
  const onClose = vi.fn();
  writer.onClose(onClose);

  const pending = writer.write("a");
  raw.emit("close");
  await pending;

  expect(raw.listenerCount("drain")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(onClose).toHaveBeenCalledOnce();
  expect(raw.destroyCalls).toBe(0);
  await writer.write("b");
  expect(raw.writes).toEqual(["a"]);
});

test("the deadline closes a stalled connection and releases every pending write", async () => {
  const raw = new BlockedResponse();
  const writer = new SseWriter(raw);
  const onClose = vi.fn();
  writer.onClose(onClose);
  const released: string[] = [];

  const frame = writer.write("frame").then(() => released.push("frame"));
  // A heartbeat during the stall shares the same listener and deadline.
  const heartbeat = writer.write(": keep-alive\n\n").then(() => released.push("heartbeat"));
  expect(raw.listenerCount("drain")).toBe(1);
  expect(vi.getTimerCount()).toBe(1);

  await vi.advanceTimersByTimeAsync(SSE_DRAIN_DEADLINE_MS - 1);
  expect(released).toEqual([]);
  expect(raw.destroyCalls).toBe(0);

  await vi.advanceTimersByTimeAsync(1);
  await Promise.all([frame, heartbeat]);
  expect(released).toEqual(["frame", "heartbeat"]);
  expect(raw.destroyCalls).toBe(1);
  expect(writer.isClosed).toBe(true);
  expect(onClose).toHaveBeenCalledOnce();
  expect(raw.listenerCount("drain")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);

  // The close event from destroy() does not run the callbacks again.
  await nextTick();
  expect(onClose).toHaveBeenCalledOnce();
  // A drain after the deadline has no listener left to run.
  raw.emit("drain");
  await writer.write("late");
  writer.end();
  expect(raw.writes).toEqual(["frame", ": keep-alive\n\n"]);
  expect(raw.writableEnded).toBe(false);
  expect(raw.destroyCalls).toBe(1);
});

test("a callback added after the deadline runs at once", async () => {
  const raw = new BlockedResponse();
  const writer = new SseWriter(raw, { drainDeadlineMs: 5 });
  const pending = writer.write("a");
  await vi.advanceTimersByTimeAsync(5);
  await pending;

  const onClose = vi.fn();
  writer.onClose(onClose);
  expect(onClose).toHaveBeenCalledOnce();
});

test("a response without destroy() is ended at the deadline", async () => {
  const drain = new EventEmitter();
  let ended = false;
  const raw = {
    write: () => false,
    end: () => { ended = true; },
    once: (event: "drain", listener: () => void) => drain.once(event, listener),
    removeListener: (event: "drain", listener: () => void) => drain.removeListener(event, listener)
  };
  const writer = new SseWriter(raw, { drainDeadlineMs: 5 });

  const pending = writer.write("a");
  await vi.advanceTimersByTimeAsync(5);
  await pending;

  expect(ended).toBe(true);
  expect(writer.isClosed).toBe(true);
  expect(drain.listenerCount("drain")).toBe(0);
});
