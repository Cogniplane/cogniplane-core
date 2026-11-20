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
  // Deep Agents: the agent loop runs in-process via
  // deepagentsjs + initChatModel. Ids are namespaced "<catalog>/<vendorModel>";
  // the graph maps each id to its provider via the `provider` field here (NOT
  // the namespace) and builds the initChatModel string from
  // MODEL_PROVIDER_META. See resolveModelConstruction in deep-agents-graph.ts.
  //
  // supportedEfforts drives the composer's Effort dropdown AND is applied to
  // model construction per-provider: Anthropic extended thinking, OpenAI
  // reasoning.effort, Gemini thinking budget. See applyReasoningEffort in
  // deep-agents-graph.ts for how each level maps to the client config.
  //
  // isDefault marks at most one default per provider. Callers take the first
  // default whose provider has a key, so catalog order sets the priority:
  // Anthropic (Haiku 5.5) first, then OpenAI (GPT-6 Luna).

  // Anthropic (initChatModel prefix "anthropic"). Extended thinking maps to
  // none/low/medium/high → a thinking token budget (0 = off). Vendor ids use
  // Anthropic's dashed API form ("claude-opus-4-8"), NOT the dotted form the
  // OpenRouter catalog shows — these call the Anthropic API directly.
  // Fable 5.2 thinking is always on: the API refuses thinking "disabled", so
  // it does not advertise none (Anthropic models page, 2026-11-19).
  { id: "deepagents/claude-fable-5-2",           displayName: "Claude Fable 5.2", description: "Anthropic's most capable model for the most demanding technical work.", isDefault: false, provider: "anthropic", supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindow: 1_000_000 },
  { id: "deepagents/claude-fable-5-1",           displayName: "Claude Fable 5.1", description: "Prior-generation Anthropic frontier model.",       isDefault: false, provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-opus-5-5",            displayName: "Claude Opus 5.5",  description: "Anthropic model for long-running coding and knowledge work.", isDefault: false, provider: "anthropic", supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-opus-5",              displayName: "Claude Opus 5",    description: "Prior-generation Anthropic model for complex agentic work.", isDefault: false, provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-fable-5",             displayName: "Claude Fable 5",   description: "Prior-generation Anthropic frontier model.",           isDefault: false, provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-opus-4-8",            displayName: "Claude Opus 4.8",  description: "Prior-generation Anthropic reasoning model.",          isDefault: false, provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-sonnet-5-5",          displayName: "Claude Sonnet 5.5", description: "Fast, intelligent model for everyday coding and agent work.", isDefault: false, provider: "anthropic", supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_000_000 },
  { id: "deepagents/claude-sonnet-5",            displayName: "Claude Sonnet 5",  description: "Prior-generation fast, all-round model.",                   isDefault: false, provider: "anthropic",  supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "none",   contextWindow: 1_000_000 },
  { id: "deepagents/claude-haiku-5-5",           displayName: "Claude Haiku 5.5", description: "Fast, low-cost Anthropic model for high-volume work.",  isDefault: true,  provider: "anthropic",  supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_000_000 },
  // Haiku 4.5 has extended thinking but NO `effort` parameter — it only takes the
  // legacy `budget_tokens` mode, which our Anthropic path (outputConfig.effort)
  // doesn't emit. So any effort but `none` is rejected by the API; advertise only
  // `none` (the Effort dropdown then hides, since it needs >1 option).
  { id: "deepagents/claude-haiku-4-5",           displayName: "Claude Haiku 4.5", description: "Prior-generation fast Anthropic model.",               isDefault: false, provider: "anthropic",  supportedEfforts: ["none"], defaultEffort: "none",   contextWindow: 200_000 },

  // OpenAI (initChatModel prefix "openai"). Each model lists its supported
  // reasoning efforts. GPT-6.2 Astra, GPT-6.2 Sol and GPT-6.1 Sol start at low
  // and do not accept none (OpenAI model pages, 2026-11-19). GPT-6.1 Terra
  // accepts none through max (OpenAI model page, 2026-10-27). The GPT-6.2 "Pro"
  // variants are `reasoning.mode: pro` on the same model, not model ids, so
  // they are not in the catalog. Vendor model id follows the "/".
  { id: "openai/gpt-6.2-astra",                  displayName: "GPT-6.2 Astra",                  description: "OpenAI's most capable model for the hardest projects.", isDefault: false, provider: "openai",     supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-6.2-sol",                    displayName: "GPT-6.2 Sol",                    description: "OpenAI model for everyday coding and agents at scale.", isDefault: false, provider: "openai",     supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-6-astra-pro",                displayName: "GPT-6 Astra Pro",                description: "Prior-generation GPT-6 Astra Pro model.", isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-6-astra",                    displayName: "GPT-6 Astra",                    description: "Prior-generation GPT-6 flagship model.",                       isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-6.1-sol",                    displayName: "GPT-6.1 Sol",                    description: "Prior-generation Sol model for coding and agent workflows.",      isDefault: false, provider: "openai",     supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-6.1-terra",                  displayName: "GPT-6.1 Terra",                  description: "Mid-tier GPT-6.1 model for everyday agentic, coding, and writing work.", isDefault: false, provider: "openai", supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-6-sol",                      displayName: "GPT-6 Sol",                      description: "OpenAI model for complex coding and agent workflows.",      isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-6-luna",                     displayName: "GPT-6 Luna",                     description: "OpenAI model for focused, high-volume tasks.",             isDefault: true,  provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-5.6-sol",                    displayName: "GPT-5.6 Sol",                    description: "Prior-generation GPT-5.6 flagship model.",             isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-5.6-terra",                  displayName: "GPT-5.6 Terra",                  description: "Balanced GPT-5.6 model for everyday work.",            isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-5.6-luna",                   displayName: "GPT-5.6 Luna",                   description: "Fast, low-cost GPT-5.6 model.",                        isDefault: false, provider: "openai",     supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "low",    contextWindow: 1_050_000 },
  { id: "openai/gpt-5.5",                        displayName: "GPT-5.5",                        description: "Older GPT-5 frontier reasoning model.",                isDefault: false, provider: "openai",     supportedEfforts: ["minimal", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_050_000 },
  { id: "openai/gpt-5.4-mini",                   displayName: "GPT-5.4 mini",                   description: "Faster, lower-cost OpenAI model.",                     isDefault: false, provider: "openai",     supportedEfforts: ["minimal", "low", "medium", "high"], defaultEffort: "low",    contextWindow: 400_000 },

  // Google (initChatModel prefix "google-genai" — the key-based Gemini client,
  // NOT Vertex; see MODEL_PROVIDER_META). Thinking level maps to
  // none/low/medium/high. Gemini 4 models document only low/medium/high (Neon
  // and Hydrogen also xhigh) and no way to turn thinking off, so they do not
  // advertise none. Neon and Hydrogen do not advertise xhigh: the installed
  // @langchain/google-genai thinkingLevel type stops at HIGH, so
  // applyReasoningEffort would send HIGH for it. Ids, levels and defaults:
  // Google models and thinking pages, 2026-11-19.
  { id: "google/gemini-4-carbon",                displayName: "Gemini 4 Carbon",               description: "Google's strongest reasoning model for the hardest, long-horizon work.", isDefault: false, provider: "google", supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_048_576 },
  { id: "google/gemini-4-argon",                 displayName: "Gemini 4 Argon",                description: "Efficient Gemini 4 frontier reasoning model.",         isDefault: false, provider: "google",     supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_048_576 },
  { id: "google/gemini-4-neon",                  displayName: "Gemini 4 Neon",                 description: "Mid-tier Gemini 4 model for complex coding and agentic work.", isDefault: false, provider: "google", supportedEfforts: ["low", "medium", "high"], defaultEffort: "high",   contextWindow: 1_048_576 },
  { id: "google/gemini-4-hydrogen",              displayName: "Gemini 4 Hydrogen",             description: "Fast, low-cost Gemini 4 model for everyday coding and agentic work.", isDefault: false, provider: "google", supportedEfforts: ["low", "medium", "high"], defaultEffort: "high",   contextWindow: 1_048_576 },
  { id: "google/gemini-3.8-flash",               displayName: "Gemini 3.8 Flash",              description: "Google's most intelligent Flash model for agentic work.", isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_048_576 },
  { id: "google/gemini-3.1-pro-preview",         displayName: "Gemini 3.1 Pro (preview)",      description: "Prior-generation Gemini Pro reasoning model (preview).", isDefault: false, provider: "google",     supportedEfforts: ["none", "low", "medium", "high"], defaultEffort: "medium", contextWindow: 1_048_576 },

  // OpenRouter (rides the OpenAI client + OpenRouter base URL). The vendor
  // model id after the namespace contains its own "/" — resolveModelConstruction
  // splits on the FIRST slash only, preserving "deepseek/deepseek-v4-pro".
  // Reasoning-effort support varies per open model and is not applied here
  // (supportedEfforts: []), so the Effort dropdown stays hidden for these.
  // Slugs, context windows and tool support verified 2026-11-19 against
  // https://openrouter.ai/api/v1/models.
  { id: "openrouter/z-ai/glm-5.3",                    displayName: "GLM 5.3 (OpenRouter)",        description: "Z.AI GLM 5.3 — top open-weight model via OpenRouter.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/deepseek/deepseek-v4-pro",        displayName: "DeepSeek V4 Pro (OpenRouter)", description: "DeepSeek V4 Pro reasoning/coding model via OpenRouter.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/deepseek/deepseek-v4.1-flash",    displayName: "DeepSeek V4.1 Flash (OpenRouter)", description: "Fast, efficient DeepSeek V4.1 model via OpenRouter.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },

  // Widely-used open models on OpenRouter (slugs + context windows verified
  // 2026-11-19 via /api/v1/models). OpenRouter's public API exposes no usage
  // ranking today (the ?order= param is accepted but ignored), so this set is
  // curated by capability tier, not by a live token chart.
  { id: "openrouter/tencent/hy4",                     displayName: "Tencent Hy4 (OpenRouter)",       description: "Tencent Hy4 reasoning model for long-horizon agentic work.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/xiaomi/mimo-v2.6-flash",          displayName: "MiMo V2.6 Flash (OpenRouter)",   description: "Xiaomi MiMo V2.6 Flash — fast, low-cost open reasoning model.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_050_000 },
  { id: "openrouter/xiaomi/mimo-v2.6-pro",            displayName: "MiMo V2.6 Pro (OpenRouter)",     description: "Xiaomi MiMo V2.6 Pro — stronger MiMo tier for agentic work.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_050_000 },
  { id: "openrouter/minimax/minimax-m3",              displayName: "MiniMax M3 (OpenRouter)",        description: "MiniMax M3 open agentic/coding model.",                isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b", displayName: "Nemotron 3 Ultra (OpenRouter)", description: "NVIDIA Nemotron 3 Ultra 550B MoE — strongest open Nemotron.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 262_144 },
  { id: "openrouter/stepfun/step-3.7-flash",          displayName: "Step 3.7 Flash (OpenRouter)",    description: "StepFun Step 3.7 Flash — fast open model for routine work.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 262_144 },
  { id: "openrouter/qwen/qwen4-max",                  displayName: "Qwen4 Max (OpenRouter)",         description: "Alibaba Qwen4 Max — flagship of the Qwen4 series.",     isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
  { id: "openrouter/z-ai/glm-5.3-flashx",             displayName: "GLM 5.3 FlashX (OpenRouter)",    description: "Z.AI GLM 5.3 FlashX — fast, low-cost GLM tier.",       isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/x-ai/grok-4.7",                   displayName: "Grok 4.7 (OpenRouter)",          description: "xAI Grok 4.7 reasoning model.",                        isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 500_000 },
  { id: "openrouter/mistralai/mistral-large-4-0",     displayName: "Mistral Large 4 (OpenRouter)",   description: "Mistral Large 4 — Mistral's flagship model.",          isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/meta/muse-spark-1.3",             displayName: "Muse Spark 1.3 (OpenRouter)",    description: "Meta Muse Spark 1.3 general model.",                   isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/meta/muse-ember",                 displayName: "Muse Ember (OpenRouter)",        description: "Meta Muse Ember — small, efficient model for tool calls and agent subtasks.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/meta/muse-wonder",                displayName: "Muse Wonder (OpenRouter)",       description: "Meta Muse Wonder — frontier reasoning model for agentic tasks.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/moonshotai/kimi-k3.1-pro",        displayName: "Kimi K3.1 Pro (OpenRouter)",     description: "Moonshot Kimi K3.1 Pro — flagship open-weight reasoning model.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/minimax/minimax-m3.1-flash",      displayName: "MiniMax M3.1 Flash (OpenRouter)", description: "MiniMax M3.1 Flash — fast, low-cost successor tier to M3.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/stepfun/step-5-preview",          displayName: "Step 5 Preview (OpenRouter)",    description: "StepFun Step 5 (preview) — flagship model for agentic work.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },
  { id: "openrouter/thinkingmachines/inkling-2-small", displayName: "Inkling 2 Small (OpenRouter)", description: "Thinking Machines Inkling 2 Small — open-weight MoE reasoning model.", isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_048_576 },

  // OpenRouter free tier (":free" slugs) — for testing without spend. Routes
  // rotate: OpenRouter retires a free variant without notice (the slug then
  // 404s), so every entry here was confirmed live AND tool-calling-capable on
  // 2026-11-19, and each pairs with a paid slug elsewhere in the catalog or a
  // vendor equivalent. Tool support matters: a model with no `tools` parameter
  // cannot drive the agent loop at all.
  { id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", displayName: "Nemotron 3 Ultra (free)",   description: "Free NVIDIA Nemotron 3 Ultra for testing.",           isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
  { id: "openrouter/nvidia/nemotron-3.5-lightning:free",    displayName: "Nemotron 3.5 Lightning (free)", description: "Free NVIDIA Nemotron 3.5 Lightning for testing.",  isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
  { id: "openrouter/nvidia/nemotron-3.5-super-vl:free",   displayName: "Nemotron 3.5 Super VL (free)", description: "Free NVIDIA Nemotron 3.5 Super VL for testing.",     isDefault: false, provider: "openrouter", supportedEfforts: [], defaultEffort: null, contextWindow: 1_000_000 },
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
