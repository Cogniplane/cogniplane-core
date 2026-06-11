import { describe, expect, test } from "vitest";

import { formatMediumDateTime, formatMessageTimestamp, formatTimestamp } from "./time-format";

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

  test("valid ISO is locale-formatted (contains a digit)", () => {
    const out = formatTimestamp("2026-04-30T12:00:00Z");
    expect(out).toMatch(/\d/);
    expect(out).not.toBe("2026-04-30T12:00:00Z");
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
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("formatMessageTimestamp", () => {
  test("returns a formatted hh:mm string", () => {
    const iso = "2026-05-09T14:35:00Z";
    const result = formatMessageTimestamp(iso);
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });
});
