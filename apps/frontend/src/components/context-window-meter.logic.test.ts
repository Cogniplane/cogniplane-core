import { describe, expect, test } from "vitest";

import { formatCostUsd, formatTokenCount } from "./context-window-meter.logic";

describe("cost/token formatters", () => {
  test("formatCostUsd tiers by magnitude", () => {
    expect(formatCostUsd(0.00005)).toBe("<$0.0001");
    expect(formatCostUsd(0.0034)).toBe("$0.0034");
    expect(formatCostUsd(1.2345)).toBe("$1.234");
  });

  test("formatTokenCount abbreviates thousands and millions", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(12_500)).toBe("13k");
    expect(formatTokenCount(1_500_000)).toBe("1.5m");
  });
});
