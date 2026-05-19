import { test, expect } from "vitest";

import {
  OpenRouterPiiProvider,
  OpenRouterPiiProviderError
} from "./openrouter-pii-provider.js";
import { InMemoryPiiCircuitBreaker } from "./pii-circuit-breaker.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function buildFakeFetch(options: {
  responsePayload?: unknown;
  status?: number;
  responseBodyText?: string;
  capture?: CapturedRequest[];
  delayMs?: number;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const capture = options.capture;
    if (capture) {
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      capture.push({
        url,
        method: init?.method ?? "GET",
        headers: rawHeaders,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
      });
    }

    if (options.delayMs && options.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, options.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }

    const body =
      options.responseBodyText ??
      JSON.stringify(
        options.responsePayload ?? {
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }]
        }
      );
    return new Response(body, {
      status: options.status ?? 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
}

function buildProvider(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof OpenRouterPiiProvider>[0]> = {}) {
  return new OpenRouterPiiProvider({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-test",
    model: "google/gemini-2.5-flash",
    timeoutMs: 5000,
    fetch: fetchImpl,
    ...overrides
  });
}

test("detectText returns normalized findings from OpenRouter JSON response", async () => {
  const capture: CapturedRequest[] = [];
  const fetchImpl = buildFakeFetch({
    capture,
    responsePayload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                { entityType: "email", value: "a@b.co", start: 12, end: 18, confidence: "high" }
              ]
            })
          }
        }
      ]
    }
  });

  const provider = buildProvider(fetchImpl);
  const result = await provider.detectText({
    text: "contact me: a@b.co",
    entityTypes: ["email", "phone"]
  });

  expect(result.providerType).toBe("openrouter");
  expect(result.providerModel).toBe("google/gemini-2.5-flash");
  expect(result.findings.length).toBe(1);
  expect(result.findings[0]?.entityType).toBe("email");
  expect(result.findings[0]?.start).toBe(12);
  expect(result.findings[0]?.end).toBe(18);

  const request = capture[0];
  expect(request).toBeTruthy();
  expect(request.method).toBe("POST");
  expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(request.headers.Authorization).toBe("Bearer sk-or-test");
  const body = request.body as { model: string; response_format: { type: string } };
  expect(body.model).toBe("google/gemini-2.5-flash");
  expect(body.response_format.type).toBe("json_object");
});

test("detectText honors per-call model override in both request body and result", async () => {
  const capture: CapturedRequest[] = [];
  const fetchImpl = buildFakeFetch({
    capture,
    responsePayload: {
      choices: [{ message: { content: JSON.stringify({ findings: [] }) } }]
    }
  });

  const provider = buildProvider(fetchImpl);
  const result = await provider.detectText({
    text: "hi",
    entityTypes: ["email"],
    model: "tenant/custom-model"
  });

  const body = capture[0]?.body as { model: string };
  expect(body.model).toBe("tenant/custom-model");
  expect(result.providerModel).toBe("tenant/custom-model");
});

test("detectText drops findings with unknown entityType", async () => {
  const fetchImpl = buildFakeFetch({
    responsePayload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                { entityType: "ssn", value: "123-45-6789", start: 0, end: 11, confidence: "high" },
                { entityType: "email", value: "a@b.co", start: 0, end: 6, confidence: "medium" }
              ]
            })
          }
        }
      ]
    }
  });

  const provider = buildProvider(fetchImpl);
  const result = await provider.detectText({ text: "a@b.co", entityTypes: ["email"] });
  expect(result.findings.length).toBe(1);
  expect(result.findings[0]?.entityType).toBe("email");
});

test("detectText drops findings whose entityType is not in the allowed list", async () => {
  const fetchImpl = buildFakeFetch({
    responsePayload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                { entityType: "phone", value: "555-1212", start: 0, end: 8, confidence: "high" }
              ]
            })
          }
        }
      ]
    }
  });

  const provider = buildProvider(fetchImpl);
  const result = await provider.detectText({ text: "555-1212", entityTypes: ["email"] });
  expect(result.findings.length).toBe(0);
});

test("detectText drops findings whose value cannot be anchored in the source text", async () => {
  const fetchImpl = buildFakeFetch({
    responsePayload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                // Normalized phone the model returned with bad offsets; doesn't match source verbatim.
                { entityType: "phone", value: "+14155552671", start: -1, end: -1, confidence: "high" },
                { entityType: "email", value: "a@b.co", start: -1, end: -1, confidence: "high" }
              ]
            })
          }
        }
      ]
    }
  });

  const provider = buildProvider(fetchImpl);
  const result = await provider.detectText({
    text: "call (415) 555-2671 or email a@b.co",
    entityTypes: ["phone", "email"]
  });

  // Phone finding is dropped (unanchorable); email is kept via indexOf fallback.
  expect(result.findings.length).toBe(1);
  expect(result.findings[0]?.entityType).toBe("email");
  expect(result.findings[0]?.value).toBe("a@b.co");
});

test("detectText rejects offsets whose slice does not match the claimed value", async () => {
  const fetchImpl = buildFakeFetch({
    responsePayload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                // Offsets 0..6 slice "hello " — not the claimed "a@b.co". Fallback indexOf also fails.
                { entityType: "email", value: "a@b.co", start: 0, end: 6, confidence: "high" }
              ]
            })
          }
        }
      ]
    }
  });

  const provider = buildProvider(fetchImpl);
  const result = await provider.detectText({ text: "hello world", entityTypes: ["email"] });
  expect(result.findings.length).toBe(0);
});

test("transformText returns transformed content and findings", async () => {
  const fetchImpl = buildFakeFetch({
    responsePayload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              transformedText: "contact me: [REDACTED:email]",
              findings: [
                { entityType: "email", value: "a@b.co", start: 12, end: 18, confidence: "high" }
              ]
            })
          }
        }
      ]
    }
  });

  const provider = buildProvider(fetchImpl);
  const result = await provider.transformText({
    text: "contact me: a@b.co",
    entityTypes: ["email"]
  });

  expect(result.transformedText).toBe("contact me: [REDACTED:email]");
  expect(result.findings.length).toBe(1);
});

test("transformText falls back to original input text when transformedText is missing", async () => {
  const fetchImpl = buildFakeFetch({
    responsePayload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              // no transformedText returned
              findings: []
            })
          }
        }
      ]
    }
  });
  const provider = buildProvider(fetchImpl);
  const result = await provider.transformText({
    text: "leave me alone",
    entityTypes: ["email"]
  });
  expect(result.transformedText).toBe("leave me alone");
});

test("transformText honors per-call model override", async () => {
  const captured: CapturedRequest[] = [];
  const fetchImpl = buildFakeFetch({
    responsePayload: {
      choices: [{ message: { content: JSON.stringify({ transformedText: "x", findings: [] }) } }]
    },
    capture: captured
  });
  const provider = buildProvider(fetchImpl);
  const result = await provider.transformText({
    text: "y",
    entityTypes: ["email"],
    model: "custom-model"
  });
  expect(result.providerModel).toBe("custom-model");
  const body = captured[0].body as Record<string, unknown>;
  expect(body.model).toBe("custom-model");
});

test("scanArtifact reads content lazily and surfaces summary", async () => {
  const fetchImpl = buildFakeFetch({
    responsePayload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                { entityType: "email", value: "a@b.co", start: 0, end: 6, confidence: "high" }
              ],
              summary: "Found one email address."
            })
          }
        }
      ]
    }
  });

  let reads = 0;
  const provider = buildProvider(fetchImpl);
  const result = await provider.scanArtifact({
    artifactId: "art_1",
    contentType: "text/plain",
    readContent: async () => {
      reads += 1;
      return "a@b.co";
    },
    entityTypes: ["email"]
  });

  expect(reads).toBe(1);
  expect(result.summaryText).toBe("Found one email address.");
  expect(result.findings.length).toBe(1);
});

test("callChat throws timeout error when provider exceeds the budget", async () => {
  const fetchImpl = buildFakeFetch({ delayMs: 200 });
  const provider = buildProvider(fetchImpl, { timeoutMs: 25 });

  const error = await provider.detectText({ text: "hi", entityTypes: ["email"] }).catch((e: unknown) => e);
  expect(error instanceof OpenRouterPiiProviderError).toBeTruthy();
  expect((error as OpenRouterPiiProviderError).code).toBe("timeout");
});

test("callChat surfaces HTTP errors with a bounded message", async () => {
  const fetchImpl = buildFakeFetch({
    status: 500,
    responseBodyText: "upstream exploded"
  });

  const provider = buildProvider(fetchImpl);
  const error = await provider.detectText({ text: "hi", entityTypes: ["email"] }).catch((e: unknown) => e);
  expect(error instanceof OpenRouterPiiProviderError).toBeTruthy();
  expect((error as OpenRouterPiiProviderError).code).toBe("http_error");
});

test("callChat throws invalid_json when model output is not parseable", async () => {
  const fetchImpl = buildFakeFetch({
    responsePayload: {
      choices: [{ message: { content: "not json at all" } }]
    }
  });

  const provider = buildProvider(fetchImpl);
  const error = await provider.detectText({ text: "hi", entityTypes: ["email"] }).catch((e: unknown) => e);
  expect(error instanceof OpenRouterPiiProviderError).toBeTruthy();
  expect((error as OpenRouterPiiProviderError).code).toBe("invalid_json");
});

test("callChat surfaces provider_error when payload contains an error object", async () => {
  const fetchImpl = buildFakeFetch({
    responsePayload: { error: { message: "out of credits", code: "insufficient_credits" } }
  });

  const provider = buildProvider(fetchImpl);
  const error = await provider.detectText({ text: "hi", entityTypes: ["email"] }).catch((e: unknown) => e);
  expect(error instanceof OpenRouterPiiProviderError).toBeTruthy();
  expect((error as OpenRouterPiiProviderError).code).toBe("provider_error");
});

test("breaker_open: provider rejects calls when the breaker disallows", async () => {
  const fetchImpl = buildFakeFetch({});
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 1,
    windowMs: 60_000,
    cooldownMs: 30_000
  });
  // Pre-trip the breaker.
  await breaker.record("failure");

  let fetchCalled = 0;
  const trackingFetch: typeof fetch = (input, init) => {
    fetchCalled += 1;
    return fetchImpl(input, init);
  };
  const provider = buildProvider(trackingFetch, { breaker });

  const error = await provider.detectText({ text: "hi", entityTypes: ["email"] }).catch((e: unknown) => e);
  expect(error instanceof OpenRouterPiiProviderError).toBeTruthy();
  expect((error as OpenRouterPiiProviderError).code).toBe("breaker_open");
  // Critical assertion: fetch was never called. Breaker saved the round trip.
  expect(fetchCalled).toBe(0);
});

test("breaker records failures from real provider errors", async () => {
  const fetchImpl = buildFakeFetch({ status: 500, responseBodyText: "boom" });
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 2,
    windowMs: 60_000,
    cooldownMs: 30_000
  });
  const provider = buildProvider(fetchImpl, { breaker });

  await expect(() => provider.detectText({ text: "hi", entityTypes: ["email"] })).rejects.toThrow();
  await expect(() => provider.detectText({ text: "hi", entityTypes: ["email"] })).rejects.toThrow();

  // After 2 http_error failures the breaker is open.
  const snap = await breaker.snapshot();
  expect(snap.state).toBe("open");
});

test("breaker records success and resets the failure count", async () => {
  const breaker = new InMemoryPiiCircuitBreaker({
    name: "test",
    failureThreshold: 3,
    windowMs: 60_000,
    cooldownMs: 30_000
  });
  // 2 http_error + 1 success (status 200 with empty findings).
  let callCount = 0;
  const flakyFetch: typeof fetch = async (input, init) => {
    callCount += 1;
    if (callCount <= 2) {
      return new Response("boom", { status: 500 });
    }
    return buildFakeFetch({})(input, init);
  };
  const provider = buildProvider(flakyFetch, { breaker });

  await expect(() => provider.detectText({ text: "hi", entityTypes: ["email"] })).rejects.toThrow();
  await expect(() => provider.detectText({ text: "hi", entityTypes: ["email"] })).rejects.toThrow();
  // Just-under-threshold and a success follows: breaker stays closed and the count resets.
  await provider.detectText({ text: "hi", entityTypes: ["email"] });
  const snap = await breaker.snapshot();
  expect(snap.state).toBe("closed");
  expect(snap.failureCount).toBe(0);
});

test("scanCsvPreview: sends preview as user content with CSV-aware system prompt", async () => {
  const capture: CapturedRequest[] = [];
  const fetchImpl = buildFakeFetch({
    capture,
    responsePayload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                { entityType: "person_name", value: "Alice", confidence: "high" }
              ],
              summary: "name column"
            })
          }
        }
      ]
    }
  });
  const provider = buildProvider(fetchImpl);

  const result = await provider.scanCsvPreview!({
    artifactId: "art-1",
    preview: "name,city\nAlice,Paris",
    entityTypes: ["person_name", "email"]
  });

  expect(result.findings.length).toBe(1);
  expect(result.findings[0]!.entityType).toBe("person_name");
  // Preview-derived findings have synthetic offsets.
  expect(result.findings[0]!.start).toBe(0);
  expect(result.findings[0]!.end).toBe(0);
  expect(result.summaryText).toBe("name column");

  // System prompt mentions CSV preview semantics.
  expect(capture.length).toBe(1);
  const body = capture[0]!.body as { messages: Array<{ role: string; content: string }> };
  const sysPrompt = body.messages.find((m) => m.role === "system")!.content;
  expect(sysPrompt).toMatch(/CSV preview/i);
  // User message contains the preview.
  const userMsg = body.messages.find((m) => m.role === "user")!.content;
  expect(userMsg).toMatch(/Alice,Paris/);
});

test("scanCsvPreview: drops findings with entity types not in the allowed list", async () => {
  const fetchImpl = buildFakeFetch({
    responsePayload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                { entityType: "email", value: "a@b.co", confidence: "high" },
                { entityType: "person_name", value: "Alice", confidence: "high" }
              ]
            })
          }
        }
      ]
    }
  });
  const provider = buildProvider(fetchImpl);

  // Only allow email; person_name should be filtered out.
  const result = await provider.scanCsvPreview!({
    artifactId: "art-1",
    preview: "name,email\nAlice,a@b.co",
    entityTypes: ["email"]
  });

  expect(result.findings.length).toBe(1);
  expect(result.findings[0]!.entityType).toBe("email");
});

test("scanCsvPreview: drops findings with unknown entity types", async () => {
  const fetchImpl = buildFakeFetch({
    responsePayload: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                { entityType: "passport_number", value: "X1234", confidence: "high" }
              ]
            })
          }
        }
      ]
    }
  });
  const provider = buildProvider(fetchImpl);

  const result = await provider.scanCsvPreview!({
    artifactId: "art-1",
    preview: "id\nX1234",
    entityTypes: ["email", "person_name", "phone", "address", "financial", "government_id"]
  });

  // passport_number isn't in PII_ENTITY_TYPES, so it's dropped.
  expect(result.findings.length).toBe(0);
});
