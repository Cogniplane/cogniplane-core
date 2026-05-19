import { parseJudgeOutput } from "./skill-judge-parser.js";
import { JUDGE_SYSTEM_PROMPT, renderJudgeUserPrompt } from "./skill-judge-prompt.js";
import type {
  SkillJudgeInput,
  SkillJudgeProvider,
  SubmissionResult,
  SyncResult
} from "./skill-judge-types.js";

/**
 * Sync provider that calls the Anthropic Messages API for a single session
 * per request. Picked for v1 because it's debuggable end-to-end: a failing
 * tenant lights up immediately in logs instead of only showing up when a
 * 24h-later batch resolves.
 *
 * Batch ships in a follow-up as a sibling implementation of `SkillJudgeProvider`
 * with `mode: "batch"`. The worker does NOT need to change — it already
 * branches on `submission.mode`.
 *
 * No retry on 5xx for now: the worker treats failures as judgments to skip
 * (the row stays without a judgment and is eligible again on the next tick
 * once an admin clears the failed row). This keeps the worker simple and
 * avoids long-running ticks.
 */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 2_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export type AnthropicSyncJudgeProviderInput = {
  apiKey: string;
  model: string;
  /** Hard cap on output tokens. Defaults to 2000 — enough for ~20 skills. */
  maxTokens?: number;
  /** Per-request timeout. Defaults to 60s. */
  timeoutMs?: number;
  /** Override the fetch implementation (used in tests). */
  fetcher?: typeof fetch;
};

type AnthropicResponseBody = {
  id?: string;
  content?: Array<{ type?: string; text?: string }>;
};

export class AnthropicJudgeError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = "AnthropicJudgeError";
  }
}

export class AnthropicSyncJudgeProvider implements SkillJudgeProvider {
  readonly providerId = "anthropic";
  readonly mode = "sync" as const;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(input: AnthropicSyncJudgeProviderInput) {
    if (!input.apiKey) {
      throw new Error("AnthropicSyncJudgeProvider requires an apiKey.");
    }
    if (!input.model) {
      throw new Error("AnthropicSyncJudgeProvider requires a model.");
    }
    this.apiKey = input.apiKey;
    this.model = input.model;
    this.maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = input.fetcher ?? fetch;
  }

  async submit(inputs: SkillJudgeInput[]): Promise<SubmissionResult> {
    const results = new Map<string, SyncResult>();
    // Sync mode: serialize requests so a single failure doesn't cancel the
    // others. Each session is independent; the worker decides whether to
    // record or fail each one. Anthropic's per-account rate limits mean
    // bursting in parallel is rarely a win for ~5 sessions per tick.
    for (const input of inputs) {
      try {
        const single = await this.submitOne(input);
        results.set(input.sessionId, single);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.set(input.sessionId, { status: "failed", error: message });
      }
    }
    return { mode: "sync", results };
  }

  private async submitOne(input: SkillJudgeInput): Promise<SyncResult> {
    const userPrompt = renderJudgeUserPrompt(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetcher(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          system: JUDGE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }]
        })
      });

      if (!response.ok) {
        const text = await safeReadText(response);
        throw new AnthropicJudgeError(
          `Anthropic Messages API returned ${response.status}.`,
          response.status,
          text
        );
      }

      const body = (await response.json()) as AnthropicResponseBody;
      const textBlock = body.content?.find((b) => b.type === "text");
      const raw = textBlock?.text ?? "";
      if (!raw) {
        throw new AnthropicJudgeError("Anthropic response had no text content.");
      }

      const output = parseJudgeOutput(raw);
      return { status: "succeeded", output, rawRequestId: body.id ?? null };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
