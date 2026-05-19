import { parseJudgeOutput } from "./skill-judge-parser.js";
import { JUDGE_SYSTEM_PROMPT, renderJudgeUserPrompt } from "./skill-judge-prompt.js";
import type {
  SkillJudgeInput,
  SkillJudgeProvider,
  SubmissionResult,
  SyncResult
} from "./skill-judge-types.js";

/**
 * Sync provider for OpenAI Chat Completions.
 *
 * Uses `response_format: { type: "json_object" }` so the model is constrained
 * to emit JSON. The parser still defends against fenced output / preamble
 * because the constraint is a hint, not a hard guarantee for older models.
 *
 * Like the Anthropic sync provider, sessions are submitted serially per
 * provider call. The point of `submit(inputs[])` is the *batch* provider's
 * cost discount; sync mode just iterates so the worker has one consistent
 * contract to drive.
 */

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAX_TOKENS = 2_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export type OpenAISyncJudgeProviderInput = {
  apiKey: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

type OpenAIChatResponse = {
  id?: string;
  choices?: Array<{ message?: { content?: string } }>;
};

export class OpenAIJudgeError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = "OpenAIJudgeError";
  }
}

export class OpenAISyncJudgeProvider implements SkillJudgeProvider {
  readonly providerId = "openai";
  readonly mode = "sync" as const;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(input: OpenAISyncJudgeProviderInput) {
    if (!input.apiKey) throw new Error("OpenAISyncJudgeProvider requires an apiKey.");
    if (!input.model) throw new Error("OpenAISyncJudgeProvider requires a model.");
    this.apiKey = input.apiKey;
    this.model = input.model;
    this.maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = input.fetcher ?? fetch;
  }

  async submit(inputs: SkillJudgeInput[]): Promise<SubmissionResult> {
    const results = new Map<string, SyncResult>();
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
      const response = await this.fetcher(OPENAI_CHAT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        signal: controller.signal,
        body: JSON.stringify(buildOpenAiChatRequest({
          model: this.model,
          maxTokens: this.maxTokens,
          system: JUDGE_SYSTEM_PROMPT,
          userPrompt
        }))
      });

      if (!response.ok) {
        const text = await safeReadText(response);
        throw new OpenAIJudgeError(
          `OpenAI Chat Completions returned ${response.status}.`,
          response.status,
          text
        );
      }

      const body = (await response.json()) as OpenAIChatResponse;
      const raw = body.choices?.[0]?.message?.content ?? "";
      if (!raw) throw new OpenAIJudgeError("OpenAI response had no message content.");

      const output = parseJudgeOutput(raw);
      return { status: "succeeded", output, rawRequestId: body.id ?? null };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Exported for reuse by the OpenAI batch provider — both build the same
 * Chat Completions request body, just delivered differently (live POST vs.
 * one JSONL line in a batch file).
 */
export function buildOpenAiChatRequest(opts: {
  model: string;
  maxTokens: number;
  system: string;
  userPrompt: string;
}): Record<string, unknown> {
  return {
    model: opts.model,
    max_completion_tokens: opts.maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.userPrompt }
    ]
  };
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
