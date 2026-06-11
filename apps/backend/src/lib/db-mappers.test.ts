import { describe, expect, test } from "vitest";

import { isoTimestamp, isoTimestampOrNull } from "./db-mappers.js";

describe("isoTimestamp", () => {
  test("normalizes a date string to ISO", () => {
    expect(isoTimestamp("2026-06-10T12:00:00Z")).toBe("2026-06-10T12:00:00.000Z");
  });

  test("accepts Date objects (pg driver may return them)", () => {
    expect(isoTimestamp(new Date("2026-06-10T12:00:00Z"))).toBe("2026-06-10T12:00:00.000Z");
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
});
