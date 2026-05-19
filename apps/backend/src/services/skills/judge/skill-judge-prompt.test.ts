import { test, expect } from "vitest";

import type { SkillJudgeInput } from "./skill-judge-types.js";

import { JUDGE_SYSTEM_PROMPT, renderJudgeUserPrompt } from "./skill-judge-prompt.js";

test("JUDGE_SYSTEM_PROMPT mentions the role + bias rules", () => {
  // Smoke test that the constant is exported and contains the major sections.
  expect(JUDGE_SYSTEM_PROMPT).toMatch(/^# Role/m);
  expect(JUDGE_SYSTEM_PROMPT).toMatch(/Bias rules/);
  expect(JUDGE_SYSTEM_PROMPT).toMatch(/Output format/);
});

const baseInput: SkillJudgeInput = {
  tenantId: "t",
  sessionId: "s-1",
  availableSkills: [
    {
      skillId: "skill-x",
      skillName: "Skill X",
      description: "does x",
      instructionsExcerpt: "Always do x"
    }
  ],
  transcript: [
    { kind: "message", messageId: "m-1", role: "user", content: "hi" },
    { kind: "message", messageId: "m-2", role: "assistant", content: "hello" }
  ]
};

test("renderJudgeUserPrompt: emits a code-fenced JSON payload with sessionId and skills", () => {
  const out = renderJudgeUserPrompt(baseInput);
  expect(out).toMatch(/^Session to judge \(JSON\):/);
  // Extract the JSON block between fences
  const match = out.match(/```json\n([\s\S]+?)\n```/);
  expect(match).toBeTruthy();
  const payload = JSON.parse(match![1]);
  expect(payload.sessionId).toBe("s-1");
  expect(payload.truncated).toBe(false);
  expect(payload.skills.length).toBe(1);
  expect(payload.skills[0].skillId).toBe("skill-x");
  expect(payload.transcript.length).toBe(2);
  expect(payload.transcript[0].kind).toBe("message");
  expect(payload.transcript[0].messageId).toBe("m-1");
});

test("renderJudgeUserPrompt: skills with no description/excerpt produce nulls in output", () => {
  const out = renderJudgeUserPrompt({
    ...baseInput,
    availableSkills: [{ skillId: "x", skillName: "X", description: null }]
  });
  const payload = JSON.parse(out.match(/```json\n([\s\S]+?)\n```/)![1]);
  expect(payload.skills[0].description).toBe(null);
  expect(payload.skills[0].instructionsExcerpt).toBe(null);
});

test("renderJudgeUserPrompt: long instructionsExcerpt is clamped to 800 chars + ellipsis marker", () => {
  const long = "y".repeat(2_000);
  const out = renderJudgeUserPrompt({
    ...baseInput,
    availableSkills: [
      {
        skillId: "x",
        skillName: "X",
        description: null,
        instructionsExcerpt: long
      }
    ]
  });
  const payload = JSON.parse(out.match(/```json\n([\s\S]+?)\n```/)![1]);
  const excerpt = payload.skills[0].instructionsExcerpt as string;
  // 800 chars of content + truncation marker
  expect(excerpt.startsWith("y".repeat(800))).toBeTruthy();
  expect(excerpt).toMatch(/\[truncated\]$/);
});

test("renderJudgeUserPrompt: tool_call entries pass through with the documented shape", () => {
  const out = renderJudgeUserPrompt({
    ...baseInput,
    transcript: [
      {
        kind: "tool_call",
        messageId: "m-3",
        toolResultId: "tr-1",
        toolName: "fn",
        server: "srv",
        input: "{}",
        output: "ok",
        status: "completed"
      }
    ]
  });
  const payload = JSON.parse(out.match(/```json\n([\s\S]+?)\n```/)![1]);
  const e = payload.transcript[0];
  expect(e.kind).toBe("tool_call");
  expect(e.toolResultId).toBe("tr-1");
  expect(e.toolName).toBe("fn");
  expect(e.server).toBe("srv");
  expect(e.input).toBe("{}");
  expect(e.output).toBe("ok");
  expect(e.status).toBe("completed");
});

test("renderJudgeUserPrompt: long message content is clamped per-entry", () => {
  const huge = "z".repeat(3_000);
  const out = renderJudgeUserPrompt({
    ...baseInput,
    transcript: [{ kind: "message", messageId: "m-1", role: "user", content: huge }]
  });
  const payload = JSON.parse(out.match(/```json\n([\s\S]+?)\n```/)![1]);
  const content = payload.transcript[0].content as string;
  expect(content.length < huge.length).toBeTruthy();
  expect(content).toMatch(/\[truncated\]$/);
});

test("renderJudgeUserPrompt: drops trailing entries to stay under transcript budget; truncated=true", () => {
  // Build a transcript whose JSON payload exceeds 60_000 chars.
  // Each entry is ~1500 chars after clamping; need >= ~50 entries.
  const fill = "a".repeat(1_500);
  const transcript = Array.from({ length: 60 }, (_, i) => ({
    kind: "message" as const,
    messageId: `m-${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: fill
  }));
  const out = renderJudgeUserPrompt({ ...baseInput, transcript });
  const payload = JSON.parse(out.match(/```json\n([\s\S]+?)\n```/)![1]);
  expect(payload.truncated).toBe(true);
  // Earlier entries are kept, later ones dropped
  expect(payload.transcript.length < 60).toBeTruthy();
  expect(payload.transcript[0].messageId).toBe("m-0");
});

test("renderJudgeUserPrompt: short transcript is not truncated", () => {
  const out = renderJudgeUserPrompt(baseInput);
  const payload = JSON.parse(out.match(/```json\n([\s\S]+?)\n```/)![1]);
  expect(payload.truncated).toBe(false);
});
