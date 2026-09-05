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
  "gpt-6-astra-pro": {
    short: { input: 10.00, cachedInput: 1.00,  output: 50.00 },
    long:  null
  },
  "gpt-6-astra": {
    short: { input: 10.00, cachedInput: 1.00,  output: 50.00 },
    long:  null
  },
  "gpt-5.6-sol": {
    short: { input:  2.00, cachedInput: 0.20,  output: 10.00 },
    long:  null
  },
  "gpt-5.6-terra": {
    short: { input:  2.00, cachedInput: 0.20,  output: 12.00 },
    long:  null
  },
  "gpt-5.6-luna": {
    short: { input:  0.20, cachedInput: 0.02,  output:  1.20 },
    long:  null
  },
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
  "claude-fable-5-1": {
    short: { input: 10.00, cachedInput: 0.25,  output: 50.00 },
    long:  null
  },
  "claude-opus-5": {
    short: { input:  5.00, cachedInput: 0.50,  output: 25.00 },
    long:  null
  },
  "claude-fable-5": {
    short: { input:  5.00, cachedInput: 0.50,  output: 25.00 },
    long:  null
  },
  "claude-opus-4-8": {
    short: { input:  5.00, cachedInput: 0.50,  output: 25.00 },
    long:  null
  },
  "claude-sonnet-5": {
    short: { input:  3.00, cachedInput: 0.30,  output: 15.00 },
    long:  null
  },
  // Retired from the model picker but kept for billing history on past messages.
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
  // Alias id used by the current catalog entry; the dated snapshot below is
  // kept for billing history on past messages.
  "claude-haiku-4-5": {
    short: { input:  1.00, cachedInput: 0.10,  output:  5.00 },
    long:  null
  },
  "claude-haiku-4-5-20251001": {
    short: { input:  1.00, cachedInput: 0.10,  output:  5.00 },
    long:  null
  },

  // Google / OpenRouter / Z.AI rates. All sourced from OpenRouter's public
  // models API (GET https://openrouter.ai/api/v1/models — `pricing.prompt` /
  // `.input_cache_read` / `.completion`, converted from per-token to per-1M).
  // The UI labels this "Est. cost", so a single cross-provider reference rate
  // is the intended precision. None of these publish a distinct long-context
  // tier, so `long` stays null (the >272K threshold logic then no-ops).
  //
  // Keys are the bare VENDOR model id (catalog id with its first namespace
  // segment stripped — inner slashes and the `:free` suffix preserved), which
  // is exactly what resolveModelConstruction().vendorModel yields.
  "gemini-3.8-flash": {
    short: { input: 0.75, cachedInput: 0.075,  output:  3.75 },
    long:  null
  },
  "gemini-3.7-flash": {
    short: { input: 0.75, cachedInput: 0.075,  output:  3.75 },
    long:  null
  },
  "gemini-3.5-flash": {
    short: { input: 1.50, cachedInput: 0.15,   output:  9.00 },
    long:  null
  },
  "gemini-3.1-pro-preview": {
    short: { input: 2.00, cachedInput: 0.20,   output: 12.00 },
    long:  null
  },
  "gemini-2.5-pro": {
    short: { input: 1.25, cachedInput: 0.125,  output: 10.00 },
    long:  null
  },
  "gemini-2.5-flash": {
    short: { input: 0.30, cachedInput: 0.03,   output:  2.50 },
    long:  null
  },

  // OpenRouter-served (paid). Free `:free` routes below bill at zero.
  "z-ai/glm-5.3": {
    short: { input: 1.40,  cachedInput: 0.14,   output: 4.40 },
    long:  null
  },
  "tencent/hy3": {
    short: { input: 0.132, cachedInput: 0.033,  output: 0.528 },
    long:  null
  },
  "xiaomi/mimo-v2.5": {
    short: { input: 0.14,  cachedInput: 0.0028, output: 0.28 },
    long:  null
  },
  "xiaomi/mimo-v2.5-pro": {
    short: { input: 0.435, cachedInput: 0.0036, output: 0.87 },
    long:  null
  },
  "minimax/minimax-m3": {
    short: { input: 0.30,  cachedInput: 0.06,   output: 1.20 },
    long:  null
  },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    short: { input: 0.625, cachedInput: 0.1875, output: 3.125 },
    long:  null
  },
  "stepfun/step-3.7-flash": {
    short: { input: 0.20,  cachedInput: 0.04,   output: 1.15 },
    long:  null
  },
  "qwen/qwen3.7-max": {
    short: { input: 1.475, cachedInput: 0.295,  output: 4.425 },
    long:  null
  },
  "z-ai/glm-5.2": {
    short: { input: 0.9086, cachedInput: 0.1687, output: 2.8556 },
    long:  null
  },
  "deepseek/deepseek-v4-pro": {
    short: { input: 0.435, cachedInput: 0.0036, output: 0.87 },
    long:  null
  },
  "deepseek/deepseek-v4-flash": {
    short: { input: 0.09,  cachedInput: 0.018,  output: 0.18 },
    long:  null
  },
  "nvidia/nemotron-3-super-120b-a12b:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  "google/gemma-4-31b-it:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  "thinkingmachines/inkling:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  "minimax/minimax-m3:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  "nvidia/nemotron-3.5-lightning:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  "z-ai/glm-5.2:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  // Retired free routes kept for billing history on past messages
  // (both 404 on OpenRouter as of 2026-09-05).
  "openai/gpt-oss-120b:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  "tencent/hy3:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },

  // Z.AI native (GLM Coding Plan endpoint). That plan is a flat subscription,
  // not per-token, so these rates are OpenRouter's per-token GLM prices used
  // as the best available cost estimate — same values as the OpenRouter
  // z-ai/glm-5.2 row above.
  "glm-5.3": {
    short: { input: 1.40,  cachedInput: 0.14,   output: 4.40 },
    long:  null
  },
  "glm-5.3-flash": {
    short: { input: 0.075, cachedInput: 0.015,  output: 0.25 },
    long:  null
  },
  "glm-5.2": {
    short: { input: 0.9086, cachedInput: 0.1687, output: 2.8556 },
    long:  null
  },
  "glm-4.7": {
    short: { input: 0.40, cachedInput: 0.08,   output: 1.75 },
    long:  null
  },
  "glm-4.7-flash": {
    short: { input: 0.06, cachedInput: 0.01,   output: 0.40 },
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
