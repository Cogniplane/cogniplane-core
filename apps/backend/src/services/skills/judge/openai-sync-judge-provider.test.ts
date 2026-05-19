import { test, expect } from "vitest";

import {
  OpenAIJudgeError,
  OpenAISyncJudgeProvider
} from "./openai-sync-judge-provider.js";
import type { SkillJudgeInput } from "./skill-judge-types.js";

function buildInput(sessionId = "sess-1"): SkillJudgeInput {
  return {
    tenantId: "t",
    sessionId,
    availableSkills: [{ skillId: "s1", skillName: "S", description: null }],
    transcript: [{ kind: "message", messageId: "m1", role: "user", content: "hi" }]
  };
}

test("submit returns parsed sync result keyed by sessionId", async () => {
  let captured: { url: string; body: unknown; headers: Record<string, string> } | null = null;
  const fakeFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
    captured = {
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers as Record<string, string>
    };
    return new Response(
      JSON.stringify({
        id: "chatcmpl_abc",
        choices: [
          {
            message: {
              content: JSON.stringify({
                skills: [{ skillId: "s1", invoked: true, confidence: 0.9, evidence: [] }]
              })
            }
          }
        ]
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const provider = new OpenAISyncJudgeProvider({
    apiKey: "sk-fake",
    model: "gpt-5.4-mini",
    fetcher: fakeFetch
  });

  const submission = await provider.submit([buildInput()]);
  expect(submission.mode).toBe("sync");
  if (submission.mode !== "sync") return;
  const result = submission.results.get("sess-1");
  expect(result?.status).toBe("succeeded");
  if (result?.status !== "succeeded") return;
  expect(result.output.skills[0]?.invoked).toBe(true);
  expect(result.rawRequestId).toBe("chatcmpl_abc");

  expect(captured?.url).toBe("https://api.openai.com/v1/chat/completions");
  expect(captured?.headers?.authorization).toBe("Bearer sk-fake");
  const body = captured?.body as {
    model: string;
    response_format: { type: string };
    messages: Array<{ role: string }>;
  };
  expect(body.model).toBe("gpt-5.4-mini");
  expect(body.response_format?.type).toBe("json_object");
  expect(body.messages[0]?.role).toBe("system");
  expect(body.messages[1]?.role).toBe("user");
});

test("submit records per-session failure on non-2xx without aborting siblings", async () => {
  let callCount = 0;
  const fakeFetch: typeof fetch = (async () => {
    callCount += 1;
    if (callCount === 1) return new Response("rate limited", { status: 429 });
    return new Response(
      JSON.stringify({
        id: "chatcmpl_ok",
        choices: [
          {
            message: {
              content: JSON.stringify({
                skills: [{ skillId: "s1", invoked: false, confidence: 0.1, evidence: [] }]
              })
            }
          }
        ]
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const provider = new OpenAISyncJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const submission = await provider.submit([buildInput("a"), buildInput("b")]);
  if (submission.mode !== "sync") throw new Error("expected sync");
  expect(submission.results.get("a")?.status).toBe("failed");
  expect(submission.results.get("b")?.status).toBe("succeeded");
});

test("submit fails when message content is empty", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response(JSON.stringify({ id: "x", choices: [{ message: { content: "" } }] }), {
      status: 200
    })) as typeof fetch;

  const provider = new OpenAISyncJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const submission = await provider.submit([buildInput()]);
  if (submission.mode !== "sync") throw new Error("expected sync");
  const result = submission.results.get("sess-1");
  expect(result?.status).toBe("failed");
});

test("constructor rejects empty apiKey or model", () => {
  expect(() => new OpenAISyncJudgeProvider({ apiKey: "", model: "m" })).toThrow();
  expect(() => new OpenAISyncJudgeProvider({ apiKey: "k", model: "" })).toThrow();
});

test("OpenAIJudgeError carries status", () => {
  const err = new OpenAIJudgeError("x", 500);
  expect(err.status).toBe(500);
});
