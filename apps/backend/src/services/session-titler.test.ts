import { test, expect } from "vitest";

import { generateSessionTitle } from "./session-titler.js";
import { UtilityLlmClient } from "./utility-llm-client.js";

type FetchCall = { url: string; init: RequestInit };

function mockFetch(responses: Array<Partial<Response> & { json: unknown; ok?: boolean }>) {
  const calls: FetchCall[] = [];
  let index = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses[index++];
    if (!next) throw new Error("unexpected fetch call");
    return {
      ok: next.ok ?? true,
      status: 200,
      json: async () => next.json
    } as Response;
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    }
  };
}

const CFG = {
  claudeModel: "claude-haiku-4-5-20251001",
  timeoutMs: 2000
};

test("generateSessionTitle: deep-agents uses Anthropic and maps usage", async () => {
  const fake = mockFetch([
    {
      json: {
        content: [{ type: "text", text: "Debugging React Hooks" }],
        usage: { input_tokens: 42, output_tokens: 7, cache_read_input_tokens: 3 }
      }
    }
  ]);
  try {
    const result = await generateSessionTitle({
      firstMessage: "Why does my useEffect run twice in strict mode?",
      keys: { anthropicApiKey: "sk-ant-test" },
      config: CFG
    });
    expect(result).toBeTruthy();
    expect(result!.title).toBe("Debugging React Hooks");
    expect(result!.modelName).toBe("claude-haiku-4-5-20251001");
    expect(result!.tokenUsage.inputTokens).toBe(42);
    expect(result!.tokenUsage.cachedInputTokens).toBe(3);
    expect(result!.tokenUsage.outputTokens).toBe(7);
    expect(result!.tokenUsage.totalTokens).toBe(49);
    expect(fake.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect((fake.calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
  } finally {
    fake.restore();
  }
});

test("generateSessionTitle: deep-agents uses Anthropic (Anthropic-only tenants must title)", async () => {
  const fake = mockFetch([
    {
      json: {
        content: [{ type: "text", text: "Quarterly Sales Analysis" }],
        usage: { input_tokens: 30, output_tokens: 5 }
      }
    }
  ]);
  try {
    const result = await generateSessionTitle({
      firstMessage: "Analyze the Q3 sales CSV and chart revenue.",
      keys: { anthropicApiKey: "sk-ant-test" },
      config: CFG
    });
    expect(result).toBeTruthy();
    expect(result!.title).toBe("Quarterly Sales Analysis");
    expect(fake.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  } finally {
    fake.restore();
  }
});



test("generateSessionTitle: returns null when no Anthropic key", async () => {
  const result = await generateSessionTitle({
    firstMessage: "Hello",
    keys: { anthropicApiKey: null },
    config: CFG
  });
  expect(result).toBe(null);
});

test("generateSessionTitle: strips quotes, prefix, trailing punctuation", async () => {
  const fake = mockFetch([
    {
      json: {
        content: [{ type: "text", text: "Title: \"Deploy to Cloudflare!\"" }],
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    }
  ]);
  try {
    const result = await generateSessionTitle({
      firstMessage: "how do I deploy?",
      keys: { anthropicApiKey: "sk-ant" },
      config: CFG
    });
    expect(result).toBeTruthy();
    expect(result!.title).toBe("Deploy to Cloudflare");
  } finally {
    fake.restore();
  }
});

test("generateSessionTitle: returns null on http error", async () => {
  const fake = mockFetch([{ ok: false, json: {} }]);
  try {
    const result = await generateSessionTitle({
      firstMessage: "hi",
      keys: { anthropicApiKey: "sk-ant" },
      config: CFG
    });
    expect(result).toBe(null);
  } finally {
    fake.restore();
  }
});

test("generateSessionTitle: returns null on empty message", async () => {
  const result = await generateSessionTitle({
    firstMessage: "   ",
    keys: { anthropicApiKey: "sk-ant" },
    config: CFG
  });
  expect(result).toBe(null);
});

test("generateSessionTitle: anthropic returns null when text block missing", async () => {
  const fake = mockFetch([
    { json: { content: [{ type: "tool_use" }], usage: {} } }
  ]);
  try {
    const result = await generateSessionTitle({
      firstMessage: "hi",
      keys: { anthropicApiKey: "sk-ant" },
      config: CFG
    });
    expect(result).toBe(null);
  } finally {
    fake.restore();
  }
});

test("generateSessionTitle: anthropic missing usage fields default to zeros", async () => {
  const fake = mockFetch([
    { json: { content: [{ type: "text", text: "Hello" }] } }
  ]);
  try {
    const result = await generateSessionTitle({
      firstMessage: "hi",
      keys: { anthropicApiKey: "sk-ant" },
      config: CFG
    });
    expect(result!.tokenUsage).toEqual({
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0
          });
  } finally {
    fake.restore();
  }
});

test("generateSessionTitle: anthropic returns null when sanitization yields empty title", async () => {
  const fake = mockFetch([
    { json: { content: [{ type: "text", text: "''''" }], usage: {} } }
  ]);
  try {
    const result = await generateSessionTitle({
      firstMessage: "hi",
      keys: { anthropicApiKey: "sk-ant" },
      config: CFG
    });
    expect(result).toBe(null);
  } finally {
    fake.restore();
  }
});

test("generateSessionTitle: anthropic returns null when fetch rejects", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    const result = await generateSessionTitle({
      firstMessage: "hi",
      keys: { anthropicApiKey: "sk-ant" },
      config: CFG
    });
    expect(result).toBe(null);
  } finally {
    globalThis.fetch = original;
  }
});







test("generateSessionTitle: caps title at 8 words", async () => {
  const fake = mockFetch([
    {
      json: {
        content: [{ type: "text", text: "one two three four five six seven eight nine ten" }],
        usage: {}
      }
    }
  ]);
  try {
    const result = await generateSessionTitle({
      firstMessage: "hi",
      keys: { anthropicApiKey: "sk-ant" },
      config: CFG
    });
    expect(result!.title).toBe("one two three four five six seven eight");
  } finally {
    fake.restore();
  }
});

test("generateSessionTitle: very long first message is truncated to 2000 chars in prompt", async () => {
  let observedUserContent = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    observedUserContent = body.messages.find((m: { role: string }) => m.role === "user").content;
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text: "Truncated Topic" }], usage: {} })
    } as Response;
  }) as typeof fetch;
  try {
    const result = await generateSessionTitle({
      firstMessage: "x".repeat(5_000),
      keys: { anthropicApiKey: "sk-ant" },
      config: CFG
    });
    expect(result!.title).toBe("Truncated Topic");
    expect(observedUserContent.startsWith("First message:\n\n")).toBeTruthy();
    const payload = observedUserContent.slice("First message:\n\n".length);
    expect(payload.length).toBe(2000);
  } finally {
    globalThis.fetch = original;
  }
});

// --- Local utility LLM (UTILITY_LLM_*) ----------------------------------------

test("generateSessionTitle: utility client wins without touching provider APIs or keys", async () => {
  const utilityFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      message: { content: '"Fibonacci Program Request."' },
      prompt_eval_count: 40,
      eval_count: 5
    })
  })) as unknown as typeof fetch;
  const client = new UtilityLlmClient({
    baseUrl: "http://10.0.0.1:11434",
    model: "gemma-local",
    timeoutMs: 2000,
    wireFormat: "ollama",
    disableThinking: true,
    fetch: utilityFetch
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("provider API must not be called when the utility client succeeds");
  }) as typeof fetch;
  try {
    const result = await generateSessionTitle({
      firstMessage: "write fibonacci",
      keys: {}, // no provider keys at all — local path must still title
      config: CFG,
      utilityClient: client
    });
    // sanitizeTitle applies to the local output too (quotes/period stripped).
    expect(result!.title).toBe("Fibonacci Program Request");
    expect(result!.modelName).toBe("gemma-local");
    expect(result!.tokenUsage.totalTokens).toBe(45);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateSessionTitle: falls back to provider API when utility client fails", async () => {
  const failingFetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
  const client = new UtilityLlmClient({
    baseUrl: "http://10.0.0.1:11434",
    model: "gemma-local",
    timeoutMs: 2000,
    wireFormat: "ollama",
    fetch: failingFetch
  });

  const fake = mockFetch([
    { json: { content: [{ type: "text", text: "Fallback Title" }], usage: {} } }
  ]);
  try {
    const result = await generateSessionTitle({
      firstMessage: "hello",
      keys: { anthropicApiKey: "sk-ant" },
      config: CFG,
      utilityClient: client
    });
    expect(result!.title).toBe("Fallback Title");
    expect(fake.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
  } finally {
    fake.restore();
  }
});
