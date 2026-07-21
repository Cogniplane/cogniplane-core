import { describe, expect, it } from "vitest";
import { calculateCostUsd } from "./token-cost-calculator.js";
import type { TokenUsageRecord } from "./message-store.js";

function usage(partial: Partial<TokenUsageRecord>): TokenUsageRecord {
  const inputTokens = partial.inputTokens ?? 0;
  const outputTokens = partial.outputTokens ?? 0;
  return {
    inputTokens,
    cachedInputTokens: partial.cachedInputTokens ?? 0,
    outputTokens,
    reasoningOutputTokens: partial.reasoningOutputTokens ?? 0,
    totalTokens: partial.totalTokens ?? inputTokens + outputTokens
  };
}

describe("calculateCostUsd", () => {
  it("returns null for an unpriced / unknown model id", () => {
    expect(calculateCostUsd("no-such-model", usage({ inputTokens: 1000, outputTokens: 1000 }))).toBeNull();
  });

  it("bills a Claude model at the flat short-context rate", () => {
    // claude-sonnet-5: input 3.00, output 15.00 per 1M.
    const cost = calculateCostUsd(
      "claude-sonnet-5",
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
    );
    expect(cost).toBeCloseTo(3.0 + 15.0, 6);
  });

  it("discounts cached input tokens at the cachedInput rate", () => {
    // gemini-2.5-flash: input 0.30, cachedInput 0.03, output 2.50 per 1M.
    // 1M input of which 400k are cached → 600k billable input + 400k cached.
    const cost = calculateCostUsd(
      "gemini-2.5-flash",
      usage({ inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 1_000_000 })
    );
    const expected =
      (600_000 / 1_000_000) * 0.3 +
      (400_000 / 1_000_000) * 0.03 +
      (1_000_000 / 1_000_000) * 2.5;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("prices a Z.AI native GLM model", () => {
    // glm-4.7: input 0.40, output 1.75 per 1M.
    const cost = calculateCostUsd(
      "glm-4.7",
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
    );
    expect(cost).toBeCloseTo(0.4 + 1.75, 6);
  });

  it("prices an OpenRouter model keyed with its inner slash", () => {
    // deepseek/deepseek-v4-pro: input 0.435, output 0.87 per 1M.
    const cost = calculateCostUsd(
      "deepseek/deepseek-v4-pro",
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
    );
    expect(cost).toBeCloseTo(0.435 + 0.87, 6);
  });

  it("returns zero for a :free OpenRouter route", () => {
    const cost = calculateCostUsd(
      "openai/gpt-oss-120b:free",
      usage({ inputTokens: 500_000, outputTokens: 500_000 })
    );
    expect(cost).toBe(0);
  });

  it("applies the OpenAI long-context tier above the threshold", () => {
    // gpt-5.4 long tier: input 5.00, output 22.50 per 1M; threshold 272k.
    const cost = calculateCostUsd(
      "gpt-5.4",
      usage({ inputTokens: 300_000, outputTokens: 100_000, totalTokens: 400_000 })
    );
    const expected = (300_000 / 1_000_000) * 5.0 + (100_000 / 1_000_000) * 22.5;
    expect(cost).toBeCloseTo(expected, 6);
  });
});
