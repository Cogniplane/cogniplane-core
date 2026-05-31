import { describe, expect, test } from "vitest";

import {
  fmtAxisShort,
  fmtCost,
  fmtTokens,
  formatBarLabel
} from "./token-usage-chart-primitives.logic";

describe("fmtTokens", () => {
  test("sub-1k renders as integer", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });

  test("1k..1M renders as one-decimal kilos", () => {
    expect(fmtTokens(1_000)).toBe("1.0k");
    expect(fmtTokens(2_500)).toBe("2.5k");
  });

  test(">=1M renders as two-decimal megas", () => {
    expect(fmtTokens(1_500_000)).toBe("1.50M");
    expect(fmtTokens(12_345_678)).toBe("12.35M");
  });
});

describe("fmtCost", () => {
  test("zero special-case", () => {
    expect(fmtCost(0)).toBe("$0.00");
  });

  test("sub-cent uses 5 decimals", () => {
    expect(fmtCost(0.00123)).toBe("$0.00123");
  });

  test(">=$0.01 uses 4 decimals", () => {
    expect(fmtCost(1.2345)).toBe("$1.2345");
    expect(fmtCost(99.987654)).toBe("$99.9877");
  });
});

describe("fmtAxisShort", () => {
  test("axis labels stay short", () => {
    expect(fmtAxisShort(0)).toBe("0");
    expect(fmtAxisShort(999)).toBe("999");
    expect(fmtAxisShort(1_000)).toBe("1k");
    expect(fmtAxisShort(2_500)).toBe("3k");
    expect(fmtAxisShort(1_500_000)).toBe("1.5M");
  });
});

describe("formatBarLabel", () => {
  test("ISO date renders as 'Mon DD'", () => {
    expect(formatBarLabel("2026-05-09")).toBe("May 09");
    expect(formatBarLabel("2026-12-25")).toBe("Dec 25");
  });

  test("non-ISO long label truncates to last 8 chars", () => {
    expect(formatBarLabel("supercalifragilistic")).toBe("gilistic");
    expect(formatBarLabel("a")).toBe("a");
  });

  test("invalid month falls through to truncation path", () => {
    // 10-char input → 8-char tail (drops year prefix).
    expect(formatBarLabel("2026-13-01")).toBe("26-13-01");
  });
});
