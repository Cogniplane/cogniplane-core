import { test, expect, onTestFinished } from "vitest";

import { PiiProtectionServiceError } from "../services/pii/pii-protection-service.js";
import { createTestApp, parseSseEvents } from "../test-helpers/routes-test-support.js";

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
            providerType: "openrouter",
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
  const events = parseSseEvents(response.payload);
  const blockedEvent = events.find((entry) => entry.event === "framework:message_blocked");
  expect(blockedEvent).toBeTruthy();
  expect(blockedEvent?.data.reason).toBe("pii_block");
  expect(blockedEvent?.data.block_reason).toBe("email");
  expect(blockedEvent?.data.scan_run_id).toBe("scan-blk-1");
  expect(blockedEvent?.data.message).toBe("Message blocked by organization policy.");
  const terminal = events.find((entry) => entry.event === "response.completed");
  expect(terminal).toBeTruthy();
  expect((terminal?.data.response as Record<string, unknown>).status).toBe("blocked");

  expect(runtimeManager.runMessageInputs.length).toBe(0);
  expect(scanCreateInputs.length).toBe(1);
  expect((scanCreateInputs[0] as { mode: string }).mode).toBe("block");

  const persisted = await messages.listBySession("test-tenant", sessionId, "platform-user");
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

test("POST /messages in transform mode emits runtime.user_message_replaced and sends transformed prompt to runtime", async () => {
  const { app, messages, runtimeManager } = await createTestApp({
    pii: {
      piiProtection: {
        async evaluateText() {
          return {
            action: "transform",
            transformedText: "my email is [REDACTED:email]",
            findings: [{ entityType: "email", value: "user@example.com", start: 0, end: 16, confidence: "high" }],
            providerType: "openrouter",
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
  const events = parseSseEvents(response.payload);
  expect(events[0].event).toBe("runtime.user_message_replaced");
  expect(events[0].data.text).toBe("my email is [REDACTED:email]");
  expect(events[0].data.scan_run_id).toBe("scan-tfx-1");
  expect(typeof events[0].data.message_id === "string" && (events[0].data.message_id as string).length > 0).toBeTruthy();

  // Runtime must see the transformed prompt, not the raw one.
  expect(runtimeManager.runMessageInputs.length).toBe(1);
  expect(runtimeManager.runMessageInputs[0].prompt).toBe("my email is [REDACTED:email]");

  const persisted = await messages.listBySession("test-tenant", sessionId, "platform-user");
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
            providerType: "openrouter",
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

  const persisted = await messages.listBySession("test-tenant", sessionId, "platform-user");
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
  const persisted = await messages.listBySession("test-tenant", sessionId, "platform-user");
  expect(persisted.length).toBe(0);
});

test("POST /messages does not consume rate limit or turn quota when PII provider fails", async () => {
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
  expect(messageRateLimitCalls).toBe(0);
  expect(turnQuotaCalls).toBe(0);
});
