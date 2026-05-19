import { describe, expect, test } from "vitest";

import {
  createUsageSniffer,
  extractUsageFromJson
} from "./llm-usage-extractor.js";

function chunk(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("AnthropicSseSniffer", () => {
  test("captures input_tokens from message_start and cumulative output from message_delta", () => {
    const s = createUsageSniffer("anthropic");
    s.push(
      chunk(
        [
          'event: message_start',
          'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20}}}',
          "",
          'event: content_block_delta',
          'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
          "",
          'event: message_delta',
          'data: {"type":"message_delta","usage":{"output_tokens":42}}',
          "",
          'event: message_stop',
          'data: {"type":"message_stop"}',
          ""
        ].join("\n") + "\n"
      )
    );
    const usage = s.finalize();
    expect(usage).not.toBeNull();
    // input = 100 (fresh) + 20 (cache_read) = 120; cached = 20; output = 42
    expect(usage!.inputTokens).toBe(120);
    expect(usage!.cachedInputTokens).toBe(20);
    expect(usage!.outputTokens).toBe(42);
    expect(usage!.totalTokens).toBe(162);
  });

  test("survives chunks that split SSE frames at arbitrary byte boundaries", () => {
    const s = createUsageSniffer("anthropic");
    const stream =
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":50}}}',
        "",
        'event: message_delta',
        'data: {"type":"message_delta","usage":{"output_tokens":7}}',
        "",
        ""
      ].join("\n");
    // Drip-feed one byte at a time.
    for (let i = 0; i < stream.length; i++) {
      s.push(chunk(stream[i]!));
    }
    const usage = s.finalize();
    expect(usage?.inputTokens).toBe(50);
    expect(usage?.outputTokens).toBe(7);
  });

  test("returns null when no usage payload is ever seen", () => {
    const s = createUsageSniffer("anthropic");
    s.push(chunk("event: ping\ndata: {}\n\n"));
    expect(s.finalize()).toBeNull();
  });
});

describe("OpenaiSseSniffer", () => {
  test("captures usage from response.completed (Responses API)", () => {
    const s = createUsageSniffer("openai");
    s.push(
      chunk(
        [
          'event: response.created',
          'data: {"type":"response.created"}',
          "",
          'event: response.completed',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":200,"output_tokens":80,"total_tokens":280,"input_tokens_details":{"cached_tokens":50},"output_tokens_details":{"reasoning_tokens":12}}}}',
          ""
        ].join("\n") + "\n"
      )
    );
    const usage = s.finalize();
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(200);
    expect(usage!.cachedInputTokens).toBe(50);
    expect(usage!.outputTokens).toBe(80);
    expect(usage!.reasoningOutputTokens).toBe(12);
    expect(usage!.totalTokens).toBe(280);
  });

  test("captures Chat Completions final-chunk usage (stream_options.include_usage)", () => {
    const s = createUsageSniffer("openai");
    s.push(
      chunk(
        [
          'data: {"choices":[{"delta":{"content":"hi"}}]}',
          "",
          'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}',
          ""
        ].join("\n") + "\n"
      )
    );
    const usage = s.finalize();
    expect(usage?.inputTokens).toBe(11);
    expect(usage?.outputTokens).toBe(3);
    expect(usage?.totalTokens).toBe(14);
  });
});

describe("extractUsageFromJson", () => {
  test("Anthropic non-streaming usage", () => {
    const body = JSON.stringify({
      id: "msg_1",
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 }
    });
    const usage = extractUsageFromJson("anthropic", body);
    expect(usage?.inputTokens).toBe(12);
    expect(usage?.cachedInputTokens).toBe(2);
    expect(usage?.outputTokens).toBe(5);
  });

  test("OpenAI non-streaming usage", () => {
    const body = JSON.stringify({
      id: "chatcmpl-1",
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 }
    });
    const usage = extractUsageFromJson("openai", body);
    expect(usage?.inputTokens).toBe(30);
    expect(usage?.outputTokens).toBe(10);
    expect(usage?.totalTokens).toBe(40);
  });

  test("returns null on malformed JSON", () => {
    expect(extractUsageFromJson("openai", "not-json")).toBeNull();
  });

  test("returns null when usage block is absent", () => {
    expect(extractUsageFromJson("anthropic", "{}")).toBeNull();
  });
});
