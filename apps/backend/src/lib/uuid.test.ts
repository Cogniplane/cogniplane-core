import { afterEach, beforeEach, test, expect, vi } from "vitest";

const NOW = 1_700_000_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function timestamp(id: string): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

test("uuidv7 emits canonical UUID format with version 7, variant 10 and the current timestamp", async () => {
  const { uuidv7 } = await import("./uuid.js");
  const id = uuidv7();
  expect(id).toMatch(UUID_RE);
  expect(id[14]).toBe("7");
  expect(id[19]).toMatch(/[89ab]/);
  expect(timestamp(id)).toBe(NOW);
});

test("uuidv7 stays unique and ordered within one millisecond", async () => {
  const { uuidv7 } = await import("./uuid.js");
  const ids = Array.from({ length: 8 }, () => uuidv7());
  expect(ids.map(timestamp)).toEqual(Array(8).fill(NOW));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual([...ids].sort());
});

test("uuidv7 stays ordered when the clock moves backward, then follows it forward", async () => {
  const { uuidv7 } = await import("./uuid.js");
  const first = uuidv7();
  vi.setSystemTime(NOW - 1_000);
  const backward = uuidv7();
  expect(timestamp(backward)).toBe(NOW);
  expect(backward > first).toBe(true);

  vi.setSystemTime(NOW + 1_000);
  const forward = uuidv7();
  expect(timestamp(forward)).toBe(NOW + 1_000);
  expect(forward > backward).toBe(true);
});
