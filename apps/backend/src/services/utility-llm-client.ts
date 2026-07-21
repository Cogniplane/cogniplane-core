import type { TokenUsageRecord } from "./message-store.js";

/**
 * Minimal client for small background LLM jobs (session titling today;
 * summaries/corpus distillation later). Points at an operator-run endpoint —
 * typically the same local Ollama/vLLM box that serves PII detection — so
 * trivial jobs stop shipping raw user prompts to third-party APIs and work
 * even for tenants with no provider API keys.
 *
 * Deliberately best-effort: every failure path returns null so callers fall
 * back (e.g. the titler falls back to the provider API, then to no title).
 * No circuit breaker — these jobs are not on any request-critical path.
 *
 * Wire formats mirror the PII provider split (openai-compatible-pii-provider):
 * - `openai`: POST <base>/chat/completions (base URL ends in /v1)
 * - `ollama`: POST <base>/api/chat (base URL is the host root). The only
 *   dialect that honors `think:false` — Ollama's /v1 layer ignores it.
 */
export type UtilityLlmWireFormat = "openai" | "ollama";

export interface UtilityLlmClientOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  wireFormat: UtilityLlmWireFormat;
  disableThinking?: boolean;
  fetch?: typeof fetch;
}

export interface UtilityLlmCompletion {
  text: string;
  tokenUsage: TokenUsageRecord;
  modelName: string;
}

export class UtilityLlmClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly wireFormat: UtilityLlmWireFormat;
  private readonly disableThinking: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: UtilityLlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.wireFormat = options.wireFormat;
    this.disableThinking = options.disableThinking ?? false;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * One-shot system+user completion. Returns null on any failure —
   * timeout, network, HTTP error, or empty content.
   */
  async completeText(input: {
    system: string;
    user: string;
    maxOutputTokens: number;
  }): Promise<UtilityLlmCompletion | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const isOllama = this.wireFormat === "ollama";
      const url = isOllama ? `${this.baseUrl}/api/chat` : `${this.baseUrl}/chat/completions`;
      const messages = [
        { role: "system", content: input.system },
        { role: "user", content: input.user }
      ];
      const body = isOllama
        ? {
            model: this.model,
            messages,
            stream: false,
            // Only emit `think` when disabling — omitting it leaves default
            // behavior intact for models without the flag.
            ...(this.disableThinking ? { think: false } : {}),
            options: { temperature: 0, num_predict: input.maxOutputTokens }
          }
        : {
            model: this.model,
            messages,
            temperature: 0,
            max_completion_tokens: input.maxOutputTokens
          };
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) return null;

      if (isOllama) {
        const payload = (await response.json()) as {
          message?: { content?: string | null };
          prompt_eval_count?: number;
          eval_count?: number;
        };
        const text = payload.message?.content?.trim();
        if (!text) return null;
        const inputTokens = Number(payload.prompt_eval_count ?? 0);
        const outputTokens = Number(payload.eval_count ?? 0);
        return {
          text,
          tokenUsage: {
            inputTokens,
            cachedInputTokens: 0,
            outputTokens,
            reasoningOutputTokens: 0,
            totalTokens: inputTokens + outputTokens
          },
          modelName: this.model
        };
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!text) return null;
      const inputTokens = Number(payload.usage?.prompt_tokens ?? 0);
      const outputTokens = Number(payload.usage?.completion_tokens ?? 0);
      return {
        text,
        tokenUsage: {
          inputTokens,
          cachedInputTokens: Number(payload.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          outputTokens,
          reasoningOutputTokens: 0,
          totalTokens: inputTokens + outputTokens
        },
        modelName: this.model
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
