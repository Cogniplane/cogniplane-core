import type { JudgmentEvidence, SkillJudgeOutput, SkillJudgmentResult } from "./skill-judge-types.js";

/**
 * Parse the model's free-text response into a strict `SkillJudgeOutput`.
 *
 * The judge prompt asks for a single JSON object, but real models occasionally
 * wrap output in a markdown fence, prepend "Here is the JSON:", or add a
 * trailing apology. This parser locates the first `{` and last `}` and
 * attempts to JSON.parse that slice — anything outside is ignored.
 *
 * Skills not present in the model's output map to `invoked: false` rows by
 * the caller; we don't fabricate them here.
 */

export class SkillJudgeParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "SkillJudgeParseError";
  }
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function asEvidence(raw: unknown): JudgmentEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const evidence: JudgmentEvidence = {};
  if (typeof obj.messageId === "string") evidence.messageId = obj.messageId;
  if (typeof obj.toolResultId === "string") evidence.toolResultId = obj.toolResultId;
  if (typeof obj.quote === "string") evidence.quote = obj.quote;
  if (typeof obj.reason === "string") evidence.reason = obj.reason;
  return evidence;
}

function asSkillResult(raw: unknown): SkillJudgmentResult | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.skillId !== "string" || obj.skillId.length === 0) return null;

  const invoked = obj.invoked === true;
  const confidenceRaw = Number(obj.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;

  const evidenceArr = Array.isArray(obj.evidence) ? obj.evidence : [];
  const evidence: JudgmentEvidence[] = evidenceArr
    .map(asEvidence)
    .filter((entry): entry is JudgmentEvidence => entry !== null)
    .slice(0, 5);

  return {
    skillId: obj.skillId,
    invoked,
    confidence,
    evidence
  };
}

export function parseJudgeOutput(raw: string): SkillJudgeOutput {
  const slice = extractJsonObject(raw);
  if (!slice) {
    throw new SkillJudgeParseError("Judge response did not contain a JSON object.", raw);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (err) {
    throw new SkillJudgeParseError(
      `Judge response was not valid JSON: ${(err as Error).message}`,
      raw
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new SkillJudgeParseError("Judge response root was not an object.", raw);
  }

  const skillsRaw = (parsed as Record<string, unknown>).skills;
  if (!Array.isArray(skillsRaw)) {
    throw new SkillJudgeParseError("Judge response missing 'skills' array.", raw);
  }

  const skills: SkillJudgmentResult[] = [];
  for (const entry of skillsRaw) {
    const result = asSkillResult(entry);
    if (result) skills.push(result);
  }

  return { skills };
}
