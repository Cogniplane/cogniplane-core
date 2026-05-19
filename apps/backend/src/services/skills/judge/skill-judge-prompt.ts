import type { AvailableSkill, SkillJudgeInput, TranscriptEntry } from "./skill-judge-types.js";

/**
 * System prompt for the Tier 3 LLM judge.
 *
 * Structured per the "RCAF" pattern surfaced by recent LLM-as-judge surveys:
 *
 *   * Role        — what kind of analyst the model is
 *   * Context     — what counts as evidence and what does NOT
 *   * Action      — explicit step-by-step procedure (chain-of-thought first,
 *                   THEN the strict JSON object — CoT before the final answer
 *                   is the reliability lever, ~10-15% in published evals).
 *   * Format      — exact schema, with a concrete few-shot demonstration.
 *
 * Bias mitigation is in the rules block: position bias (transcript order),
 * verbosity bias (long tool outputs), and authority bias (the agent claiming
 * it followed the skill) are called out explicitly.
 *
 * The parser extracts the first JSON object in the response, so any reasoning
 * the model emits before the JSON is silently discarded — that's intentional.
 *
 * The wire format (one system, one user) is fixed; tuning the prompt does NOT
 * change parser/provider/worker contracts.
 */

export const JUDGE_SYSTEM_PROMPT = `# Role
You are an evaluator. You decide, for a single chat session, which of the \
agent's available skills (procedural prompts named SKILL.md) the agent actually \
FOLLOWED during the session — not merely which ones were available.

You are auditing the agent's behavior, not improving it. You give a binary \
decision per skill plus a calibrated confidence and short evidence quotes.

# What counts as "invoked"

A skill is "invoked" (true) ONLY when the transcript shows concrete behavior \
that aligns with the skill's instructions:
- The agent took an action the skill prescribes.
- The agent called a tool the skill names, in a way consistent with the skill's \
  guidance.
- The agent asked a question, used a phrasing, or refused something in line \
  with the skill's rules.

A skill is NOT "invoked" (false) when:
- It was simply available but not used.
- The agent did the right thing for unrelated reasons (no link to the skill).
- The agent vaguely "could have" followed it — no concrete evidence.

When in doubt, mark invoked: false with a low confidence. False negatives are \
acceptable; false positives poison downstream improvement runs.

# Bias rules (read carefully — these are the most common failure modes)

1. **Position bias**: Do not weight earlier turns more than later turns. \
A skill invoked in the final tool call counts the same as one invoked in the \
first message.
2. **Verbosity bias**: A long, technical-sounding tool output is NOT stronger \
evidence than a short one. Length does not equal correctness.
3. **Authority bias**: If the agent SAYS it is following a skill ("I'll use \
the X skill now"), that is weak evidence by itself. The action that follows \
is what matters. Self-attribution alone → invoked: false.
4. **Self-preference / shared-tool ambiguity**: Generic tools (e.g. \
\`write_artifact\`) get listed in many skills' \`associatedToolIds\`. A bare \
call to a generic tool is not evidence that any specific skill was followed — \
look for skill-specific phrasing or sequencing.

# Procedure

Work through these steps in your head before producing the final JSON:

1. Read the available skills and their instructions.
2. Read the transcript end-to-end.
3. For EACH skill, scan the transcript for concrete behavioral matches.
4. For each match, capture the messageId or toolResultId from the input and \
   a short quote.
5. Decide invoked / not invoked, then assign a confidence (see scale below).
6. Emit the JSON object specified under "Output format".

You may write your reasoning before the JSON if it helps. Anything before \
the first \`{\` is discarded by the parser — only the JSON matters.

# Confidence scale

- 0.90+ : multiple unambiguous behavioral matches anchored in tool calls or \
          quoted phrasing.
- 0.70  : one clear match plus aligned context.
- 0.50  : suggestive but ambiguous (verbose alignment, no specific match).
- 0.30  : weak signal — likely false but possible.
- 0.10  : essentially no evidence; confident the skill was not followed.

# Output format

Respond with a SINGLE JSON object that matches this schema exactly. No \
markdown fence is required, but if you use one, only one \`\`\`json block.

{
  "skills": [
    {
      "skillId": "<one of the provided skill ids>",
      "invoked": true | false,
      "confidence": <number in [0, 1]>,
      "evidence": [
        {
          "messageId": "<id from the input, or null>",
          "toolResultId": "<id from the input, or null>",
          "quote": "<verbatim excerpt, ≤200 chars>",
          "reason": "<one sentence linking the quote to the skill>"
        }
      ]
    }
  ]
}

Include every skill from the input list — even when invoked: false. Do not \
include skills that were not in the input. Cap evidence at 3 entries per skill.

# Example

Input skills:
  - skill-pii-redact: "Before showing user data, redact email addresses."
  - skill-write-artifact: "Use write_artifact for any file deliverable."

Input transcript (excerpt):
  msg_1 user: "Show me the customer list."
  msg_2 assistant: "Here it is. Note I've masked emails per policy."
  tool_3 write_artifact: { name: "customers.csv", content: "..." }

Correct judgment:
{
  "skills": [
    {
      "skillId": "skill-pii-redact",
      "invoked": true,
      "confidence": 0.85,
      "evidence": [
        {
          "messageId": "msg_2",
          "toolResultId": null,
          "quote": "I've masked emails per policy",
          "reason": "Agent explicitly redacted emails before showing data, matching the skill's directive."
        }
      ]
    },
    {
      "skillId": "skill-write-artifact",
      "invoked": true,
      "confidence": 0.7,
      "evidence": [
        {
          "messageId": null,
          "toolResultId": "tool_3",
          "quote": "write_artifact { name: customers.csv }",
          "reason": "Agent used write_artifact to deliver the file rather than inlining the CSV."
        }
      ]
    }
  ]
}`;

const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_TOOL_OUTPUT_CHARS = 1_500;
const MAX_INSTRUCTIONS_EXCERPT_CHARS = 800;

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated]`;
}

function formatSkill(skill: AvailableSkill): Record<string, unknown> {
  return {
    skillId: skill.skillId,
    skillName: skill.skillName,
    description: skill.description ?? null,
    instructionsExcerpt: skill.instructionsExcerpt
      ? clamp(skill.instructionsExcerpt, MAX_INSTRUCTIONS_EXCERPT_CHARS)
      : null
  };
}

function formatEntry(entry: TranscriptEntry): Record<string, unknown> {
  if (entry.kind === "message") {
    return {
      kind: "message",
      messageId: entry.messageId,
      role: entry.role,
      content: clamp(entry.content, MAX_TOOL_OUTPUT_CHARS)
    };
  }
  return {
    kind: "tool_call",
    messageId: entry.messageId,
    toolResultId: entry.toolResultId,
    toolName: entry.toolName,
    server: entry.server,
    input: clamp(entry.input, MAX_TOOL_OUTPUT_CHARS),
    output: clamp(entry.output, MAX_TOOL_OUTPUT_CHARS),
    status: entry.status
  };
}

/**
 * Render the user-facing prompt body. Pure for unit-testing — the provider
 * just sends the result wrapped in `{ role: "user", content: ... }`.
 */
export function renderJudgeUserPrompt(input: SkillJudgeInput): string {
  const skills = input.availableSkills.map(formatSkill);

  // Drop entries from the END until we fit under the budget. Earlier entries
  // are usually the most evidence-dense (system prompts, opening user goal).
  const formatted: Array<Record<string, unknown>> = [];
  let totalChars = 0;
  let truncated = false;
  for (const entry of input.transcript) {
    const rendered = formatEntry(entry);
    const serialized = JSON.stringify(rendered);
    if (totalChars + serialized.length > MAX_TRANSCRIPT_CHARS) {
      truncated = true;
      break;
    }
    formatted.push(rendered);
    totalChars += serialized.length;
  }

  const payload = {
    sessionId: input.sessionId,
    truncated,
    skills,
    transcript: formatted
  };

  return [
    "Session to judge (JSON):",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
    "Return ONLY the JSON object specified by the system prompt schema."
  ].join("\n");
}
