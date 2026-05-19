import { test, expect } from "vitest";

import {
  AnthropicJudgeError,
  AnthropicSyncJudgeProvider
} from "./anthropic-sync-judge-provider.js";
import type { SkillJudgeInput } from "./skill-judge-types.js";

function buildInput(overrides: Partial<SkillJudgeInput> = {}): SkillJudgeInput {
  return {
    tenantId: "tenant-1",
    sessionId: "sess-1",
    availableSkills: [
      { skillId: "s1", skillName: "Skill One", description: null }
    ],
    transcript: [
      { kind: "message", messageId: "m1", role: "user", content: "hello" }
    ],
    ...overrides
  };
}

test("provider sends the prompt and returns a parsed sync result keyed by sessionId", async () => {
  let capturedRequest: { url: string; body: unknown; headers: Record<string, string> } | null = null;

  const fakeFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
    capturedRequest = {
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers as Record<string, string>
    };
    const responseBody = {
      id: "msg_abc",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            skills: [
              { skillId: "s1", invoked: true, confidence: 0.7, evidence: [] }
            ]
          })
        }
      ]
    };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const provider = new AnthropicSyncJudgeProvider({
    apiKey: "sk-fake",
    model: "claude-haiku-4-5",
    fetcher: fakeFetch
  });

  const submission = await provider.submit([buildInput()]);
  expect(submission.mode).toBe("sync");
  if (submission.mode !== "sync") return;

  const result = submission.results.get("sess-1");
  expect(result).toBeTruthy();
  expect(result?.status).toBe("succeeded");
  if (result?.status !== "succeeded") return;
  expect(result.output.skills[0]?.skillId).toBe("s1");
  expect(result.output.skills[0]?.invoked).toBe(true);
  expect(result.rawRequestId).toBe("msg_abc");

  expect(capturedRequest?.url).toBe("https://api.anthropic.com/v1/messages");
  expect(capturedRequest?.headers?.["x-api-key"]).toBe("sk-fake");
  expect(capturedRequest?.headers?.["anthropic-version"]).toBe("2023-06-01");
});

test("provider records per-session failure on non-2xx without aborting siblings", async () => {
  // First call → 429, second call → success. Verifies the bulk loop keeps
  // going after a per-input error.
  let callCount = 0;
  const fakeFetch: typeof fetch = (async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response(
      JSON.stringify({
        id: "msg_ok",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              skills: [{ skillId: "s1", invoked: true, confidence: 0.5, evidence: [] }]
            })
          }
        ]
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const provider = new AnthropicSyncJudgeProvider({
    apiKey: "sk",
    model: "m",
    fetcher: fakeFetch
  });

  const submission = await provider.submit([
    buildInput({ sessionId: "sess-fail" }),
    buildInput({ sessionId: "sess-ok" })
  ]);
  expect(submission.mode).toBe("sync");
  if (submission.mode !== "sync") return;

  const failed = submission.results.get("sess-fail");
  const ok = submission.results.get("sess-ok");
  expect(failed?.status).toBe("failed");
  expect(ok?.status).toBe("succeeded");
});

test("provider records per-session failure when response has no text content", async () => {
  const fakeFetch: typeof fetch = (async () => {
    return new Response(JSON.stringify({ id: "msg_x", content: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const provider = new AnthropicSyncJudgeProvider({
    apiKey: "sk",
    model: "m",
    fetcher: fakeFetch
  });

  const submission = await provider.submit([buildInput()]);
  expect(submission.mode).toBe("sync");
  if (submission.mode !== "sync") return;
  const result = submission.results.get("sess-1");
  expect(result?.status).toBe("failed");
});

test("constructor rejects empty apiKey or model", () => {
  expect(() => new AnthropicSyncJudgeProvider({ apiKey: "", model: "m" })).toThrow();
  expect(() => new AnthropicSyncJudgeProvider({ apiKey: "k", model: "" })).toThrow();
});

// AnthropicJudgeError is still surfaced for instanceof — verify the export
test("AnthropicJudgeError is exported and usable", () => {
  const err = new AnthropicJudgeError("msg", 500, "body");
  expect(err instanceof Error).toBeTruthy();
  expect(err.status).toBe(500);
});
