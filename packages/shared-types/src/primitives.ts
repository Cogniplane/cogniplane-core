// Primitive type definitions shared across the API surface. They live outside
// index.ts. Schema modules import them directly, because a re-entry through the
// index barrel causes a circular-init crash when schemas read `EFFORT_LEVELS`.

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

// Deep Agents is the only runtime provider.
export type RuntimeProvider = "deep-agents";

// The LLM provider that a model id resolves through in the Deep Agents
// runtime. It differs from RuntimeProvider: one runtime can use many model
// providers. This is the public provider identity, used for tenant keys and
// the model catalog. It is NOT necessarily the LangChain initChatModel prefix.
// See MODEL_PROVIDER_META. Widen this union when a new provider ships.
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
 * - `keyPattern` — how `redactSecrets()` finds this provider's API key in any
 *   text. `null` only when another provider's pattern already matches the key
 *   (say which in a comment). The pattern has no flags, and it must take linear
 *   time: add a large-input case to `redact-secrets.test.ts`
 *   (docs/security.md, "Secrets and encryption"). The patterns run in
 *   MODEL_PROVIDERS order, so a pattern whose prefix extends another's (Anthropic
 *   `sk-ant-` over OpenAI `sk-`) must come first.
 * - `reasoningEffort` — which mapping `applyReasoningEffort` uses for the
 *   turn's effort: the request shape of the provider's client, or
 *   `"unsupported"` to send no effort.
 */
export type ReasoningEffortMapping = "anthropic" | "openai" | "google" | "unsupported";

export type ModelProviderMeta = {
  label: string;
  initPrefix: "anthropic" | "openai" | "google-genai";
  baseUrl: string | null;
  envKey: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY" | "OPENROUTER_API_KEY" | "ZAI_API_KEY";
  keyField: "anthropicApiKey" | "openaiApiKey" | "googleApiKey" | "openrouterApiKey" | "zaiApiKey";
  keyPattern: RegExp | null;
  reasoningEffort: ReasoningEffortMapping;
};

export const MODEL_PROVIDER_META: Record<ModelProvider, ModelProviderMeta> = {
  anthropic: {
    label: "Anthropic",
    initPrefix: "anthropic",
    baseUrl: null,
    envKey: "ANTHROPIC_API_KEY",
    keyField: "anthropicApiKey",
    keyPattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/,
    reasoningEffort: "anthropic"
  },
  openai: {
    label: "OpenAI",
    initPrefix: "openai",
    baseUrl: null,
    envKey: "OPENAI_API_KEY",
    keyField: "openaiApiKey",
    keyPattern: /\bsk-[A-Za-z0-9_-]{20,}/,
    reasoningEffort: "openai"
  },
  google: {
    label: "Google",
    initPrefix: "google-genai",
    baseUrl: null,
    envKey: "GOOGLE_API_KEY",
    keyField: "googleApiKey",
    keyPattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    reasoningEffort: "google"
  },
  openrouter: {
    // No native initChatModel provider: ride the OpenAI client with the
    // OpenRouter base URL. One OpenRouter key unlocks many open models.
    label: "OpenRouter",
    initPrefix: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    keyField: "openrouterApiKey",
    // OpenRouter keys start with `sk-or-`, which the OpenAI pattern matches.
    keyPattern: null,
    // The OpenAI client sends `reasoning.effort`. OpenRouter models advertise
    // no efforts today, so no turn sends one.
    reasoningEffort: "openai"
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
    keyField: "zaiApiKey",
    // A hex key id, a dot, then an alphanumeric secret
    // (`1a2b...def.AbCd1234EfGh5678`). No distinctive prefix, so the pattern
    // needs a long id to stay off ordinary text.
    keyPattern: /\b[0-9a-f]{20,}\.[A-Za-z0-9]{12,}\b/,
    reasoningEffort: "openai"
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

export const DEVELOPER_INSTRUCTIONS_MAX_LENGTH = 4000;
