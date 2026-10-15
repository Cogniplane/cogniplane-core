import { describe, expect, it } from "vitest";
import { AVAILABLE_MODELS } from "../domain/models.js";
import { resolveModelConstruction } from "./deep-agents/deep-agents-graph.js";
import { calculateCostUsd, hasModelPrice } from "./token-cost-calculator.js";
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
    // claude-sonnet-5: input 2.00, output 10.00 per 1M.
    const cost = calculateCostUsd(
      "claude-sonnet-5",
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
    );
    expect(cost).toBeCloseTo(2.0 + 10.0, 6);
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
    // deepseek/deepseek-v4-pro: input 1.30, output 3.20 per 1M.
    const cost = calculateCostUsd(
      "deepseek/deepseek-v4-pro",
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
    );
    expect(cost).toBeCloseTo(1.30 + 3.20, 6);
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

  it.each([
    { inputTokens: 272_000, cachedInputTokens: 50_000, expected: 0.222 * 2 + 0.05 * 0.1 + 0.05 * 10 },
    { inputTokens: 272_001, cachedInputTokens: 50_000, expected: 0.222001 * 4 + 0.05 * 0.2 + 0.05 * 15 }
  ])("prices GPT-6.1 Sol at $inputTokens input tokens", ({ inputTokens, cachedInputTokens, expected }) => {
    expect(calculateCostUsd("gpt-6.1-sol", usage({
      inputTokens,
      cachedInputTokens,
      outputTokens: 50_000
    }))).toBeCloseTo(expected, 6);
  });

  it("applies Haiku 5.5's long-context tier above 100K input tokens, cache reads included", () => {
    // 100K prompt tokens (half cached) stays on the short tier.
    expect(calculateCostUsd("claude-haiku-5-5", usage({ inputTokens: 100_000, cachedInputTokens: 50_000, outputTokens: 10_000 })))
      .toBeCloseTo(0.05 * 0.10 + 0.05 * 0.01 + 0.01 * 0.50, 6);
    // 150K prompt tokens (100K cached) pays the long tier on every bucket.
    expect(calculateCostUsd("claude-haiku-5-5", usage({ inputTokens: 150_000, cachedInputTokens: 100_000, outputTokens: 10_000 })))
      .toBeCloseTo(0.05 * 0.50 + 0.1 * 0.05 + 0.01 * 2.50, 6);
  });

  it("prices new models with cached input and long-context rates", () => {
    const shortUsage = usage({ inputTokens: 200_000, cachedInputTokens: 50_000, outputTokens: 50_000 });
    expect(calculateCostUsd("gpt-6-sol", shortUsage)).toBeCloseTo(
      0.15 * 2 + 0.05 * 0.2 + 0.05 * 10, 6
    );
    expect(calculateCostUsd("gpt-6-luna", shortUsage)).toBeCloseTo(
      0.15 * 0.1 + 0.05 * 0.01 + 0.05 * 0.5, 6
    );
    expect(calculateCostUsd("claude-opus-5-5", shortUsage)).toBeCloseTo(
      0.15 * 4 + 0.05 * 0.2 + 0.05 * 20, 6
    );
    expect(calculateCostUsd("claude-fable-5", shortUsage)).toBeCloseTo(
      0.15 * 10 + 0.05 * 1 + 0.05 * 50, 6
    );
    expect(calculateCostUsd("claude-sonnet-5-5", shortUsage)).toBeCloseTo(
      0.15 * 2 + 0.05 * 0.1 + 0.05 * 10, 6
    );

    const longUsage = usage({ inputTokens: 300_000, outputTokens: 50_000 });
    expect(calculateCostUsd("gpt-6-sol", longUsage)).toBeCloseTo(
      0.3 * 4 + 0.05 * 15, 6
    );
    expect(calculateCostUsd("gpt-6-luna", longUsage)).toBeCloseTo(
      0.3 * 0.2 + 0.05 * 0.75, 6
    );

    const shortInputWithLargeOutput = usage({ inputTokens: 250_000, outputTokens: 100_000 });
    expect(calculateCostUsd("gpt-6-sol", shortInputWithLargeOutput)).toBeCloseTo(
      0.25 * 2 + 0.1 * 10, 6
    );
  });
});

describe("hasModelPrice", () => {
  // A catalog model without a price is refused at reserve() while spending
  // limits are on, so a catalog edit must add its price.
  it("every catalog model has a price", () => {
    const unpriced = AVAILABLE_MODELS.map((model) => resolveModelConstruction(model.id).vendorModel)
      .filter((vendorModel) => !hasModelPrice(vendorModel));
    expect(unpriced).toEqual([]);
  });

  it.each(["constructor", "toString", "__proto__"])("has no price for the inherited name %s", (name) => {
    expect(hasModelPrice(name)).toBe(false);
    expect(calculateCostUsd(name, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 })).toBeNull();
  });
});
