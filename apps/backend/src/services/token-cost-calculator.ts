import type { TokenUsageRecord } from "./message-store.js";

// OpenAI's long-context rates apply above 272K input tokens.
const LONG_CONTEXT_THRESHOLD = 272_000;

type PricingTier = {
  input: number;        // $ per 1M tokens
  cachedInput: number;  // $ per 1M tokens
  output: number;       // $ per 1M tokens
};

type ModelPricing = {
  short: PricingTier;
  long: PricingTier | null; // null = no long-context pricing (same as short)
  longThreshold?: number;   // input tokens above which `long` applies; default LONG_CONTEXT_THRESHOLD
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
  "gpt-6.1-sol": {
    short: { input:  2.00, cachedInput: 0.10,  output: 10.00 },
    long:  { input:  4.00, cachedInput: 0.20,  output: 15.00 }
  },
  "gpt-6-sol": {
    short: { input:  2.00, cachedInput: 0.20,  output: 10.00 },
    long:  { input:  4.00, cachedInput: 0.40,  output: 15.00 }
  },
  "gpt-6-luna": {
    short: { input:  0.10, cachedInput: 0.01,  output:  0.50 },
    long:  { input:  0.20, cachedInput: 0.02,  output:  0.75 }
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

  // Claude models. Cache-read rates vary by model. Cache-creation
  // tokens (1.25x input in reality) are folded into `inputTokens` at the
  // mapper and billed at the regular input rate — small under-bill on that
  // bucket, not worth a dedicated pricing tier.
  "claude-fable-5-1": {
    short: { input: 10.00, cachedInput: 0.25,  output: 50.00 },
    long:  null
  },
  "claude-opus-5-5": {
    short: { input:  4.00, cachedInput: 0.20,  output: 20.00 },
    long:  null
  },
  "claude-opus-5": {
    short: { input:  5.00, cachedInput: 0.50,  output: 25.00 },
    long:  null
  },
  "claude-fable-5": {
    short: { input: 10.00, cachedInput: 1.00,  output: 50.00 },
    long:  null
  },
  "claude-opus-4-8": {
    short: { input:  5.00, cachedInput: 0.50,  output: 25.00 },
    long:  null
  },
  "claude-sonnet-5-5": {
    short: { input:  2.00, cachedInput: 0.10,  output: 10.00 },
    long:  null
  },
  "claude-sonnet-5": {
    short: { input:  2.00, cachedInput: 0.20,  output: 10.00 },
    long:  null
  },
  // Haiku 5.5 is priced by prompt length: above 100K input tokens (cache reads
  // included) the whole request pays the higher rates.
  "claude-haiku-5-5": {
    short: { input:  0.10, cachedInput: 0.01,  output:  0.50 },
    long:  { input:  0.50, cachedInput: 0.05,  output:  2.50 },
    longThreshold: 100_000
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
  "xiaomi/mimo-v2.6-flash": {
    short: { input: 0.14,  cachedInput: 0.0028, output: 0.28 },
    long:  null
  },
  "xiaomi/mimo-v2.6-pro": {
    short: { input: 0.435, cachedInput: 0.0036, output: 0.87 },
    long:  null
  },
  "minimax/minimax-m3": {
    short: { input: 0.30,  cachedInput: 0.06,   output: 1.20 },
    long:  null
  },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    short: { input: 0.60,  cachedInput: 0.12,   output: 2.40 },
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
  "qwen/qwen3.8-max-0902": {
    short: { input: 2.00,  cachedInput: 0.25,   output: 6.00 },
    long:  null
  },
  "z-ai/glm-5.3-flashx": {
    short: { input: 0.37,  cachedInput: 0.09,   output: 1.25 },
    long:  null
  },
  "x-ai/grok-4.7": {
    short: { input: 2.00,  cachedInput: 0.50,   output: 6.00 },
    long:  null
  },
  "mistralai/mistral-large-4-0": {
    short: { input: 0.68,  cachedInput: 0.07,   output: 2.09 },
    long:  null
  },
  "meta/muse-spark-1.3": {
    short: { input: 1.25,  cachedInput: 0.15,   output: 4.25 },
    long:  null
  },
  "z-ai/glm-5.2": {
    short: { input: 0.9086, cachedInput: 0.1687, output: 2.8556 },
    long:  null
  },
  "deepseek/deepseek-v4-pro": {
    short: { input: 1.30,  cachedInput: 0.135,  output: 3.20 },
    long:  null
  },
  "deepseek/deepseek-v4.1-flash": {
    short: { input: 0.30,  cachedInput: 0.006,  output: 1.20 },
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
  "nvidia/nemotron-3-ultra-550b-a55b:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  "nvidia/nemotron-3.5-lightning:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  // Retired routes kept for billing history on past messages. As of
  // 2026-09-18 gpt-oss-120b:free, tencent/hy3:free and minimax-m3:free 404 on
  // OpenRouter, and glm-5.2:free no longer accepts tools. On 2026-10-08
  // deepseek-v4-flash-0731:free was gone, and V4.1 Flash and MiMo V2.6
  // replaced their predecessors in the catalog.
  "deepseek/deepseek-v4-flash-0731:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  "deepseek/deepseek-v4-flash": {
    short: { input: 0.09,  cachedInput: 0.018,  output: 0.18 },
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
  "openai/gpt-oss-120b:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  "tencent/hy3:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  "minimax/minimax-m3:free": {
    short: { input: 0, cachedInput: 0, output: 0 },
    long:  null
  },
  "z-ai/glm-5.2:free": {
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

/** Reads own keys only, so a name such as "constructor" has no price. */
function pricingFor(model: string): ModelPricing | undefined {
  return Object.hasOwn(PRICING, model) ? PRICING[model] : undefined;
}

/** True when `model` (a vendor model name) has a price. Uses the same lookup as `calculateCostUsd`. */
export function hasModelPrice(model: string): boolean {
  return pricingFor(model) !== undefined;
}

export function calculateCostUsd(model: string, tokenUsage: TokenUsageRecord): number | null {
  const pricing = pricingFor(model);
  if (!pricing) {
    return null;
  }

  const isLongContext = tokenUsage.inputTokens > (pricing.longThreshold ?? LONG_CONTEXT_THRESHOLD);
  const tier = (isLongContext && pricing.long) ? pricing.long : pricing.short;

  const billableInput = tokenUsage.inputTokens - tokenUsage.cachedInputTokens;
  const cost =
    (billableInput              / 1_000_000) * tier.input +
    (tokenUsage.cachedInputTokens / 1_000_000) * tier.cachedInput +
    (tokenUsage.outputTokens      / 1_000_000) * tier.output;

  return cost;
}
