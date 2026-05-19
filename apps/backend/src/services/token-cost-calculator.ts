import type { TokenUsageRecord } from "./message-store.js";

// Long context threshold per OpenAI pricing docs (>272K total tokens)
const LONG_CONTEXT_THRESHOLD = 272_000;

type PricingTier = {
  input: number;        // $ per 1M tokens
  cachedInput: number;  // $ per 1M tokens
  output: number;       // $ per 1M tokens
};

type ModelPricing = {
  short: PricingTier;
  long: PricingTier | null; // null = no long-context pricing (same as short)
};

const PRICING: Record<string, ModelPricing> = {
  "gpt-5.5": {
    short: { input:  5.00, cachedInput: 0.50,  output: 30.00 },
    long:  { input: 10.00, cachedInput: 1.00,  output: 45.00 }
  },
  "gpt-5.4": {
    short: { input: 2.50, cachedInput: 0.25,   output: 15.00 },
    long:  { input: 5.00, cachedInput: 0.50,   output: 22.50 }
  },
  "gpt-5.4-mini": {
    short: { input: 0.75, cachedInput: 0.075,  output: 4.50 },
    long:  null
  },
  "gpt-5.4-nano": {
    short: { input: 0.20, cachedInput: 0.02,   output: 1.25 },
    long:  null
  },
  "gpt-5.4-pro": {
    short: { input: 30.00, cachedInput: 0,     output: 180.00 },
    long:  { input: 60.00, cachedInput: 0,     output: 270.00 }
  },

  // Claude models. Cache-read tokens bill at 10% of input. Cache-creation
  // tokens (1.25x input in reality) are folded into `inputTokens` at the
  // mapper and billed at the regular input rate — small under-bill on that
  // bucket, not worth a dedicated pricing tier.
  "claude-opus-4-7": {
    short: { input:  5.00, cachedInput: 0.50,  output: 25.00 },
    long:  null
  },
  "claude-opus-4-6": {
    short: { input:  5.00, cachedInput: 0.50,  output: 25.00 },
    long:  null
  },
  "claude-sonnet-4-6": {
    short: { input:  3.00, cachedInput: 0.30,  output: 15.00 },
    long:  null
  },
  "claude-haiku-4-5-20251001": {
    short: { input:  1.00, cachedInput: 0.10,  output:  5.00 },
    long:  null
  }
};

export function calculateCostUsd(model: string, tokenUsage: TokenUsageRecord): number | null {
  const pricing = PRICING[model];
  if (!pricing) {
    return null;
  }

  const isLongContext = tokenUsage.totalTokens > LONG_CONTEXT_THRESHOLD;
  const tier = (isLongContext && pricing.long) ? pricing.long : pricing.short;

  const billableInput = tokenUsage.inputTokens - tokenUsage.cachedInputTokens;
  const cost =
    (billableInput              / 1_000_000) * tier.input +
    (tokenUsage.cachedInputTokens / 1_000_000) * tier.cachedInput +
    (tokenUsage.outputTokens      / 1_000_000) * tier.output;

  return cost;
}
