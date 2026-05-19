import { test, expect } from "vitest";

import {
  OpenAIBatchJudgeError,
  OpenAIBatchJudgeProvider
} from "./openai-batch-judge-provider.js";
import type { SkillJudgeInput } from "./skill-judge-types.js";

function buildInput(sessionId: string): SkillJudgeInput {
  return {
    tenantId: "t",
    sessionId,
    availableSkills: [{ skillId: "s1", skillName: "S", description: null }],
    transcript: [{ kind: "message", messageId: "m1", role: "user", content: "hi" }]
  };
}

function buildOutputLine(sessionId: string, output: unknown, statusCode = 200): string {
  return JSON.stringify({
    custom_id: sessionId,
    response: {
      status_code: statusCode,
      body: {
        id: `chatcmpl_${sessionId}`,
        choices: [{ message: { content: JSON.stringify(output) } }]
      }
    }
  });
}

test("submit uploads JSONL, creates batch, returns batchId + sessionIds", async () => {
  let uploadCalled = false;
  let batchCreateCalled = false;
  let uploadedJsonl: string | null = null;
  let createPayload: { input_file_id: string; endpoint: string } | null = null;

  const fakeFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
    if (url === "https://api.openai.com/v1/files") {
      uploadCalled = true;
      // Read the form's file blob to verify content.
      const form = init?.body as FormData;
      const file = form.get("file");
      if (file instanceof Blob) {
        uploadedJsonl = await file.text();
      }
      return new Response(JSON.stringify({ id: "file_xyz" }), { status: 200 });
    }
    if (url === "https://api.openai.com/v1/batches") {
      batchCreateCalled = true;
      createPayload = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({ id: "batch_abc", status: "in_progress" }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  const provider = new OpenAIBatchJudgeProvider({
    apiKey: "sk",
    model: "gpt-5.4-mini",
    fetcher: fakeFetch
  });

  const submission = await provider.submit([buildInput("a"), buildInput("b")]);
  expect(submission.mode).toBe("batch");
  if (submission.mode !== "batch") return;
  expect(submission.batchId).toBe("batch_abc");
  expect(submission.sessionIds).toEqual(["a", "b"]);
  expect(uploadCalled).toBeTruthy();
  expect(batchCreateCalled).toBeTruthy();
  expect(createPayload?.input_file_id).toBe("file_xyz");
  expect(createPayload?.endpoint).toBe("/v1/chat/completions");

  expect(uploadedJsonl).toBeTruthy();
  const lines = uploadedJsonl!.trim().split("\n");
  expect(lines.length).toBe(2);
  const firstLine = JSON.parse(lines[0]!) as { custom_id: string; method: string; url: string };
  expect(firstLine.custom_id).toBe("a");
  expect(firstLine.method).toBe("POST");
  expect(firstLine.url).toBe("/v1/chat/completions");
});

test("submit throws when file upload returns non-2xx", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response("forbidden", { status: 403 })) as typeof fetch;

  const provider = new OpenAIBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  await expect(() => provider.submit([buildInput("a")])).rejects.toThrow(OpenAIBatchJudgeError);
});

test("poll returns in_progress for non-terminal statuses", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({ id: "batch_abc", status: "validating" }),
      { status: 200 }
    )) as typeof fetch;

  const provider = new OpenAIBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const result = await provider.poll("batch_abc", ["a"]);
  expect(result.status).toBe("in_progress");
});

test("poll returns completed with parsed per-session results", async () => {
  let callCount = 0;
  const fakeFetch: typeof fetch = (async (url: string) => {
    callCount += 1;
    if (callCount === 1) {
      // retrieve batch
      return new Response(
        JSON.stringify({
          id: "batch_abc",
          status: "completed",
          output_file_id: "file_out"
        }),
        { status: 200 }
      );
    }
    // fetch output file content
    expect(url).toBe("https://api.openai.com/v1/files/file_out/content");
    const body =
      buildOutputLine("a", {
        skills: [{ skillId: "s1", invoked: true, confidence: 0.9, evidence: [] }]
      }) +
      "\n" +
      buildOutputLine("b", {
        skills: [{ skillId: "s1", invoked: false, confidence: 0.2, evidence: [] }]
      }) +
      "\n";
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  const provider = new OpenAIBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const result = await provider.poll("batch_abc", ["a", "b"]);
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(result.results.get("a")?.status).toBe("succeeded");
  expect(result.results.get("b")?.status).toBe("succeeded");
});

test("poll handles failed status with error description", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "batch_abc",
        status: "failed",
        errors: { object: "list", data: [{ code: "invalid_request_error", message: "bad input" }] }
      }),
      { status: 200 }
    )) as typeof fetch;

  const provider = new OpenAIBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const result = await provider.poll("batch_abc", ["a"]);
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.error).toMatch(/failed/);
});

test("poll fills in failure for sessions missing from output file", async () => {
  let callCount = 0;
  const fakeFetch: typeof fetch = (async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(
        JSON.stringify({ id: "batch_abc", status: "completed", output_file_id: "file_out" }),
        { status: 200 }
      );
    }
    // only "a" comes back
    return new Response(
      buildOutputLine("a", {
        skills: [{ skillId: "s1", invoked: true, confidence: 0.9, evidence: [] }]
      }) + "\n",
      { status: 200 }
    );
  }) as typeof fetch;

  const provider = new OpenAIBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const result = await provider.poll("batch_abc", ["a", "missing"]);
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(result.results.get("a")?.status).toBe("succeeded");
  expect(result.results.get("missing")?.status).toBe("failed");
});

test("poll returns failed when retrieve endpoint returns non-2xx", async () => {
  const fakeFetch: typeof fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  const provider = new OpenAIBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const result = await provider.poll("batch_missing", ["a"]);
  expect(result.status).toBe("failed");
});

test("poll returns failed when completed batch has no output_file_id", async () => {
  const fakeFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({ id: "batch_abc", status: "completed", output_file_id: null }),
      { status: 200 }
    )) as typeof fetch;

  const provider = new OpenAIBatchJudgeProvider({ apiKey: "sk", model: "m", fetcher: fakeFetch });
  const result = await provider.poll("batch_abc", ["a"]);
  expect(result.status).toBe("failed");
});
