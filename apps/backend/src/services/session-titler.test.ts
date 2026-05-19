import { test, expect } from "vitest";

import { generateSessionTitle } from "./session-titler.js";

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
  codexModel: "gpt-5.4-nano",
  timeoutMs: 2000
};

test("generateSessionTitle: claude-code uses Anthropic and maps usage", async () => {
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
      runtimeProvider: "claude-code",
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

test("generateSessionTitle: codex uses OpenAI chat completions", async () => {
  const fake = mockFetch([
    {
      json: {
        choices: [{ message: { content: "\"Fixing Postgres RLS Bug\"" } }],
        usage: {
          prompt_tokens: 60,
          completion_tokens: 9,
          prompt_tokens_details: { cached_tokens: 10 }
        }
      }
    }
  ]);
  try {
    const result = await generateSessionTitle({
      runtimeProvider: "codex",
      firstMessage: "My RLS policy on the messages table isn't blocking other tenants.",
      keys: { openaiApiKey: "sk-openai-test" },
      config: CFG
    });
    expect(result).toBeTruthy();
    expect(result!.title).toBe("Fixing Postgres RLS Bug");
    expect(result!.modelName).toBe("gpt-5.4-nano");
    expect(result!.tokenUsage.inputTokens).toBe(60);
    expect(result!.tokenUsage.cachedInputTokens).toBe(10);
    expect(result!.tokenUsage.outputTokens).toBe(9);
    expect(result!.tokenUsage.totalTokens).toBe(69);
    expect(fake.calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((fake.calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer sk-openai-test");
  } finally {
    fake.restore();
  }
});

test("generateSessionTitle: returns null when no key for provider", async () => {
  const claudeResult = await generateSessionTitle({
    runtimeProvider: "claude-code",
    firstMessage: "Hello",
    keys: { anthropicApiKey: null, openaiApiKey: "sk-openai" },
    config: CFG
  });
  expect(claudeResult).toBe(null);

  const codexResult = await generateSessionTitle({
    runtimeProvider: "codex",
    firstMessage: "Hello",
    keys: { anthropicApiKey: "sk-ant", openaiApiKey: null },
    config: CFG
  });
  expect(codexResult).toBe(null);
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
      runtimeProvider: "claude-code",
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
      runtimeProvider: "claude-code",
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
    runtimeProvider: "claude-code",
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
      runtimeProvider: "claude-code",
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
      runtimeProvider: "claude-code",
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
      runtimeProvider: "claude-code",
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
      runtimeProvider: "claude-code",
      firstMessage: "hi",
      keys: { anthropicApiKey: "sk-ant" },
      config: CFG
    });
    expect(result).toBe(null);
  } finally {
    globalThis.fetch = original;
  }
});

test("generateSessionTitle: openai non-2xx returns null", async () => {
  const fake = mockFetch([{ ok: false, json: {} }]);
  try {
    const result = await generateSessionTitle({
      runtimeProvider: "codex",
      firstMessage: "hi",
      keys: { openaiApiKey: "k" },
      config: CFG
    });
    expect(result).toBe(null);
  } finally {
    fake.restore();
  }
});

test("generateSessionTitle: openai missing choices returns null", async () => {
  const fake = mockFetch([{ json: { choices: [] } }]);
  try {
    const result = await generateSessionTitle({
      runtimeProvider: "codex",
      firstMessage: "hi",
      keys: { openaiApiKey: "k" },
      config: CFG
    });
    expect(result).toBe(null);
  } finally {
    fake.restore();
  }
});

test("generateSessionTitle: openai returns null when fetch rejects", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("boom");
  }) as typeof fetch;
  try {
    const result = await generateSessionTitle({
      runtimeProvider: "codex",
      firstMessage: "hi",
      keys: { openaiApiKey: "k" },
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
        choices: [{ message: { content: "one two three four five six seven eight nine ten" } }]
      }
    }
  ]);
  try {
    const result = await generateSessionTitle({
      runtimeProvider: "codex",
      firstMessage: "hi",
      keys: { openaiApiKey: "k" },
      config: CFG
    });
    expect(result!.title).toBe("one two three four five six seven eight");
  } finally {
    fake.restore();
  }
});

test("generateSessionTitle: very long first message is truncated to 2000 chars in prompt", async () => {
  let observedUserContent = "";
  const fake = mockFetch([{ json: { choices: [{ message: { content: "Truncated Topic" } }] } }]);
  // The mockFetch helper does not expose init body in calls; but we can
  // capture via a separate stub. Restore original after.
  fake.restore();
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    observedUserContent = body.messages.find((m: { role: string }) => m.role === "user").content;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Truncated Topic" } }] })
    } as Response;
  }) as typeof fetch;
  try {
    const result = await generateSessionTitle({
      runtimeProvider: "codex",
      firstMessage: "x".repeat(5_000),
      keys: { openaiApiKey: "k" },
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
