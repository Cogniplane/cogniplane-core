import { test, expect, onTestFinished } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/client";

import { PiiProtectionServiceError } from "../services/pii/pii-protection-service.js";
import { createTestApp } from "../test-helpers/routes-test-support.js";

function parseAguiEvents(payload: string): BaseEvent[] {
  return payload
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data: ".length)) as BaseEvent);
}

type CreatedSession = { sessionId: string };

async function createSessionFor(
  app: Awaited<ReturnType<typeof createTestApp>>["app"],
  userId = "platform-user"
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { "x-user-id": userId },
    payload: { name: "pii-test" }
  });
  const body = response.json() as { session: CreatedSession };
  return body.session.sessionId;
}

test("POST /messages in block mode persists a system message and does not dispatch to the runtime", async () => {
  const scanCreateInputs: Array<Record<string, unknown>> = [];
  const { app, messages, runtimeManager } = await createTestApp({
    pii: {
      piiProtection: {
        async evaluateText() {
          return {
            action: "block",
            findings: [{ entityType: "email", value: "a@b.com", start: 0, end: 7, confidence: "high" }],
            blockReason: "email",
            providerType: "openai-compatible",
            providerModel: "google/gemini-2.5-flash"
          };
        }
      },
      piiScanRuns: {
        async create(input: unknown) {
          scanCreateInputs.push(input as Record<string, unknown>);
          return { scanRunId: "scan-blk-1" };
        }
      }
    }
  });
  onTestFinished(async () => { await app.close(); });

  const sessionId = await createSessionFor(app);

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    headers: { "x-user-id": "platform-user" },
    payload: { sessionId, text: "my email is user@example.com" }
  });

  expect(response.statusCode).toBe(200);
  const events = parseAguiEvents(response.payload);
  const blockedEvent = events.find((event) => event.type === EventType.TEXT_MESSAGE_CONTENT);
  expect(blockedEvent).toMatchObject({ delta: "Message blocked by organization policy." });
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);

  expect(runtimeManager.runMessageInputs.length).toBe(0);
  expect(scanCreateInputs.length).toBe(1);
  expect((scanCreateInputs[0] as { mode: string }).mode).toBe("block");

  const { messages: persisted } = await messages.listBySession("test-tenant", sessionId, "platform-user");
  expect(persisted.length).toBe(1);
  const systemMessage = persisted[0];
  expect(systemMessage.role).toBe("system");
  expect(systemMessage.content).toBe("Message blocked by organization policy.");
  const pii = systemMessage.detail.pii as Record<string, unknown>;
  expect(pii.status).toBe("blocked");
  expect(pii.blockReason).toBe("email");
  expect(pii.scanRunId).toBe("scan-blk-1");
  // The raw user prompt must NOT be persisted as a user message.
  expect(!persisted.some((message) => message.role === "user")).toBeTruthy();
});

test("POST /messages?format=agui in block mode emits AG-UI BaseEvents the client can parse", async () => {
  const { app, messages, runtimeManager } = await createTestApp({
    pii: {
      piiProtection: {
        async evaluateText() {
          return {
            action: "block",
            findings: [{ entityType: "email", value: "a@b.com", start: 0, end: 7, confidence: "high" }],
            blockReason: "email",
            providerType: "openai-compatible",
            providerModel: "google/gemini-2.5-flash"
          };
        }
      },
      piiScanRuns: {
        async create() {
          return { scanRunId: "scan-blk-agui" };
        }
      }
    }
  });
  onTestFinished(async () => { await app.close(); });

  const sessionId = await createSessionFor(app);

  const response = await app.inject({
    method: "POST",
    url: "/messages?format=agui",
    headers: { "x-user-id": "platform-user" },
    payload: { sessionId, text: "my email is user@example.com" }
  });

  expect(response.statusCode).toBe(200);

  // AG-UI uses data-only SSE frames. Parse each payload and assert its `type`.
  const frames = response.payload
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      return dataLine ? (JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>) : null;
    })
    .filter((f): f is Record<string, unknown> => f !== null);

  const types = frames.map((f) => f.type);
  // A valid, minimal AG-UI run the CopilotKit HttpAgent's EventSchemas.parse accepts.
  expect(types).toEqual([
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED"
  ]);
  // The block copy rides the text message so it renders live.
  const content = frames.find((f) => f.type === "TEXT_MESSAGE_CONTENT");
  expect(content?.delta).toBe("Message blocked by organization policy.");
  // threadId === sessionId (matches the AG-UI writer/driver contract).
  const started = frames.find((f) => f.type === "RUN_STARTED");
  expect(started?.threadId).toBe(sessionId);
  // The block still short-circuits the runtime and persists the system message.
  expect(runtimeManager.runMessageInputs.length).toBe(0);
  const { messages: persisted } = await messages.listBySession("test-tenant", sessionId, "platform-user");
  expect(persisted.some((m) => m.role === "system")).toBe(true);
  expect(persisted.some((m) => m.role === "user")).toBe(false);
});

test("POST /messages in transform mode emits user_message_replaced and sends transformed prompt to runtime", async () => {
  const { app, messages, runtimeManager } = await createTestApp({
    pii: {
      piiProtection: {
        async evaluateText() {
          return {
            action: "transform",
            transformedText: "my email is [REDACTED:email]",
            findings: [{ entityType: "email", value: "user@example.com", start: 0, end: 16, confidence: "high" }],
            providerType: "openai-compatible",
            providerModel: "google/gemini-2.5-flash"
          };
        }
      },
      piiScanRuns: {
        async create() {
          return { scanRunId: "scan-tfx-1" };
        }
      }
    }
  });
  onTestFinished(async () => { await app.close(); });

  const sessionId = await createSessionFor(app);
  runtimeManager.queueEvents(sessionId, [
    { type: "response.created", responseId: "resp-1" },
    {
      type: "response.completed",
      responseId: "resp-1",
      status: "completed",
      tokenUsage: undefined,
      costUsd: undefined,
      modelName: "gpt-5.2"
    }
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    headers: { "x-user-id": "platform-user" },
    payload: { sessionId, text: "my email is user@example.com" }
  });

  expect(response.statusCode).toBe(200);
  const events = parseAguiEvents(response.payload);
  const replacement = events.find(
    (event) => event.type === EventType.CUSTOM && event.name === "user_message_replaced"
  ) as BaseEvent & { value: { messageId: string; text: string; scanRunId: string } };
  expect(replacement.value.text).toBe("my email is [REDACTED:email]");
  expect(replacement.value.scanRunId).toBe("scan-tfx-1");
  expect(replacement.value.messageId.length).toBeGreaterThan(0);

  // Runtime must see the transformed prompt, not the raw one.
  expect(runtimeManager.runMessageInputs.length).toBe(1);
  expect(runtimeManager.runMessageInputs[0].prompt).toBe("my email is [REDACTED:email]");

  const { messages: persisted } = await messages.listBySession("test-tenant", sessionId, "platform-user");
  const userMessage = persisted.find((message) => message.role === "user");
  expect(userMessage).toBeTruthy();
  expect(userMessage?.content).toBe("my email is [REDACTED:email]");
  const pii = userMessage?.detail.pii as Record<string, unknown>;
  expect(pii.status).toBe("transformed");
  expect(pii.modeApplied).toBe("transform");
  expect(pii.scanRunId).toBe("scan-tfx-1");
  expect(pii.findingsCount).toBe(1);
});

test("POST /messages in detect mode persists raw user message with report metadata", async () => {
  const { app, messages, runtimeManager } = await createTestApp({
    pii: {
      piiProtection: {
        async evaluateText() {
          return {
            action: "report",
            findings: [{ entityType: "email", value: "user@example.com", start: 0, end: 16, confidence: "high" }],
            providerType: "openai-compatible",
            providerModel: "google/gemini-2.5-flash"
          };
        }
      },
      piiScanRuns: {
        async create() {
          return { scanRunId: "scan-det-1" };
        }
      }
    }
  });
  onTestFinished(async () => { await app.close(); });

  const sessionId = await createSessionFor(app);
  runtimeManager.queueEvents(sessionId, [
    { type: "response.created", responseId: "resp-1" },
    {
      type: "response.completed",
      responseId: "resp-1",
      status: "completed",
      tokenUsage: undefined,
      costUsd: undefined,
      modelName: "gpt-5.2"
    }
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    headers: { "x-user-id": "platform-user" },
    payload: { sessionId, text: "my email is user@example.com" }
  });

  expect(response.statusCode).toBe(200);
  // detect mode is non-blocking; the runtime must have received the raw prompt.
  expect(runtimeManager.runMessageInputs[0]?.prompt).toBe("my email is user@example.com");

  const { messages: persisted } = await messages.listBySession("test-tenant", sessionId, "platform-user");
  const userMessage = persisted.find((message) => message.role === "user");
  expect(userMessage).toBeTruthy();
  expect(userMessage?.content).toBe("my email is user@example.com");
  const pii = userMessage?.detail.pii as Record<string, unknown>;
  expect(pii.status).toBe("detected");
  expect(pii.modeApplied).toBe("detect");
  expect(pii.scanRunId).toBe("scan-det-1");
  expect(pii.findingsCount).toBe(1);
});

test("POST /messages returns HTTP 503 pii_provider_unavailable when provider fails, and persists nothing", async () => {
  const { app, messages, runtimeManager } = await createTestApp({
    pii: {
      piiProtection: {
        async evaluateText() {
          throw new PiiProtectionServiceError(
            "pii_provider_unavailable",
            "provider timed out"
          );
        }
      },
      piiScanRuns: {
        async create() {
          throw new Error("should not be called when provider fails");
        }
      }
    }
  });
  onTestFinished(async () => { await app.close(); });

  const sessionId = await createSessionFor(app);

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    headers: { "x-user-id": "platform-user" },
    payload: { sessionId, text: "my email is user@example.com" }
  });

  expect(response.statusCode).toBe(503);
  const body = response.json() as Record<string, unknown>;
  expect(body.error).toBe("pii_provider_unavailable");

  expect(runtimeManager.runMessageInputs.length).toBe(0);
  const { messages: persisted } = await messages.listBySession("test-tenant", sessionId, "platform-user");
  expect(persisted.length).toBe(0);
});

test("POST /messages consumes a rate-limit token but never turn quota when PII provider fails", async () => {
  const { app, limits } = await createTestApp({
    pii: {
      piiProtection: {
        async evaluateText() {
          throw new PiiProtectionServiceError("pii_provider_unavailable", "provider timed out");
        }
      },
      piiScanRuns: {
        async create() {
          throw new Error("should not be called");
        }
      }
    }
  });
  onTestFinished(async () => { await app.close(); });

  const sessionId = await createSessionFor(app);

  // Install spies AFTER session creation so we only observe what the
  // /messages route does — session creation also consumes a rate limit of
  // its own on the "session_create" resource.
  let messageRateLimitCalls = 0;
  let turnQuotaCalls = 0;
  const originalRateLimit = limits.consumeRateLimit.bind(limits);
  const originalTurnQuota = limits.consumeTurnQuota.bind(limits);
  limits.consumeRateLimit = async (input) => {
    if (input.resource === "message_turn") messageRateLimitCalls += 1;
    return originalRateLimit(input);
  };
  limits.consumeTurnQuota = async (input) => {
    turnQuotaCalls += 1;
    return originalTurnQuota(input);
  };

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    headers: { "x-user-id": "platform-user" },
    payload: { sessionId, text: "my email is user@example.com" }
  });

  expect(response.statusCode).toBe(503);
  // The rate limit gates the PII provider call itself (an LLM inference), so
  // a token is spent before evaluation. The daily turn quota is only spent on
  // turns that pass the PII gate — never on a fail-closed 503.
  expect(messageRateLimitCalls).toBe(1);
  expect(turnQuotaCalls).toBe(0);
});

test("POST /messages consumes a rate-limit token but no turn quota for a PII-blocked turn", async () => {
  const { app, limits } = await createTestApp({
    pii: {
      piiProtection: {
        async evaluateText() {
          return {
            action: "block",
            findings: [{ entityType: "email", value: "a@b.com", start: 0, end: 7, confidence: "high" }],
            blockReason: "email",
            providerType: "openai-compatible",
            providerModel: "google/gemini-2.5-flash"
          };
        }
      },
      piiScanRuns: {
        async create() {
          return { scanRunId: "scan-blk-2" };
        }
      }
    }
  });
  onTestFinished(async () => { await app.close(); });

  const sessionId = await createSessionFor(app);

  let messageRateLimitCalls = 0;
  let turnQuotaCalls = 0;
  const originalRateLimit = limits.consumeRateLimit.bind(limits);
  const originalTurnQuota = limits.consumeTurnQuota.bind(limits);
  limits.consumeRateLimit = async (input) => {
    if (input.resource === "message_turn") messageRateLimitCalls += 1;
    return originalRateLimit(input);
  };
  limits.consumeTurnQuota = async (input) => {
    turnQuotaCalls += 1;
    return originalTurnQuota(input);
  };

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    headers: { "x-user-id": "platform-user" },
    payload: { sessionId, text: "my email is user@example.com" }
  });

  expect(response.statusCode).toBe(200);
  const events = parseAguiEvents(response.payload);
  expect(
    events.some(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT &&
        event.delta === "Message blocked by organization policy."
    )
  ).toBe(true);
  // Probing the PII filter costs a rate-limit token per attempt, but a
  // blocked turn was never dispatched and must not spend daily quota.
  expect(messageRateLimitCalls).toBe(1);
  expect(turnQuotaCalls).toBe(0);
});

test("POST /messages does not call the PII provider when the rate limit is exhausted", async () => {
  let evaluateCalls = 0;
  const { app, limits } = await createTestApp({
    pii: {
      piiProtection: {
        async evaluateText() {
          evaluateCalls += 1;
          return {
            action: "allow",
            reason: "no_findings",
            findings: [],
            providerType: "openai-compatible",
            providerModel: "google/gemini-2.5-flash"
          };
        }
      },
      piiScanRuns: {
        async create() {
          throw new Error("should not be called");
        }
      }
    }
  });
  onTestFinished(async () => { await app.close(); });

  const sessionId = await createSessionFor(app);

  limits.consumeRateLimit = async (input) =>
    input.resource === "message_turn"
      ? {
          error: "limit_exceeded",
          limitType: "rate_limit",
          resource: "message_turn",
          scope: "user",
          limit: 1,
          retryAfterMs: 1000,
          resetAt: new Date(Date.now() + 1000).toISOString(),
          message: "Too many requests."
        }
      : null;

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    headers: { "x-user-id": "platform-user" },
    payload: { sessionId, text: "my email is user@example.com" }
  });

  expect(response.statusCode).toBe(429);
  // An over-limit user must not be able to trigger PII-provider inference.
  expect(evaluateCalls).toBe(0);
});
