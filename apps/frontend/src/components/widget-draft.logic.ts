// Rules for text that a tool view (an MCP App widget) asks to put in the chat
// message box. The text goes in as a draft. The user reads it, can change it,
// and sends it with the normal Send button. A tool view never sends it.

/** Blank lines in a row, inside the text, that count as a gap. */
const BLANK_GAP_LINES = 3;

export type DraftWarning =
  | "control-characters"
  | "bidirectional-characters"
  | "leading-blank-lines"
  | "blank-line-gap";

export type DraftReport = {
  /** Characters that the chat sends. The chat trims blank space at both ends. */
  characters: number;
  lines: number;
  warnings: DraftWarning[];
};

// The backend uses the same two rules for file names (artifact-filename.ts).
// A message needs tab, line feed, and carriage return, so those three pass.
function isHiddenControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

// Embedding, override, and isolate characters. They change the order in which
// text shows, so the text on screen can differ from the text that is sent.
function isBidiControl(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

const LINE_BREAK = /\r\n|\r|\n/u;
const STARTS_WITH_BLANK_LINE = /^[^\S\r\n]*[\r\n]/u;

function longestBlankRun(text: string): number {
  const lines = text.trim().split(LINE_BREAK);
  let longest = 0;
  let current = 0;
  for (const line of lines) {
    current = line.trim() === "" ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

/** Checks a draft as it is now, so a change by the user shows at once.
 *  It reports. It never changes the text. */
export function inspectDraft(draft: string): DraftReport {
  const warnings: DraftWarning[] = [];
  let control = false;
  let bidi = false;
  for (const char of draft) {
    const code = char.codePointAt(0) as number;
    control ||= isHiddenControl(code);
    bidi ||= isBidiControl(code);
  }
  if (control) warnings.push("control-characters");
  if (bidi) warnings.push("bidirectional-characters");
  if (STARTS_WITH_BLANK_LINE.test(draft)) warnings.push("leading-blank-lines");
  if (longestBlankRun(draft) >= BLANK_GAP_LINES) warnings.push("blank-line-gap");
  const sent = draft.trim();
  return {
    characters: Array.from(sent).length,
    lines: sent === "" ? 0 : sent.split(LINE_BREAK).length,
    warnings
  };
}

export const DRAFT_WARNING_TEXT: Record<DraftWarning, string> = {
  "control-characters": "The text has hidden control characters. They do not show on screen.",
  "bidirectional-characters":
    "The text has characters that change the text direction. The text on screen can read in a different order than it is sent.",
  "leading-blank-lines": "The text starts with blank lines. Text below them can be out of view. Scroll the message box to read all of it.",
  "blank-line-gap": "The text has a long run of blank lines. Text after it can be out of view. Scroll the message box to read all of it."
};

/** Adds text after a draft of the user. The draft stays as it is. */
export function appendToDraft(draft: string, addition: string): string {
  const kept = draft.trimEnd();
  return kept === "" ? addition : `${kept}\n\n${addition}`;
}

function cleanLabel(value: string, limit: number): string {
  const clean = value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "").replace(/\s+/gu, " ").trim();
  const points = Array.from(clean);
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : clean;
}

/** Names the tool view in the notice: the tool that made it, and its resource.
 *  Both come from the tool server, so the label drops control characters. */
export function widgetSourceLabel(toolName: string, resourceUri: string): string {
  const tool = cleanLabel(toolName, 60) || "unknown tool";
  const resource = cleanLabel(resourceUri, 80);
  return resource ? `${tool} (${resource})` : tool;
}
