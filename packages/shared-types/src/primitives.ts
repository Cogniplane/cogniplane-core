// Primitive type definitions shared across the API surface. Lives in its own
// file (not in index.ts) so the schema modules can import these without
// re-entering the index barrel — that re-entry caused a circular-init crash
// at runtime when the schemas tried to read `EFFORT_LEVELS` from a half-loaded
// index.

export type GranularApprovalPolicy = {
  granular: {
    sandbox_approval: boolean;
    mcp_elicitations: boolean;
    rules: boolean;
    request_permissions?: boolean;
    skill_approval?: boolean;
  };
};

export type ApprovalPolicy = "never" | "on-request" | GranularApprovalPolicy;

export type ApprovalReviewer = "user" | "guardian_subagent";

// Deep Agents is the sole runtime provider since the Codex/claude-code
// retirements.
export type RuntimeProvider = "deep-agents";

// The LLM provider a model id resolves through inside the Deep Agents
// runtime. Distinct from RuntimeProvider: one runtime, potentially many model
// providers. This is the PUBLIC provider identity (what a tenant configures a
// key for and what the model catalog tags); it is NOT necessarily the
// LangChain initChatModel prefix — see MODEL_PROVIDER_META for that mapping
// ("openrouter" resolves through the "openai" init prefix + a base URL,
// "google" resolves through the "google-genai" prefix). Widen this union when
// a new provider ships.
export const MODEL_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "zai"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * Per-provider construction facts consumed by the Deep Agents graph when it
 * calls LangChain `initChatModel`.
 *
 * - `initPrefix` — the LangChain provider prefix. NOT always the same as the
 *   public provider id: OpenRouter and Z.AI have no native initChatModel
 *   provider, so they ride the "openai" client with a custom base URL; Google's
 *   key-based (non-Vertex) client is registered under "google-genai", not
 *   "google".
 * - `baseUrl` — when set, passed to the OpenAI client as
 *   `configuration.baseURL` (a top-level baseUrl is silently ignored by
 *   @langchain/openai and would call api.openai.com instead — verified).
 * - `envKey` — the platform-level env var that provides a fallback key for all
 *   tenants when no tenant key is stored.
 * - `keyField` — the camelCase field used in the tenant key request/response
 *   contract and the settings store (`<provider>ApiKey`).
 */
export type ModelProviderMeta = {
  label: string;
  initPrefix: "anthropic" | "openai" | "google-genai";
  baseUrl: string | null;
  envKey: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY" | "OPENROUTER_API_KEY" | "ZAI_API_KEY";
  keyField: "anthropicApiKey" | "openaiApiKey" | "googleApiKey" | "openrouterApiKey" | "zaiApiKey";
};

export const MODEL_PROVIDER_META: Record<ModelProvider, ModelProviderMeta> = {
  anthropic: {
    label: "Anthropic",
    initPrefix: "anthropic",
    baseUrl: null,
    envKey: "ANTHROPIC_API_KEY",
    keyField: "anthropicApiKey"
  },
  openai: {
    label: "OpenAI",
    initPrefix: "openai",
    baseUrl: null,
    envKey: "OPENAI_API_KEY",
    keyField: "openaiApiKey"
  },
  google: {
    label: "Google",
    initPrefix: "google-genai",
    baseUrl: null,
    envKey: "GOOGLE_API_KEY",
    keyField: "googleApiKey"
  },
  openrouter: {
    // No native initChatModel provider: ride the OpenAI client with the
    // OpenRouter base URL. One OpenRouter key unlocks many open models.
    label: "OpenRouter",
    initPrefix: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    keyField: "openrouterApiKey"
  },
  zai: {
    // Z.AI (Zhipu, the GLM models). Like OpenRouter, no native initChatModel
    // provider: rides the OpenAI client with Z.AI's OpenAI-compatible base URL
    // (Bearer auth, standard chat/completions).
    //
    // Base URL is the GLM CODING PLAN endpoint (/api/coding/paas/v4), which
    // bills against a GLM Coding Plan subscription. This is deliberately NOT the
    // general pay-per-token endpoint (/api/paas/v4): a Coding-Plan key hitting
    // the general endpoint returns "429 Insufficient balance or no resource
    // package" because that endpoint looks for a pay-per-token balance. Both
    // endpoints are OpenAI-compatible and accept the same model ids (glm-5.2,
    // glm-4.7, ...). Switch back to /api/paas/v4 for a pay-per-token key.
    label: "Z.AI",
    initPrefix: "openai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    envKey: "ZAI_API_KEY",
    keyField: "zaiApiKey"
  }
};

// Web-search posture setting. A tenant setting consumed by the Deep Agents
// runtime. "disabled" turns the tool off; "cached" lets the model search a
// cached index; "live" hits the network.
export const WEB_SEARCH_MODES = ["disabled", "cached", "live"] as const;
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];

export const EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
