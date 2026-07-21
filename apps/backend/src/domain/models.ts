import type { ModelProvider } from "@cogniplane/shared-types";

import type { RuntimeReasoningEffort } from "../runtime-contracts.js";

export const AVAILABLE_MODELS: readonly {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  // The LLM provider behind the model id (initChatModel "<provider>:<model>").
  provider: ModelProvider;
  supportedEfforts: RuntimeReasoningEffort[];
  defaultEffort: RuntimeReasoningEffort | null;
  // Max input context in tokens, used by the composer's context-window meter.
  contextWindow: number;
}[] = [
  // Deep Agents (bead quap): the agent loop runs in-process via
  // deepagentsjs + initChatModel. Ids are namespaced "<catalog>/<vendorModel>";
  // the graph maps each id to its provider via the `provider` field here (NOT
  // the namespace) and builds the initChatModel string from
  // MODEL_PROVIDER_META. See resolveModelConstruction in deep-agents-graph.ts.
  //
  // supportedEfforts drives the composer's Effort dropdown AND is applied to
  // model construction per-provider (bead i52g): Anthropic extended thinking,
  // OpenAI reasoning.effort, Gemini thinking budget. See applyReasoningEffort
  // in deep-agents-graph.ts for how each level maps to the client config.
  // contextWindow feeds the composer's context meter.

  // Anthropic (initChatModel prefix "anthropic"). Extended thinking maps to
  // none/low/medium/high → a thinking token budget (0 = off).
  { id: "deepagents/claude-fable-5",             displayName: "Claude Fable 5",   description: "Anthropic's highest-capability frontier model.",       isDefault: false, provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-opus-4-8",            displayName: "Claude Opus 4.8",  description: "Anthropic's most capable model for complex agentic work.", isDefault: false, provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-sonnet-5",            displayName: "Claude Sonnet 5",  description: "Fast, intelligent all-round model.",                   isDefault: true,  provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "none",   contextWindow: 1_000_000 },
  // Haiku 4.5 has extended thinking but NO `effort` parameter — it only takes the
  // legacy `budget_tokens` mode, which our Anthropic path (outputConfig.effort)
  // doesn't emit. So any effort but `none` is rejected by the API; advertise only
  // `none` (the Effort dropdown then hides, since it needs >1 option).
  { id: "deepagents/claude-haiku-4-5",           displayName: "Claude Haiku 4.5", description: "Fastest Anthropic model.",                             isDefault: false, provider: "anthropic",  supportedEfforts: ["none"], defaultEffort: "none",   contextWindow: 200_000 },

  // OpenAI (initChatModel prefix "openai"). GPT-5.4/5.5 expose reasoning.effort
  // minimal/low/medium/high; the GPT-5.6 family (Sol/Terra/Luna, 2026-07)
  // replaces "minimal" with "none" and adds xhigh/max — all three tiers accept
  // the full range through the API. Vendor model id follows the "/".
  { id: "openai/gpt-5.6-sol",                    displayName: "GPT-5.6 Sol",                    description: "OpenAI's flagship GPT-5.6 model for the hardest problems.", isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "openai/gpt-5.6-terra",                  displayName: "GPT-5.6 Terra",                  description: "Balanced GPT-5.6 model for everyday work.",            isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "openai/gpt-5.6-luna",                   displayName: "GPT-5.6 Luna",                   description: "Fast, low-cost GPT-5.6 model.",                        isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "low",    contextWindow: 1_000_000 },
  { id: "openai/gpt-5.5",                        displayName: "GPT-5.5",                        description: "OpenAI's prior flagship frontier reasoning model.",    isDefault: false, provider: "openai",     supportedEfforts: ["minimal", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-5.4",                        displayName: "GPT-5.4",                        description: "Older GPT-5 reasoning model.",                         isDefault: false, provider: "openai",     supportedEfforts: ["minimal", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 400_000 },
  { id: "openai/gpt-5.4-mini",                   displayName: "GPT-5.4 mini",                   description: "Faster, lower-cost OpenAI model.",                     isDefault: false, provider: "openai",     supportedEfforts: ["minimal", "low", "medium", "high"], defaultEffort: "low",    contextWindow: 400_000 },

  // Google (initChatModel prefix "google-genai" — the key-based Gemini client,
  // NOT Vertex; see MODEL_PROVIDER_META). Thinking budget maps to
  // none/low/medium/high.
  { id: "google/gemini-3.5-flash",               displayName: "Gemini 3.5 Flash",              description: "Google's most intelligent Flash model for agentic work.", isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "google/gemini-3.1-pro-preview",         displayName: "Gemini 3.1 Pro (preview)",      description: "Google's strongest reasoning model (preview).",        isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "google/gemini-2.5-pro",                 displayName: "Gemini 2.5 Pro",                description: "Google's high-capability reasoning Gemini model.",     isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "google/gemini-2.5-flash",               displayName: "Gemini 2.5 Flash",              description: "Fast, low-cost Gemini model.",                         isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "none",   contextWindow: 1_000_000 },

  // OpenRouter (rides the OpenAI client + OpenRouter base URL). The vendor
  // model id after the namespace contains its own "/" — resolveModelConstruction
  // splits on the FIRST slash only, preserving "deepseek/deepseek-v4-pro".
  // Reasoning-effort support varies per open model and is not applied here
  // (supportedEfforts: []), so the Effort dropdown stays hidden for these.
  { id: "openrouter/z-ai/glm-5.2",                    displayName: "GLM 5.2 (OpenRouter)",        description: "Z.AI GLM 5.2 — top open-weight model via OpenRouter.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
  { id: "openrouter/deepseek/deepseek-v4-pro",        displayName: "DeepSeek V4 Pro (OpenRouter)", description: "DeepSeek V4 Pro reasoning/coding model via OpenRouter.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
  { id: "openrouter/deepseek/deepseek-v4-flash",      displayName: "DeepSeek V4 Flash (OpenRouter)", description: "Fast, efficient DeepSeek V4 model via OpenRouter.",   isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },

  // Top-ranked open models by OpenRouter token volume / adoption (checked
  // 2026-07 against openrouter.ai/rankings + the public models API — slugs and
  // context windows verified via /api/v1/models). The anonymous stealth
  // preview "openrouter/owl-alpha" tops the token chart but rotates away
  // without notice, so it is deliberately NOT listed here.
  { id: "openrouter/tencent/hy3",                     displayName: "Tencent Hy3 (OpenRouter)",       description: "Tencent Hy3 295B MoE reasoning model — #1 open model by usage.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 262_144 },
  { id: "openrouter/xiaomi/mimo-v2.5",                displayName: "MiMo V2.5 (OpenRouter)",         description: "Xiaomi MiMo V2.5 — fast, low-cost open reasoning model.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
  { id: "openrouter/xiaomi/mimo-v2.5-pro",            displayName: "MiMo V2.5 Pro (OpenRouter)",     description: "Xiaomi MiMo V2.5 Pro — stronger MiMo tier for agentic work.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
  { id: "openrouter/minimax/minimax-m3",              displayName: "MiniMax M3 (OpenRouter)",        description: "MiniMax M3 open agentic/coding model.",                isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
  { id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b", displayName: "Nemotron 3 Ultra (OpenRouter)", description: "NVIDIA Nemotron 3 Ultra 550B MoE — strongest open Nemotron.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
  { id: "openrouter/stepfun/step-3.7-flash",          displayName: "Step 3.7 Flash (OpenRouter)",    description: "StepFun Step 3.7 Flash — fast open model for routine work.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 256_000 },
  { id: "openrouter/qwen/qwen3.7-max",                displayName: "Qwen3.7 Max (OpenRouter)",       description: "Alibaba Qwen3.7 Max — flagship Qwen reasoning model.",  isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },

  // OpenRouter free tier (":free" slugs) — for testing without spend. Routes
  // rotate: OpenRouter can retire a free variant (returning 404 "unavailable
  // for free, use <paid slug>"), so keep these to models with a confirmed-live
  // :free route and pair each with its paid slug elsewhere in the catalog.
  // (deepseek-v4-flash:free was retired 2026-07 → dropped; paid
  // deepseek-v4-flash above covers that model.)
  { id: "openrouter/nvidia/nemotron-3-super-120b-a12b:free", displayName: "Nemotron 3 Super (free)",   description: "Free NVIDIA Nemotron 3 Super for testing.",           isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 128_000 },
  { id: "openrouter/openai/gpt-oss-120b:free",              displayName: "GPT-OSS 120B (free)",        description: "Free OpenAI GPT-OSS 120B for testing.",               isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 128_000 },
  { id: "openrouter/google/gemma-4-31b-it:free",            displayName: "Gemma 4 31B (free)",         description: "Free Google Gemma 4 31B for testing.",                isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 128_000 },
  { id: "openrouter/tencent/hy3:free",                      displayName: "Tencent Hy3 (free)",         description: "Free Tencent Hy3 295B MoE reasoning model for testing.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 262_144 },

  // Z.AI (Zhipu / GLM) DIRECT — rides the OpenAI client + Z.AI base URL (see
  // MODEL_PROVIDER_META.zai), NOT OpenRouter. Vendor ids are the bare Z.AI ids
  // ("glm-5.2"), no namespace slash inside. GLM-5.2 supports a reasoning_effort
  // knob, but it's a non-native extra-body param on the OpenAI client, so
  // effort stays off (supportedEfforts: []) until it's wired + smoke-tested.
  { id: "zai/glm-5.2",       displayName: "GLM-5.2 (Z.AI)",       description: "Z.AI's flagship GLM reasoning/coding model.",  isDefault: false, provider: "zai", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
  { id: "zai/glm-4.7",       displayName: "GLM-4.7 (Z.AI)",       description: "Fast, lower-cost GLM model for routine work.", isDefault: false, provider: "zai", supportedEfforts: [], defaultEffort: null, contextWindow: 200_000 },
  { id: "zai/glm-4.7-flash", displayName: "GLM-4.7 Flash (Z.AI)", description: "Free, rate-limited GLM Flash for testing.",    isDefault: false, provider: "zai", supportedEfforts: [], defaultEffort: null, contextWindow: 200_000 },
] as const;

export type AvailableModel = (typeof AVAILABLE_MODELS)[number];
