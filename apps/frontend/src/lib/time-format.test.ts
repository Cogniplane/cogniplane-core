import { describe, expect, test } from "vitest";

import { withUtcDateLocale } from "../test-helpers/date-locale";

import { formatMediumDateTime, formatTimestamp } from "./time-format";

withUtcDateLocale();

describe("formatTimestamp", () => {
  test("nullish returns em dash", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp(undefined)).toBe("—");
    expect(formatTimestamp("")).toBe("—");
  });

  test("custom fallback is used for nullish input", () => {
    expect(formatTimestamp(null, "never")).toBe("never");
  });

  test("invalid date returns input verbatim", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });

  test("valid ISO renders its calendar date and time", () => {
    const out = formatTimestamp("2026-04-30T12:00:00Z");
    expect(out).toBe("4/30/2026, 12:00:00 PM");
  });
});

describe("formatMediumDateTime", () => {
  test("nullish returns the provided fallback", () => {
    expect(formatMediumDateTime(null, "Not available")).toBe("Not available");
    expect(formatMediumDateTime(undefined, "Not scheduled yet")).toBe("Not scheduled yet");
  });

  test("invalid date returns input verbatim", () => {
    expect(formatMediumDateTime("garbage", "x")).toBe("garbage");
  });

  test("valid ISO renders the fixed en-US medium/short format", () => {
    const out = formatMediumDateTime("2026-04-30T12:00:00Z", "x");
    expect(out).toBe("Apr 30, 2026, 12:00 PM");
  });
});
