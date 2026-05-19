import { test, expect, describe } from "vitest";

import { computeNextCronRunAt } from "./cron.js";

describe("computeNextCronRunAt", () => {
  const NOW = new Date("2026-05-09T12:34:56.000Z");

  test("returns the next ISO timestamp at minute precision in UTC", () => {
    // every minute, UTC — should be 12:35:00
    const next = computeNextCronRunAt("* * * * *", "UTC", NOW);
    expect(next).toBe("2026-05-09T12:35:00.000Z");
  });

  test("hourly @ minute=0 gives the next top-of-hour", () => {
    expect(computeNextCronRunAt("0 * * * *", "UTC", NOW)).toBe("2026-05-09T13:00:00.000Z");
  });

  test("respects timezone (America/New_York: 0 9 * * * is 13:00 UTC during EDT)", () => {
    // NOW is 2026-05-09 12:34 UTC = 2026-05-09 08:34 EDT (UTC-4)
    // Next 09:00 EDT = 13:00 UTC same day
    expect(computeNextCronRunAt("0 9 * * *", "America/New_York", NOW)).toBe(
      "2026-05-09T13:00:00.000Z"
    );
  });

  test("does not re-fire at the current minute when expression matches now", () => {
    // every minute, NOW is 12:34:56 — next match must be 12:35, not 12:34.
    const next = computeNextCronRunAt("* * * * *", "UTC", NOW);
    expect(next).toBe("2026-05-09T12:35:00.000Z");
  });

  test("throws on empty expression", () => {
    expect(() => computeNextCronRunAt("", "UTC", NOW)).toThrow(
      /5 space-separated fields/
    );
  });

  test("throws on six-field (with seconds) expression — minute precision contract", () => {
    expect(() => computeNextCronRunAt("0 0 * * * *", "UTC", NOW)).toThrow(
      /5 space-separated fields/
    );
  });

  test("throws on alias forms like @daily", () => {
    expect(() => computeNextCronRunAt("@daily", "UTC", NOW)).toThrow(
      /5 space-separated fields/
    );
  });

  test("throws on invalid expression", () => {
    expect(() => computeNextCronRunAt("nope nope nope nope nope", "UTC", NOW)).toThrow();
  });

  test("throws on invalid timezone", () => {
    expect(() => computeNextCronRunAt("* * * * *", "Mars/Olympus", NOW)).toThrow();
  });

  test("uses current Date by default when no `now` is passed", () => {
    const result = computeNextCronRunAt("* * * * *", "UTC");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  });

  test("trims whitespace before counting fields", () => {
    expect(computeNextCronRunAt("   0 * * * *  ", "UTC", NOW)).toBe(
      "2026-05-09T13:00:00.000Z"
    );
  });
});
