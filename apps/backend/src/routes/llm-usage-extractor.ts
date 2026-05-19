// Provider-specific token-usage extraction from upstream LLM responses.
//
// The proxy pipes upstream chunks straight to the client. Alongside that
// pass-through it feeds each chunk to a `UsageSniffer` which buffers SSE
// frames, looks for the provider's final usage event, and returns a
// TokenUsageRecord at end-of-stream. The sniffer never mutates bytes;
// streaming behavior is preserved.
//
// Anthropic SSE:
//   - `message_start.message.usage` carries input_tokens (+ cache details).
//   - `message_delta.usage` carries cumulative output_tokens, and may
//     refresh input_tokens on the final delta.
//   - `message_stop` has no usage payload of its own.
//
// OpenAI Responses SSE:
//   - `response.completed.response.usage` carries the full block:
//       input_tokens, output_tokens, total_tokens,
//       input_tokens_details.cached_tokens,
//       output_tokens_details.reasoning_tokens
//
// OpenAI Chat Completions SSE (not used by Codex today, but easy to keep
// the surface uniform): final chunk's `usage` field — requires the caller
// to have requested `stream_options.include_usage: true`.
//
// JSON (non-streaming) responses go through `extractUsageFromJson`.

import type { TokenUsageRecord } from "../services/message-store.js";

export type LlmProviderId = "anthropic" | "openai";

// ── public surface ─────────────────────────────────────────────────────────

export interface UsageSniffer {
  /** Feed one chunk of upstream bytes. Returns nothing; result is read via `finalize()`. */
  push(chunk: Uint8Array): void;
  /** Call after the upstream stream ends. Returns the captured usage, or null. */
  finalize(): TokenUsageRecord | null;
}

export function createUsageSniffer(provider: LlmProviderId): UsageSniffer {
  return provider === "anthropic" ? new AnthropicSseSniffer() : new OpenaiSseSniffer();
}

export function extractUsageFromJson(
  provider: LlmProviderId,
  body: string
): TokenUsageRecord | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isPlainObject(json)) return null;
  return provider === "anthropic" ? readAnthropicUsage(json["usage"]) : readOpenaiUsage(json["usage"]);
}

// ── helpers ────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readAnthropicUsage(raw: unknown): TokenUsageRecord | null {
  if (!isPlainObject(raw)) return null;
  // Anthropic billing convention: cache_creation_input_tokens are charged
  // at the regular input rate, cache_read_input_tokens at the cached rate.
  // We collapse to TokenUsageRecord's two-bucket model: cachedInputTokens
  // is what cost_usd's cached tier prices, everything else is input.
  const cacheRead = num(raw["cache_read_input_tokens"]);
  const cacheCreate = num(raw["cache_creation_input_tokens"]);
  const baseInput = num(raw["input_tokens"]);
  const outputTokens = num(raw["output_tokens"]);
  const inputTokens = baseInput + cacheCreate + cacheRead;
  if (inputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    cachedInputTokens: cacheRead,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}

function readOpenaiUsage(raw: unknown): TokenUsageRecord | null {
  if (!isPlainObject(raw)) return null;
  const inputTokens = num(raw["input_tokens"] ?? raw["prompt_tokens"]);
  const outputTokens = num(raw["output_tokens"] ?? raw["completion_tokens"]);
  if (inputTokens === 0 && outputTokens === 0) return null;
  const inputDetails = isPlainObject(raw["input_tokens_details"])
    ? raw["input_tokens_details"]
    : null;
  const outputDetails = isPlainObject(raw["output_tokens_details"])
    ? raw["output_tokens_details"]
    : null;
  const cachedInputTokens = inputDetails ? num(inputDetails["cached_tokens"]) : 0;
  const reasoningOutputTokens = outputDetails ? num(outputDetails["reasoning_tokens"]) : 0;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: num(raw["total_tokens"]) || inputTokens + outputTokens
  };
}

// ── SSE sniffers ───────────────────────────────────────────────────────────

/**
 * Base class: line-buffers SSE chunks and yields parsed `(event, data)`
 * pairs to the subclass. SSE events end at a blank line; data lines can
 * be split across chunks, so we keep a tail buffer between pushes.
 */
abstract class SseSniffer implements UsageSniffer {
  // Each sniffer owns its TextDecoder — `decode(..., { stream: true })`
  // keeps partial UTF-8 state between calls, and a module-level decoder
  // shared across concurrent proxied streams would let one stream's mid-
  // codepoint remainder bleed into another's parse and corrupt usage
  // extraction. Per-instance keeps decoder state strictly per stream.
  private readonly decoder = new TextDecoder();
  private tail = "";
  private currentEvent: string | null = null;
  private currentData = "";
  protected captured: TokenUsageRecord | null = null;

  push(chunk: Uint8Array): void {
    // We can't short-circuit after the first usage payload arrives:
    // providers emit usage incrementally (Anthropic splits input vs output
    // across message_start and message_delta), so we have to keep parsing
    // until end-of-stream.
    const text = this.tail + this.decoder.decode(chunk, { stream: true });
    let cursor = 0;
    while (true) {
      const newlineIdx = text.indexOf("\n", cursor);
      if (newlineIdx === -1) {
        this.tail = text.slice(cursor);
        return;
      }
      const rawLine = text.slice(cursor, newlineIdx).replace(/\r$/, "");
      cursor = newlineIdx + 1;
      this.handleLine(rawLine);
    }
  }

  finalize(): TokenUsageRecord | null {
    if (this.tail) {
      this.handleLine(this.tail.replace(/\r$/, ""));
      this.tail = "";
    }
    // A trailing event without its closing blank line (some providers
    // omit it on the final frame) means currentData is still buffered.
    // Force one last dispatch so it isn't dropped.
    if (this.currentEvent !== null || this.currentData !== "") {
      this.onEvent(this.currentEvent ?? "message", this.currentData);
      this.currentEvent = null;
      this.currentData = "";
    }
    if (!this.captured) return null;
    // totalTokens is derived from the final input + output, not tracked
    // independently — providers emit usage incrementally and a per-field
    // max would let an early "totalTokens=120 with output=0" event mask a
    // later "output=42" update.
    return {
      ...this.captured,
      totalTokens: this.captured.inputTokens + this.captured.outputTokens
    };
  }

  private handleLine(line: string): void {
    if (line === "") {
      // Frame boundary — dispatch buffered event + data.
      if (this.currentEvent !== null || this.currentData !== "") {
        this.onEvent(this.currentEvent ?? "message", this.currentData);
      }
      this.currentEvent = null;
      this.currentData = "";
      return;
    }
    if (line.startsWith("event:")) {
      this.currentEvent = line.slice("event:".length).trim();
      return;
    }
    if (line.startsWith("data:")) {
      // Multi-line `data:` is joined with newlines per the SSE spec.
      const piece = line.slice("data:".length).trimStart();
      this.currentData = this.currentData ? `${this.currentData}\n${piece}` : piece;
      return;
    }
    // Ignore other fields (id:, retry:, comments).
  }

  protected abstract onEvent(event: string, data: string): void;

  protected updateCapture(next: TokenUsageRecord | null): void {
    if (!next) return;
    if (!this.captured) {
      this.captured = next;
      return;
    }
    // Anthropic emits cumulative usage across multiple `message_delta`
    // events; the final delta is the authoritative one. Take max of each
    // field so reordering or stream truncation still yields the largest
    // observed values rather than silently regressing.
    this.captured = {
      inputTokens: Math.max(this.captured.inputTokens, next.inputTokens),
      cachedInputTokens: Math.max(this.captured.cachedInputTokens, next.cachedInputTokens),
      outputTokens: Math.max(this.captured.outputTokens, next.outputTokens),
      reasoningOutputTokens: Math.max(
        this.captured.reasoningOutputTokens,
        next.reasoningOutputTokens
      ),
      totalTokens: Math.max(this.captured.totalTokens, next.totalTokens)
    };
  }
}

class AnthropicSseSniffer extends SseSniffer {
  protected onEvent(event: string, data: string): void {
    if (event !== "message_start" && event !== "message_delta") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isPlainObject(parsed)) return;
    if (event === "message_start") {
      const message = isPlainObject(parsed["message"]) ? parsed["message"] : null;
      this.updateCapture(readAnthropicUsage(message?.["usage"]));
      return;
    }
    // message_delta carries cumulative output_tokens (+ refreshed input)
    this.updateCapture(readAnthropicUsage(parsed["usage"]));
  }
}

class OpenaiSseSniffer extends SseSniffer {
  protected onEvent(event: string, data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isPlainObject(parsed)) return;
    // Responses API: usage sits under response.completed.response.usage
    if (event === "response.completed") {
      const response = isPlainObject(parsed["response"]) ? parsed["response"] : null;
      this.updateCapture(readOpenaiUsage(response?.["usage"]));
      return;
    }
    // Chat Completions streaming: usage lands on the final chunk's top-level
    // `usage` when the caller sets stream_options.include_usage = true.
    this.updateCapture(readOpenaiUsage(parsed["usage"]));
  }
}
