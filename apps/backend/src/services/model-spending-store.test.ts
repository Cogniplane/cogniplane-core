import { describe, expect, test } from "vitest";
import { toMicroUsd } from "./model-spending-store.js";
import { calculateCostUsd } from "./token-cost-calculator.js";

function estimate(model: string, input: number, cached: number, output: number): number {
  const cost = calculateCostUsd(model, { inputTokens: input, cachedInputTokens: cached, outputTokens: output,
    reasoningOutputTokens: 0, totalTokens: input + output });
  if (cost === null) throw new Error(`No price for ${model}.`);
  return cost;
}

describe("toMicroUsd", () => {
  test("converts decimal USD amounts exactly, including those whose product with 1e6 is inexact", () => {
    // Math.ceil(value * 1e6) gives one micro-USD more for each of these.
    expect(4.03 * 1_000_000).toBeGreaterThan(4_030_000);
    expect(toMicroUsd(4.03)).toBe(4_030_000);
    expect(toMicroUsd(4.07)).toBe(4_070_000);
    expect(toMicroUsd(264630.358293)).toBe(264_630_358_293);
    expect(toMicroUsd(545473.652007)).toBe(545_473_652_007);
    for (const [usd, micro] of [[0, 0], [-0, 0], [0.000001, 1], [0.1, 100_000], [0.3, 300_000], [1.01, 1_010_000],
      [3.030001, 3_030_001], [123.456789, 123_456_789], [999999.999999, 999_999_999_999], [1_000_000, 1_000_000_000_000]] as const) {
      expect(toMicroUsd(usd)).toBe(micro);
    }
  });

  test("every cent value up to 10,000 USD and every micro-USD value below 1 USD converts exactly", () => {
    for (let cents = 0; cents <= 1_000_000; cents++) {
      if (toMicroUsd(cents / 100) !== cents * 10_000) throw new Error(`${cents / 100} USD converted inexactly.`);
    }
    for (let micro = 0; micro < 1_000_000; micro++) {
      if (toMicroUsd(micro / 1_000_000) !== micro) throw new Error(`${micro / 1_000_000} USD converted inexactly.`);
    }
  });

  test("rounds any fraction of a micro-USD up, including values printed in scientific notation", () => {
    expect(String(1e-7)).toBe("1e-7");
    expect(toMicroUsd(1e-7)).toBe(1);
    expect(toMicroUsd(5e-324)).toBe(1);
    expect(toMicroUsd(1.23e-18)).toBe(1);
    expect(toMicroUsd(0.0000028)).toBe(3);
    expect(toMicroUsd(0.0000010000001)).toBe(2);
    expect(toMicroUsd(4.0300001)).toBe(4_030_001);
    // The next double above 4.03 is above the boundary and must not round down to it.
    expect(toMicroUsd(4.030000000000001)).toBe(4_030_001);
    // Floating-point noise in a sum is kept: 0.1 + 0.2 is 0.30000000000000004.
    expect(toMicroUsd(0.1 + 0.2)).toBe(300_001);
  });

  test("rounds real fractional model-cost estimates up", () => {
    // 1 input token at 0.10 USD per million is 0.1 micro-USD.
    expect(toMicroUsd(estimate("gpt-6-luna", 1, 0, 0))).toBe(1);
    // 1,000 cached tokens at 0.0028 USD per million is 2.8 micro-USD.
    expect(toMicroUsd(estimate("xiaomi/mimo-v2.6-flash", 1000, 1000, 0))).toBe(3);
    // 1,001 input tokens at 0.9086 USD per million is 909.5086 micro-USD.
    expect(toMicroUsd(estimate("z-ai/glm-5.2", 1001, 0, 0))).toBe(910);
    // Whole micro-USD estimates stay exact.
    expect(toMicroUsd(estimate("gpt-6-sol", 1000, 0, 1000))).toBe(12_000);
    expect(toMicroUsd(estimate("gpt-6-sol", 1234, 0, 567))).toBe(8_138);
    expect(toMicroUsd(estimate("nvidia/nemotron-3.5-lightning:free", 5000, 0, 5000))).toBe(0);
  });

  test("accepts the largest value in the safe-integer range and refuses the next one", () => {
    expect(toMicroUsd(9007199254.74099)).toBe(9_007_199_254_740_990);
    // No double is 9007199254.740991 USD. The nearest one is the next double, 9007199254.740992.
    const maxSafeUsd = Number.MAX_SAFE_INTEGER / 1_000_000;
    expect(String(maxSafeUsd)).toBe("9007199254.740992");
    expect(() => toMicroUsd(maxSafeUsd)).toThrow("Invalid model cost.");
    expect(() => toMicroUsd(Number.MAX_SAFE_INTEGER)).toThrow("Invalid model cost.");
    expect(() => toMicroUsd(1.5e21)).toThrow("Invalid model cost.");
    expect(() => toMicroUsd(Number.MAX_VALUE)).toThrow("Invalid model cost.");
  });

  test("refuses negative and non-finite values", () => {
    for (const value of [-1, -0.000001, -5e-324, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => toMicroUsd(value)).toThrow("Invalid model cost.");
    }
  });
});
