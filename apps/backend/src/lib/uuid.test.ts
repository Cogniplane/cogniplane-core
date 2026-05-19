import { test, expect } from "vitest";

import { uuidv7 } from "./uuid.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("uuidv7 emits canonical UUID format with version 7 and variant 10", () => {
  const id = uuidv7();
  expect(id).toMatch(UUID_RE);
  expect(id[14]).toBe("7");
  const variantNibble = parseInt(id[19], 16);
  expect(variantNibble >= 0x8 && variantNibble <= 0xb).toBeTruthy();
});

test("uuidv7 is monotonic across rapid calls", () => {
  const ids = Array.from({ length: 5000 }, () => uuidv7());
  const sorted = [...ids].sort();
  expect(ids).toEqual(sorted);
  expect(new Set(ids).size).toBe(ids.length);
});

test("uuidv7 timestamp prefix is close to Date.now()", () => {
  const before = Date.now();
  const id = uuidv7();
  const after = Date.now();
  const tsHex = id.slice(0, 8) + id.slice(9, 13);
  const ms = parseInt(tsHex, 16);
  expect(ms >= before && ms <= after + 5).toBeTruthy();
});
