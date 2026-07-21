import { test, expect } from "vitest";

import { UtilityLlmClient } from "./utility-llm-client.js";

type Captured = { url: string; body: Record<string, unknown> };

function fakeFetch(payload: unknown, opts: { ok?: boolean; capture?: Captured[] } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    opts.capture?.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : {}
    });
    return {
      ok: opts.ok ?? true,
      status: opts.ok === false ? 500 : 200,
      json: async () => payload
    } as Response;
  }) as typeof fetch;
}

function buildClient(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof UtilityLlmClient>[0]> = {}) {
  return new UtilityLlmClient({
    baseUrl: "http://10.0.0.1:11434",
    model: "gemma-test",
    timeoutMs: 2000,
    wireFormat: "ollama",
    fetch: fetchImpl,
    ...overrides
  });
}

test("ollama wire format posts to /api/chat and maps native token counts", async () => {
  const capture: Captured[] = [];
  const client = buildClient(
    fakeFetch(
      { message: { content: "Fibonacci Sequence Generator" }, prompt_eval_count: 55, eval_count: 6 },
      { capture }
    ),
    { disableThinking: true }
  );

  const result = await client.completeText({ system: "titles", user: "write fib", maxOutputTokens: 32 });

  expect(result?.text).toBe("Fibonacci Sequence Generator");
  expect(result?.modelName).toBe("gemma-test");
  expect(result?.tokenUsage).toEqual({
    inputTokens: 55,
    cachedInputTokens: 0,
    outputTokens: 6,
    reasoningOutputTokens: 0,
    totalTokens: 61
  });

  const body = capture[0].body;
  expect(capture[0].url).toBe("http://10.0.0.1:11434/api/chat");
  expect(body.think).toBe(false);
  expect(body.stream).toBe(false);
  expect((body.options as Record<string, unknown>).num_predict).toBe(32);
});

test("ollama wire format omits think unless disableThinking is set", async () => {
  const capture: Captured[] = [];
  const client = buildClient(fakeFetch({ message: { content: "T" } }, { capture }));
  await client.completeText({ system: "s", user: "u", maxOutputTokens: 8 });
  expect(capture[0].body.think).toBeUndefined();
});

test("openai wire format posts to /chat/completions with bearer auth and maps usage", async () => {
  const capture: Captured[] = [];
  const client = buildClient(
    fakeFetch(
      {
        choices: [{ message: { content: "A Title" } }],
        usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 5 } }
      },
      { capture }
    ),
    { baseUrl: "http://vllm.local/v1", wireFormat: "openai", apiKey: "k-1" }
  );

  const result = await client.completeText({ system: "s", user: "u", maxOutputTokens: 16 });

  expect(capture[0].url).toBe("http://vllm.local/v1/chat/completions");
  expect(capture[0].body.max_completion_tokens).toBe(16);
  expect(result?.text).toBe("A Title");
  expect(result?.tokenUsage.cachedInputTokens).toBe(5);
  expect(result?.tokenUsage.totalTokens).toBe(24);
});

test("returns null on HTTP error, empty content, and thrown fetch", async () => {
  expect(
    await buildClient(fakeFetch({}, { ok: false })).completeText({ system: "s", user: "u", maxOutputTokens: 8 })
  ).toBeNull();
  expect(
    await buildClient(fakeFetch({ message: { content: "  " } })).completeText({ system: "s", user: "u", maxOutputTokens: 8 })
  ).toBeNull();
  const throwing = (async () => {
    throw new Error("boom");
  }) as unknown as typeof fetch;
  expect(await buildClient(throwing).completeText({ system: "s", user: "u", maxOutputTokens: 8 })).toBeNull();
});
