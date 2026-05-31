import { test, expect } from "vitest";

import { AsyncQueue } from "./async-queue.js";

test("push() then iterate yields values in order; end() closes the iterator", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  q.push(3);
  q.end();
  const out: number[] = [];
  for await (const v of q) out.push(v);
  expect(out).toEqual([1, 2, 3]);
});

test("push() returns false after end()", () => {
  const q = new AsyncQueue<number>();
  q.end();
  expect(q.push(1)).toBe(false);
});

test("end() is idempotent", () => {
  const q = new AsyncQueue<number>();
  q.end();
  q.end();
  // Still closed; no throw.
});

test("a waiter is woken up by a subsequent push without buffering", async () => {
  const q = new AsyncQueue<string>();
  const next = q.next();
  q.push("hello");
  const result = await next;
  expect(result).toEqual({ value: "hello", done: false });
});

test("end() resolves a pending waiter with done=true", async () => {
  const q = new AsyncQueue<string>();
  const next = q.next();
  q.end();
  const result = await next;
  expect(result.done).toBe(true);
});

test("push respects maxSize and returns false once buffer is full", () => {
  const q = new AsyncQueue<number>(2);
  expect(q.push(1)).toBe(true);
  expect(q.push(2)).toBe(true);
  // Buffer full
  expect(q.push(3)).toBe(false);
});

test("a value pushed when a waiter is parked goes to the waiter, not the buffer", async () => {
  const q = new AsyncQueue<string>(1);
  const next = q.next();
  q.push("delivered");
  await next;
  // Buffer still empty so we can push another even with maxSize=1
  expect(q.push("buffered")).toBe(true);
});

test("draining buffered values after end() still yields them", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  q.end();
  const r1 = await q.next();
  const r2 = await q.next();
  const r3 = await q.next();
  expect(r1).toEqual({ value: 1, done: false });
  expect(r2).toEqual({ value: 2, done: false });
  expect(r3.done).toBe(true);
});

test("next() returns done=true on a queue that ends with empty buffer", async () => {
  const q = new AsyncQueue<number>();
  q.end();
  const result = await q.next();
  expect(result.done).toBe(true);
});

test("setError() rejects a consumer currently blocked in next()", async () => {
  const q = new AsyncQueue<number>();
  const pending = q.next();
  const boom = new Error("producer failed");
  q.setError(boom);
  await expect(pending).rejects.toBe(boom);
});

test("setError() makes all subsequent next() calls throw", async () => {
  const q = new AsyncQueue<number>();
  const boom = new Error("producer failed");
  q.setError(boom);
  await expect(q.next()).rejects.toBe(boom);
  await expect(q.next()).rejects.toBe(boom);
});

test("setError() unblocks a for-await consumer instead of hanging", async () => {
  const q = new AsyncQueue<number>();
  const boom = new Error("producer failed");
  const consumed: number[] = [];
  const consumer = (async () => {
    for await (const v of q) {
      consumed.push(v);
    }
  })();
  q.push(1);
  // Let the consumer pick up the buffered value and block on the next read.
  await Promise.resolve();
  q.setError(boom);
  await expect(consumer).rejects.toBe(boom);
});

test("setError() is terminal: first error wins, end()/push() are no-ops after", () => {
  const q = new AsyncQueue<number>();
  const first = new Error("first");
  q.setError(first);
  q.setError(new Error("second"));
  q.end();
  expect(q.push(99)).toBe(false);
});
