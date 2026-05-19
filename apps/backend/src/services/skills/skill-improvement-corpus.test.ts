import { test, expect } from "vitest";

import type { MessageRecord } from "../message-store.js";
import { formatCorpus } from "./skill-improvement-corpus.js";

const skill = {
  skillId: "write-artifact",
  skillName: "Write Artifact",
  description: "Save generated files via write_artifact.",
  instructions: "Always call write_artifact for generated files."
};

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: 1,
    messageId: "msg_user_1",
    sessionId: "sess_1",
    userId: "user_1",
    role: "user",
    status: "completed",
    content: "Please write me a fibonacci script.",
    reasoningContent: "",
    planContent: "",
    tokenUsage: null,
    modelName: null,
    costUsd: null,
    feedbackRating: null,
    detail: {},
    toolResults: [],
    createdAt: "2026-04-25T10:00:00.000Z",
    updatedAt: "2026-04-25T10:00:00.000Z",
    ...overrides
  };
}

test("formatCorpus emits skill metadata + the empty-state hint when no sessions", () => {
  const result = formatCorpus({
    skill,
    tenantId: "tenant-1",
    generatedAt: "2026-04-25T12:00:00.000Z",
    sessionLimit: 50,
    sessions: []
  });

  expect(result.includedSessionCount).toBe(0);
  expect(result.markdown).toMatch(/# Skill improvement corpus — Write Artifact/);
  expect(result.markdown).toMatch(/\*\*Skill id:\*\* `write-artifact`/);
  expect(result.markdown).toMatch(/No prior sessions found for this skill yet/);
});

test("formatCorpus renders a session with one user message and assistant tool call", () => {
  const result = formatCorpus({
    skill,
    tenantId: "tenant-1",
    generatedAt: "2026-04-25T12:00:00.000Z",
    sessionLimit: 50,
    sessions: [
      {
        sessionId: "sess_abc",
        sessionName: "Fibonacci task",
        occurredAt: "2026-04-25T11:00:00.000Z",
        messages: [
          makeMessage(),
          makeMessage({
            messageId: "msg_assistant_1",
            role: "assistant",
            content: "Here is the script.",
            toolResults: [
              {
                id: 10,
                toolResultId: "tr_1",
                messageId: "msg_assistant_1",
                sessionId: "sess_abc",
                userId: "user_1",
                kind: "mcp",
                title: "write_artifact",
                status: "completed",
                command: null,
                cwd: null,
                server: "managed-session-context",
                toolName: "write_artifact",
                input: '{"name":"fib.py"}',
                output: "ok: artifact saved",
                exitCode: null,
                durationMs: 12,
                createdAt: "2026-04-25T10:00:05.000Z",
                updatedAt: "2026-04-25T10:00:05.000Z"
              }
            ]
          })
        ]
      }
    ]
  });

  expect(result.includedSessionCount).toBe(1);
  expect(result.markdown).toMatch(/### Session `sess_abc`/);
  expect(result.markdown).toMatch(/Fibonacci task/);
  expect(result.markdown).toMatch(/tool.*write_artifact.*status: completed/);
  expect(result.markdown).toMatch(/ok: artifact saved/);
});

test("formatCorpus truncates long tool outputs and reports the count", () => {
  const longOutput = "x".repeat(2000);
  const result = formatCorpus({
    skill,
    tenantId: "tenant-1",
    generatedAt: "2026-04-25T12:00:00.000Z",
    sessionLimit: 50,
    sessions: [
      {
        sessionId: "sess_long",
        sessionName: null,
        occurredAt: "2026-04-25T11:00:00.000Z",
        messages: [
          makeMessage({
            role: "assistant",
            messageId: "msg_assistant_long",
            content: "",
            toolResults: [
              {
                id: 1,
                toolResultId: "tr_long",
                messageId: "msg_assistant_long",
                sessionId: "sess_long",
                userId: "user_1",
                kind: "mcp",
                title: "search",
                status: "completed",
                command: null,
                cwd: null,
                server: null,
                toolName: "search",
                input: "",
                output: longOutput,
                exitCode: null,
                durationMs: null,
                createdAt: "2026-04-25T10:00:00.000Z",
                updatedAt: "2026-04-25T10:00:00.000Z"
              }
            ]
          })
        ]
      }
    ]
  });

  expect(result.truncatedToolResultCount).toBe(1);
  expect(result.markdown).toMatch(/bytes elided/);
});

test("formatCorpus surfaces user feedback rating on the message", () => {
  const result = formatCorpus({
    skill,
    tenantId: "tenant-1",
    generatedAt: "2026-04-25T12:00:00.000Z",
    sessionLimit: 50,
    sessions: [
      {
        sessionId: "sess_feedback",
        sessionName: null,
        occurredAt: "2026-04-25T11:00:00.000Z",
        messages: [
          makeMessage({
            role: "assistant",
            feedbackRating: "thumbs_down",
            content: "Bad answer."
          })
        ]
      }
    ]
  });

  expect(result.markdown).toMatch(/Feedback: \*\*thumbs_down\*\*/);
});

test("formatCorpus emits placeholder text when the skill has no description", () => {
  const result = formatCorpus({
    skill: { ...skill, description: null },
    tenantId: "tenant-1",
    generatedAt: "2026-04-25T12:00:00.000Z",
    sessionLimit: 50,
    sessions: []
  });
  expect(result.markdown).toContain("_(no description)_");
});

test("formatCorpus emits placeholder text when the skill has empty instructions", () => {
  const result = formatCorpus({
    skill: { ...skill, instructions: "   " },
    tenantId: "tenant-1",
    generatedAt: "2026-04-25T12:00:00.000Z",
    sessionLimit: 50,
    sessions: []
  });
  expect(result.markdown).toContain("_(no instructions)_");
});

test("formatCorpus renders an empty-session marker when a session has no messages", () => {
  const result = formatCorpus({
    skill,
    tenantId: "tenant-1",
    generatedAt: "2026-04-25T12:00:00.000Z",
    sessionLimit: 50,
    sessions: [
      {
        sessionId: "sess_empty",
        sessionName: null,
        occurredAt: "2026-04-25T11:00:00.000Z",
        messages: []
      }
    ]
  });
  expect(result.markdown).toContain("_(no messages in this session)_");
  expect(result.includedSessionCount).toBe(1);
});

test("formatCorpus byteBudget excludes additional sessions but always keeps the first", () => {
  const big = "y".repeat(5_000);
  const sessions = Array.from({ length: 3 }, (_, i) => ({
    sessionId: `sess_${i}`,
    sessionName: null,
    occurredAt: "2026-04-25T11:00:00.000Z",
    messages: [
      makeMessage({
        messageId: `msg_${i}`,
        content: big
      })
    ]
  }));
  const result = formatCorpus({
    skill,
    tenantId: "tenant-1",
    generatedAt: "2026-04-25T12:00:00.000Z",
    sessionLimit: 50,
    sessions,
    byteBudget: 6_000
  });
  // First session always included; others excluded.
  expect(result.includedSessionCount).toBe(1);
  expect(result.excludedSessionCount).toBe(2);
  expect(result.markdown).toContain("additional session(s) were excluded");
});

test("formatCorpus tool input is excerpted to TOOL_INPUT_EXCERPT_BYTES (400)", () => {
  const longInput = "i".repeat(800);
  const result = formatCorpus({
    skill,
    tenantId: "tenant-1",
    generatedAt: "2026-04-25T12:00:00.000Z",
    sessionLimit: 50,
    sessions: [
      {
        sessionId: "sess_longinput",
        sessionName: null,
        occurredAt: "2026-04-25T11:00:00.000Z",
        messages: [
          makeMessage({
            role: "assistant",
            messageId: "msg_a",
            content: "",
            toolResults: [
              {
                id: 1,
                toolResultId: "tr_x",
                messageId: "msg_a",
                sessionId: "sess_longinput",
                userId: "user_1",
                kind: "mcp",
                title: "search",
                status: "completed",
                command: null,
                cwd: null,
                server: null,
                toolName: "search",
                input: longInput,
                output: "ok",
                exitCode: null,
                durationMs: null,
                createdAt: "2026-04-25T10:00:00.000Z",
                updatedAt: "2026-04-25T10:00:00.000Z"
              }
            ]
          })
        ]
      }
    ]
  });
  // 400 i's quoted via lines beginning "> " — the body must NOT contain 800 i's.
  // We assert that the markdown contains a 400-char run of 'i's but not an 800-char run.
  expect(result.markdown).toMatch(/i{400}/);
  expect(result.markdown).not.toMatch(/i{500}/);
});

test("formatCorpus redacts Bearer tokens in user message content", () => {
  const result = formatCorpus({
    skill,
    tenantId: "tenant-1",
    generatedAt: "2026-04-25T12:00:00.000Z",
    sessionLimit: 50,
    sessions: [
      {
        sessionId: "sess_secret",
        sessionName: null,
        occurredAt: "2026-04-25T11:00:00.000Z",
        messages: [
          makeMessage({
            content: "Auth header: Bearer rt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
          })
        ]
      }
    ]
  });
  // The Bearer token must be replaced with [REDACTED].
  expect(result.markdown).not.toContain("rt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  expect(result.markdown).toContain("Bearer [REDACTED]");
});
