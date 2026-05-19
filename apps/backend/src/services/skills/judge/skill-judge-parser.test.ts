import { test, expect } from "vitest";

import { parseJudgeOutput, SkillJudgeParseError } from "./skill-judge-parser.js";

test("parseJudgeOutput accepts a clean JSON response", () => {
  const raw = JSON.stringify({
    skills: [
      {
        skillId: "skill-1",
        invoked: true,
        confidence: 0.83,
        evidence: [{ messageId: "msg-1", quote: "called the tool", reason: "tool aligns" }]
      },
      {
        skillId: "skill-2",
        invoked: false,
        confidence: 0.15,
        evidence: []
      }
    ]
  });
  const output = parseJudgeOutput(raw);
  expect(output.skills.length).toBe(2);
  expect(output.skills[0]?.skillId).toBe("skill-1");
  expect(output.skills[0]?.invoked).toBe(true);
  expect(output.skills[0]?.confidence).toBe(0.83);
  expect(output.skills[0]?.evidence[0]?.messageId).toBe("msg-1");
  expect(output.skills[1]?.invoked).toBe(false);
});

test("parseJudgeOutput unwraps a markdown-fenced response", () => {
  const raw = "Here is the result:\n```json\n" +
    JSON.stringify({ skills: [{ skillId: "s", invoked: true, confidence: 0.5, evidence: [] }] }) +
    "\n```\nLet me know if you need anything else.";
  const output = parseJudgeOutput(raw);
  expect(output.skills[0]?.skillId).toBe("s");
});

test("parseJudgeOutput clamps confidence to [0, 1] and ignores non-numeric", () => {
  const raw = JSON.stringify({
    skills: [
      { skillId: "low",  invoked: false, confidence: -3, evidence: [] },
      { skillId: "high", invoked: true,  confidence: 99, evidence: [] },
      { skillId: "nan",  invoked: true,  confidence: "abc", evidence: [] }
    ]
  });
  const output = parseJudgeOutput(raw);
  expect(output.skills.find((s) => s.skillId === "low")?.confidence).toBe(0);
  expect(output.skills.find((s) => s.skillId === "high")?.confidence).toBe(1);
  expect(output.skills.find((s) => s.skillId === "nan")?.confidence).toBe(0);
});

test("parseJudgeOutput drops invalid skill entries", () => {
  const raw = JSON.stringify({
    skills: [
      { skillId: "valid", invoked: true, confidence: 0.5, evidence: [] },
      { invoked: true, confidence: 0.5 }, // missing skillId
      "not-an-object"
    ]
  });
  const output = parseJudgeOutput(raw);
  expect(output.skills.length).toBe(1);
  expect(output.skills[0]?.skillId).toBe("valid");
});

test("parseJudgeOutput throws when no JSON object is present", () => {
  expect(() => parseJudgeOutput("the model said sorry but no JSON")).toThrow(SkillJudgeParseError);
});

test("parseJudgeOutput throws on missing skills array", () => {
  const raw = JSON.stringify({ different: "shape" });
  expect(() => parseJudgeOutput(raw)).toThrow(SkillJudgeParseError);
});

test("parseJudgeOutput truncates evidence to at most 5 entries", () => {
  const evidence = Array.from({ length: 8 }, (_, i) => ({ messageId: `m-${i}` }));
  const raw = JSON.stringify({
    skills: [{ skillId: "s", invoked: true, confidence: 0.5, evidence }]
  });
  const output = parseJudgeOutput(raw);
  expect(output.skills[0]?.evidence.length).toBe(5);
});
