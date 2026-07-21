import type { TokenUsageRecord } from "./message-store.js";
import type { UtilityLlmClient } from "./utility-llm-client.js";

export type SessionTitlerResult = {
  title: string;
  tokenUsage: TokenUsageRecord;
  modelName: string;
};

export type SessionTitlerKeys = {
  anthropicApiKey?: string | null;
};

export type SessionTitlerConfig = {
  claudeModel: string;
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

export async function generateSessionTitle(input: {
  firstMessage: string;
  keys: SessionTitlerKeys;
  config: SessionTitlerConfig;
  /**
   * Optional operator-run local endpoint (UTILITY_LLM_*). Tried FIRST so the
   * raw first message stays in-perimeter and titling works without provider
   * keys; any failure falls through to the provider APIs below.
   */
  utilityClient?: UtilityLlmClient;
}): Promise<SessionTitlerResult | null> {
  const firstMessage = input.firstMessage.trim();
  if (!firstMessage) return null;

  if (input.utilityClient) {
    const local = await input.utilityClient.completeText({
      system: SYSTEM_PROMPT,
      user: USER_PROMPT_PREFIX + truncatePrompt(firstMessage),
      maxOutputTokens: MAX_OUTPUT_TOKENS
    });
    const title = local ? sanitizeTitle(local.text) : null;
    if (local && title) {
      return { title, tokenUsage: local.tokenUsage, modelName: local.modelName };
    }
  }

  const key = input.keys.anthropicApiKey?.trim();
  if (!key) return null;
  return callAnthropic(key, input.config.claudeModel, firstMessage, input.config.timeoutMs);
}
