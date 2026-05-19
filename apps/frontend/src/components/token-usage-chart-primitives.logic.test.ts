import { describe, expect, test } from "vitest";

import {
  computeBarLayout,
  computeYTicks,
  fmtAxisShort,
  fmtCost,
  fmtTokens,
  formatBarLabel,
  shouldShowBarLabel
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

describe("computeYTicks", () => {
  test("emits 5 ticks at 25% steps", () => {
    expect(computeYTicks(100)).toEqual([0, 25, 50, 75, 100]);
  });

  test("forces yMax>=1 to keep axis valid for empty series", () => {
    expect(computeYTicks(0)).toEqual([0, 0, 1, 1, 1]);
  });
});

describe("computeBarLayout", () => {
  test("splits chart width across groups", () => {
    const layout = computeBarLayout(600, 4);
    expect(layout.barGroupW).toBe(150);
    expect(layout.barW).toBe(150 * 0.35);
    expect(layout.gap).toBeGreaterThanOrEqual(2);
  });

  test("clamps to small minimums on tiny inputs", () => {
    const layout = computeBarLayout(10, 50);
    expect(layout.barW).toBeGreaterThanOrEqual(3);
    expect(layout.gap).toBeGreaterThanOrEqual(2);
  });

  test("zero buckets returns the full chart width", () => {
    const layout = computeBarLayout(600, 0);
    expect(layout.barGroupW).toBe(600);
  });
});

describe("shouldShowBarLabel", () => {
  test("short series shows every label", () => {
    expect(shouldShowBarLabel(7, 8)).toBe(true);
  });

  test("long series strides labels", () => {
    // 30 buckets → stride 3 → indexes 0,3,6,... show
    expect(shouldShowBarLabel(0, 30)).toBe(true);
    expect(shouldShowBarLabel(1, 30)).toBe(false);
    expect(shouldShowBarLabel(3, 30)).toBe(true);
  });
});
