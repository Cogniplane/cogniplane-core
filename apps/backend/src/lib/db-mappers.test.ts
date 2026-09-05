import { describe, expect, test } from "vitest";

import { isoTimestamp, isoTimestampOrNull } from "./db-mappers.js";

describe("isoTimestamp", () => {
  test("normalizes a date string to ISO", () => {
    expect(isoTimestamp("2026-06-10T12:00:00Z")).toBe("2026-06-10T12:00:00.000Z");
  });

  test("accepts Date objects (pg driver may return them)", () => {
    expect(isoTimestamp(new Date("2026-06-10T12:00:00.789Z"))).toBe("2026-06-10T12:00:00.789Z");
  });

  test.each([{}, true, null, undefined, "not-a-date", new Date(NaN)])("rejects invalid timestamp %s", (value) => {
    expect(() => isoTimestamp(value)).toThrow();
  });
});

describe("isoTimestampOrNull", () => {
  test("null and undefined map to null", () => {
    expect(isoTimestampOrNull(null)).toBeNull();
    expect(isoTimestampOrNull(undefined)).toBeNull();
  });

  test("present values are normalized to ISO", () => {
    expect(isoTimestampOrNull("2026-06-10T12:00:00Z")).toBe("2026-06-10T12:00:00.000Z");
  });

  test("preserves epoch zero and fractional seconds", () => {
    expect(isoTimestampOrNull(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(isoTimestampOrNull(new Date("2026-06-10T12:00:00.789Z"))).toBe("2026-06-10T12:00:00.789Z");
    expect(() => isoTimestampOrNull("")).toThrow();
  });
});
