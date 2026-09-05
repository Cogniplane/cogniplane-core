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
  // none/low/medium/high → a thinking token budget (0 = off). Vendor ids use
  // Anthropic's dashed API form ("claude-opus-4-8"), NOT the dotted form the
  // OpenRouter catalog shows — these call the Anthropic API directly.
  { id: "deepagents/claude-fable-5-1",           displayName: "Claude Fable 5.1", description: "Anthropic's highest-capability frontier model.",       isDefault: false, provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-opus-5",              displayName: "Claude Opus 5",    description: "Anthropic's most capable model for complex agentic work.", isDefault: false, provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-fable-5",             displayName: "Claude Fable 5",   description: "Prior-generation Anthropic frontier model.",           isDefault: false, provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-opus-4-8",            displayName: "Claude Opus 4.8",  description: "Prior-generation Anthropic reasoning model.",          isDefault: false, provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-sonnet-5",            displayName: "Claude Sonnet 5",  description: "Fast, intelligent all-round model.",                   isDefault: true,  provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "none",   contextWindow: 1_000_000 },
  // Haiku 4.5 has extended thinking but NO `effort` parameter — it only takes the
  // legacy `budget_tokens` mode, which our Anthropic path (outputConfig.effort)
  // doesn't emit. So any effort but `none` is rejected by the API; advertise only
  // `none` (the Effort dropdown then hides, since it needs >1 option).
  { id: "deepagents/claude-haiku-4-5",           displayName: "Claude Haiku 4.5", description: "Fastest Anthropic model.",                             isDefault: false, provider: "anthropic",  supportedEfforts: ["none"], defaultEffort: "none",   contextWindow: 200_000 },

  // OpenAI (initChatModel prefix "openai"). GPT-5.4/5.5 expose reasoning.effort
  // minimal/low/medium/high; the GPT-5.6 family (Sol/Terra/Luna) and GPT-6
  // Astra replace "minimal" with "none" and add xhigh/max — all accept the full
  // range through the API. Vendor model id follows the "/".
  { id: "openai/gpt-6-astra-pro",                displayName: "GPT-6 Astra Pro",                description: "OpenAI's most capable GPT-6 model for the hardest problems.", isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-6-astra",                    displayName: "GPT-6 Astra",                    description: "OpenAI's flagship GPT-6 model.",                       isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-5.6-sol",                    displayName: "GPT-5.6 Sol",                    description: "Prior-generation GPT-5.6 flagship model.",             isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-5.6-terra",                  displayName: "GPT-5.6 Terra",                  description: "Balanced GPT-5.6 model for everyday work.",            isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-5.6-luna",                   displayName: "GPT-5.6 Luna",                   description: "Fast, low-cost GPT-5.6 model.",                        isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "low",    contextWindow: 1_050_000 },
  { id: "openai/gpt-5.5",                        displayName: "GPT-5.5",                        description: "Older GPT-5 frontier reasoning model.",                isDefault: false, provider: "openai",     supportedEfforts: ["minimal", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-5.4-mini",                   displayName: "GPT-5.4 mini",                   description: "Faster, lower-cost OpenAI model.",                     isDefault: false, provider: "openai",     supportedEfforts: ["minimal", "low", "medium", "high"], defaultEffort: "low",    contextWindow: 400_000 },

  // Google (initChatModel prefix "google-genai" — the key-based Gemini client,
  // NOT Vertex; see MODEL_PROVIDER_META). Thinking budget maps to
  // none/low/medium/high.
  { id: "google/gemini-3.8-flash",               displayName: "Gemini 3.8 Flash",              description: "Google's most intelligent Flash model for agentic work.", isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_048_576 },
  { id: "google/gemini-3.7-flash",               displayName: "Gemini 3.7 Flash",              description: "Prior-generation Gemini Flash model.",                 isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_048_576 },
  { id: "google/gemini-3.5-flash",               displayName: "Gemini 3.5 Flash",              description: "Older Gemini Flash model.",                            isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_048_576 },
  { id: "google/gemini-3.1-pro-preview",         displayName: "Gemini 3.1 Pro (preview)",      description: "Google's strongest reasoning model (preview).",        isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_048_576 },
  { id: "google/gemini-2.5-pro",                 displayName: "Gemini 2.5 Pro",                description: "Google's high-capability reasoning Gemini model.",     isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_048_576 },
  { id: "google/gemini-2.5-flash",               displayName: "Gemini 2.5 Flash",              description: "Fast, low-cost Gemini model.",                         isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "none",   contextWindow: 1_048_576 },

  // OpenRouter (rides the OpenAI client + OpenRouter base URL). The vendor
  // model id after the namespace contains its own "/" — resolveModelConstruction
  // splits on the FIRST slash only, preserving "deepseek/deepseek-v4-pro".
  // Reasoning-effort support varies per open model and is not applied here
  // (supportedEfforts: []), so the Effort dropdown stays hidden for these.
  // Slugs and context windows verified 2026-09-05 against
  // https://openrouter.ai/api/v1/models.
  { id: "openrouter/z-ai/glm-5.3",                    displayName: "GLM 5.3 (OpenRouter)",        description: "Z.AI GLM 5.3 — top open-weight model via OpenRouter.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_310_720 },
  { id: "openrouter/deepseek/deepseek-v4-pro",        displayName: "DeepSeek V4 Pro (OpenRouter)", description: "DeepSeek V4 Pro reasoning/coding model via OpenRouter.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/deepseek/deepseek-v4-flash",      displayName: "DeepSeek V4 Flash (OpenRouter)", description: "Fast, efficient DeepSeek V4 model via OpenRouter.",   isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },

  // Widely-used open models on OpenRouter (slugs + context windows verified
  // 2026-09-05 via /api/v1/models). OpenRouter's public API exposes no usage
  // ranking today (the ?order= param is accepted but ignored), so this set is
  // curated by capability tier, not by a live token chart.
  { id: "openrouter/tencent/hy3",                     displayName: "Tencent Hy3 (OpenRouter)",       description: "Tencent Hy3 295B MoE reasoning model.",                isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 262_144 },
  { id: "openrouter/xiaomi/mimo-v2.5",                displayName: "MiMo V2.5 (OpenRouter)",         description: "Xiaomi MiMo V2.5 — fast, low-cost open reasoning model.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_050_000 },
  { id: "openrouter/xiaomi/mimo-v2.5-pro",            displayName: "MiMo V2.5 Pro (OpenRouter)",     description: "Xiaomi MiMo V2.5 Pro — stronger MiMo tier for agentic work.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_050_000 },
  { id: "openrouter/minimax/minimax-m3",              displayName: "MiniMax M3 (OpenRouter)",        description: "MiniMax M3 open agentic/coding model.",                isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b", displayName: "Nemotron 3 Ultra (OpenRouter)", description: "NVIDIA Nemotron 3 Ultra 550B MoE — strongest open Nemotron.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 262_144 },
  { id: "openrouter/stepfun/step-3.7-flash",          displayName: "Step 3.7 Flash (OpenRouter)",    description: "StepFun Step 3.7 Flash — fast open model for routine work.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 262_144 },
  { id: "openrouter/qwen/qwen3.7-max",                displayName: "Qwen3.7 Max (OpenRouter)",       description: "Alibaba Qwen3.7 Max — flagship Qwen reasoning model.",  isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },

  // OpenRouter free tier (":free" slugs) — for testing without spend. Routes
  // rotate: OpenRouter retires a free variant without notice (the slug then
  // 404s), so every entry here was confirmed live AND tool-calling-capable on
  // 2026-09-05, and each pairs with a paid slug elsewhere in the catalog or a
  // vendor equivalent. Tool support matters: a model with no `tools` parameter
  // cannot drive the agent loop at all.
  // (gpt-oss-120b:free and tencent/hy3:free were retired since the 2026-07
  // check → dropped.)
  { id: "openrouter/thinkingmachines/inkling:free",         displayName: "Inkling (free)",             description: "Free Thinking Machines Inkling for testing.",         isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/minimax/minimax-m3:free",               displayName: "MiniMax M3 (free)",          description: "Free MiniMax M3 agentic/coding model for testing.",   isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/nvidia/nemotron-3.5-lightning:free",    displayName: "Nemotron 3.5 Lightning (free)", description: "Free NVIDIA Nemotron 3.5 Lightning for testing.",  isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
  { id: "openrouter/z-ai/glm-5.2:free",                     displayName: "GLM 5.2 (free)",             description: "Free Z.AI GLM 5.2 for testing.",                      isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 256_000 },
  { id: "openrouter/nvidia/nemotron-3-super-120b-a12b:free", displayName: "Nemotron 3 Super (free)",   description: "Free NVIDIA Nemotron 3 Super for testing.",           isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 262_144 },
  { id: "openrouter/google/gemma-4-31b-it:free",            displayName: "Gemma 4 31B (free)",         description: "Free Google Gemma 4 31B for testing.",                isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 262_144 },

  // Z.AI (Zhipu / GLM) DIRECT — rides the OpenAI client + Z.AI base URL (see
  // MODEL_PROVIDER_META.zai), NOT OpenRouter. Vendor ids are the bare Z.AI ids
  // ("glm-5.3"), no namespace slash inside. GLM supports a reasoning_effort
  // knob, but it's a non-native extra-body param on the OpenAI client, so
  // effort stays off (supportedEfforts: []) until it's wired + smoke-tested.
  { id: "zai/glm-5.3",       displayName: "GLM-5.3 (Z.AI)",       description: "Z.AI's flagship GLM reasoning/coding model.",  isDefault: false, provider: "zai", supportedEfforts: [], defaultEffort: null, contextWindow: 1_310_720 },
  { id: "zai/glm-5.3-flash", displayName: "GLM-5.3 Flash (Z.AI)", description: "Fast GLM 5.3 tier for routine work.",          isDefault: false, provider: "zai", supportedEfforts: [], defaultEffort: null, contextWindow: 1_310_720 },
  { id: "zai/glm-5.2",       displayName: "GLM-5.2 (Z.AI)",       description: "Prior-generation GLM reasoning model.",        isDefault: false, provider: "zai", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "zai/glm-4.7",       displayName: "GLM-4.7 (Z.AI)",       description: "Older, lower-cost GLM model.",                 isDefault: false, provider: "zai", supportedEfforts: [], defaultEffort: null, contextWindow: 204_800 },
  { id: "zai/glm-4.7-flash", displayName: "GLM-4.7 Flash (Z.AI)", description: "Free, rate-limited GLM Flash for testing.",    isDefault: false, provider: "zai", supportedEfforts: [], defaultEffort: null, contextWindow: 202_752 },
] as const;

export type AvailableModel = (typeof AVAILABLE_MODELS)[number];
