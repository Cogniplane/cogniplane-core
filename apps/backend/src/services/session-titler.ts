import type { RuntimeProvider } from "./admin-config-records.js";
import type { TokenUsageRecord } from "./message-store.js";

export type SessionTitlerResult = {
  title: string;
  tokenUsage: TokenUsageRecord;
  modelName: string;
};

export type SessionTitlerKeys = {
  anthropicApiKey?: string | null;
  openaiApiKey?: string | null;
};

export type SessionTitlerConfig = {
  claudeModel: string;
  codexModel: string;
  timeoutMs: number;
};

const SYSTEM_PROMPT =
  "You generate concise chat session titles. Respond with ONLY a 3 to 6 word title " +
  "summarizing the user's first message. No quotes, no punctuation at the end, no 'Title:' prefix. " +
  "Use title case.";

const USER_PROMPT_PREFIX = "First message:\n\n";
const MAX_INPUT_CHARS = 2000;
const MAX_OUTPUT_TOKENS = 32;

function truncatePrompt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_INPUT_CHARS) return trimmed;
  return trimmed.slice(0, MAX_INPUT_CHARS);
}

function sanitizeTitle(raw: string): string | null {
  let title = raw.trim();
  let previous: string;
  do {
    previous = title;
    title = title.replace(/^["'`]+|["'`]+$/g, "");
    title = title.replace(/^title[:\-\s]+/i, "");
    title = title.replace(/[.!?]+$/g, "");
    title = title.trim();
  } while (title !== previous);
  title = title.replace(/\s+/g, " ").trim();
  if (!title) return null;
  const words = title.split(" ");
  const capped = words.slice(0, 8).join(" ");
  if (capped.length > 120) return capped.slice(0, 120).trim();
  return capped;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  firstMessage: string,
  timeoutMs: number
): Promise<SessionTitlerResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: USER_PROMPT_PREFIX + truncatePrompt(firstMessage) }
        ]
      })
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    const textBlock = body.content?.find((b) => b.type === "text");
    const title = textBlock?.text ? sanitizeTitle(textBlock.text) : null;
    if (!title) return null;
    const inputTokens = Number(body.usage?.input_tokens ?? 0);
    const cachedInputTokens = Number(body.usage?.cache_read_input_tokens ?? 0);
    const outputTokens = Number(body.usage?.output_tokens ?? 0);
    const tokenUsage: TokenUsageRecord = {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens: 0,
      totalTokens: inputTokens + outputTokens
    };
    return { title, tokenUsage, modelName: model };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(
  apiKey: string,
  model: string,
  firstMessage: string,
  timeoutMs: number
): Promise<SessionTitlerResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: USER_PROMPT_PREFIX + truncatePrompt(firstMessage) }
        ]
      })
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const raw = body.choices?.[0]?.message?.content ?? "";
    const title = sanitizeTitle(raw);
    if (!title) return null;
    const inputTokens = Number(body.usage?.prompt_tokens ?? 0);
    const cachedInputTokens = Number(body.usage?.prompt_tokens_details?.cached_tokens ?? 0);
    const outputTokens = Number(body.usage?.completion_tokens ?? 0);
    const tokenUsage: TokenUsageRecord = {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens: 0,
      totalTokens: inputTokens + outputTokens
    };
    return { title, tokenUsage, modelName: model };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function generateSessionTitle(input: {
  runtimeProvider: RuntimeProvider;
  firstMessage: string;
  keys: SessionTitlerKeys;
  config: SessionTitlerConfig;
}): Promise<SessionTitlerResult | null> {
  const firstMessage = input.firstMessage.trim();
  if (!firstMessage) return null;

  if (input.runtimeProvider === "claude-code") {
    const key = input.keys.anthropicApiKey?.trim();
    if (!key) return null;
    return callAnthropic(key, input.config.claudeModel, firstMessage, input.config.timeoutMs);
  }

  const key = input.keys.openaiApiKey?.trim();
  if (!key) return null;
  return callOpenAI(key, input.config.codexModel, firstMessage, input.config.timeoutMs);
}
