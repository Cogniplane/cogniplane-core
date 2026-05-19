import { test, expect } from "vitest";

import {
  AnthropicBatchJudgeError,
  AnthropicBatchJudgeProvider
} from "./anthropic-batch-judge-provider.js";
import type { SkillJudgeInput } from "./skill-judge-types.js";

function buildInput(sessionId: string): SkillJudgeInput {
  return {
    tenantId: "t",
    sessionId,
    availableSkills: [{ skillId: "s1", skillName: "S", description: null }],
    transcript: [{ kind: "message", messageId: "m1", role: "user", content: "hi" }]
  };
}

function buildJsonlLine(sessionId: string, output: unknown, type = "succeeded"): string {
  return JSON.stringify({
    custom_id: sessionId,
    result: {
      type,
      message: {
        id: `msg_${sessionId}`,
        content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }]
      }
    }
  });
}

test("submit posts one batch with one custom_id per session and returns batchId + sessionIds", async () => {
  let captured: { url: string; body: unknown } | null = null;
  const fakeFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
    captured = { url, body: init?.body ? JSON.parse(String(init.body)) : null };
    return new Response(JSON.stringify({ id: "msgbatch_xyz", processing_status: "in_progress" }), {
      status: 200
    });
  }) as typeof fetch;

  const provider = new AnthropicBatchJudgeProvider({
    apiKey: "sk",
    model: "claude-haiku-4-5",
    fetcher: fakeFetch
  });

  const submission = await provider.submit([buildInput("a"), buildInput("b")]);
  expect(submission.mode).toBe("batch");
  if (submission.mode !== "batch") return;
  expect(submission.batchId).toBe("msgbatch_xyz");
  expect(submission.sessionIds).toEqual(["a", "b"]);

  const body = captured?.body as { requests: Array<{ custom_id: string }> };
  expect(body.requests.length).toBe(2);
  expect(body.requests[0]?.custom_id).toBe("a");
  expect(body.requests[1]?.custom_id).toBe("b");
  expect(captured?.url).toBe("https://api.anthropic.com/v1/messages/batches");
});

test("submit throws when the API returns non-2xx", async () => {
  const fakeFetch: typeof fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
  const provider = new AnthropicBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  await expect(() => provider.submit([buildInput("a")])).rejects.toThrow(AnthropicBatchJudgeError);
});

test("poll returns in_progress when processing_status is in_progress", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response(JSON.stringify({ id: "msgbatch_xyz", processing_status: "in_progress" }), {
      status: 200
    })) as typeof fetch;

  const provider = new AnthropicBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const result = await provider.poll("msgbatch_xyz", ["a"]);
  expect(result.status).toBe("in_progress");
});

test("poll returns completed with parsed per-session results", async () => {
  let callCount = 0;
  const fakeFetch: typeof fetch = (async (url: string) => {
    callCount += 1;
    if (callCount === 1) {
      // retrieve
      return new Response(
        JSON.stringify({
          id: "msgbatch_xyz",
          processing_status: "ended",
          results_url: "/v1/messages/batches/msgbatch_xyz/results"
        }),
        { status: 200 }
      );
    }
    // results
    expect(url).toMatch(/\/results$/);
    const body =
      buildJsonlLine("a", { skills: [{ skillId: "s1", invoked: true, confidence: 0.9, evidence: [] }] }) +
      "\n" +
      buildJsonlLine("b", { skills: [{ skillId: "s1", invoked: false, confidence: 0.1, evidence: [] }] }) +
      "\n";
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-jsonl" }
    });
  }) as typeof fetch;

  const provider = new AnthropicBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const result = await provider.poll("msgbatch_xyz", ["a", "b"]);
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  const a = result.results.get("a");
  const b = result.results.get("b");
  expect(a?.status).toBe("succeeded");
  expect(b?.status).toBe("succeeded");
});

test("poll returns failed for batch-level errors (errored result lines)", async () => {
  const fakeFetch: typeof fetch = (async (url: string) => {
    if (url.endsWith("/results")) {
      const errored = JSON.stringify({
        custom_id: "a",
        result: { type: "errored", error: { type: "rate_limit_error", message: "429" } }
      });
      return new Response(errored + "\n", { status: 200 });
    }
    return new Response(
      JSON.stringify({ id: "msgbatch_xyz", processing_status: "ended" }),
      { status: 200 }
    );
  }) as typeof fetch;

  const provider = new AnthropicBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const result = await provider.poll("msgbatch_xyz", ["a"]);
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  const a = result.results.get("a");
  expect(a?.status).toBe("failed");
});

test("poll fills in failure for sessions missing from results", async () => {
  const fakeFetch: typeof fetch = (async (url: string) => {
    if (url.endsWith("/results")) {
      const onlyA = buildJsonlLine("a", {
        skills: [{ skillId: "s1", invoked: true, confidence: 0.9, evidence: [] }]
      });
      return new Response(onlyA + "\n", { status: 200 });
    }
    return new Response(
      JSON.stringify({ id: "msgbatch_xyz", processing_status: "ended" }),
      { status: 200 }
    );
  }) as typeof fetch;

  const provider = new AnthropicBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const result = await provider.poll("msgbatch_xyz", ["a", "missing"]);
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(result.results.get("a")?.status).toBe("succeeded");
  expect(result.results.get("missing")?.status).toBe("failed");
});

test("poll returns failed status when retrieve endpoint returns non-2xx", async () => {
  const fakeFetch: typeof fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  const provider = new AnthropicBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const result = await provider.poll("msgbatch_missing", ["a"]);
  expect(result.status).toBe("failed");
});

test("submit throws on empty input array", async () => {
  const provider = new AnthropicBatchJudgeProvider({
    apiKey: "sk",
    model: "m",
    fetcher: (async () => new Response("{}", { status: 200 })) as typeof fetch
  });
  await expect(() => provider.submit([])).rejects.toThrow();
});
