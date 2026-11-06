// What a tool card says about a call, from the call alone. A summary reads the
// argument that a known tool is documented to take, and nothing else. A tool
// that the table does not name, or a known tool with an argument of another
// shape, has no summary and keeps its name. The card never reads meaning,
// counts or success from result text.
//
// Every value here comes from the model or a tool. The card renders it as text.

export type ToolIcon = "file" | "folder" | "command" | "search" | "tool";

export type ToolActivity = {
  /** What the call asks for, in short words. The tool name when it is not a known one. */
  label: string;
  /** The value that the call names (path, query, command), on one line. */
  target: string | null;
  icon: ToolIcon;
  /** The result is plain text that the tool was written to return, so the card can show it. */
  readableResult: boolean;
};

const TARGET_LIMIT = 120;
/** Characters of a result that the card shows. The details hold all of it. */
export const RESULT_PREVIEW_LIMIT = 2_000;

type Known = {
  label: string;
  icon: ToolIcon;
  /** The argument that names the target. */
  arg?: string;
  fallbackArg?: string;
  readableResult?: boolean;
};

// Reserved built-in names cannot be claimed by an MCP server. Other tool names
// do not prove which server owns the tool, so they use the generic label.
const KNOWN: Record<string, Known> = {
  ls: { label: "List folder", icon: "folder", arg: "path", readableResult: true },
  read_file: { label: "Read file", icon: "file", arg: "file_path", fallbackArg: "path", readableResult: true },
  write_file: { label: "Write file", icon: "file", arg: "file_path", fallbackArg: "path", readableResult: true },
  edit_file: { label: "Edit file", icon: "file", arg: "file_path", fallbackArg: "path", readableResult: true },
  delete: { label: "Delete file", icon: "file", arg: "file_path", fallbackArg: "path", readableResult: true },
  glob: { label: "Find files", icon: "search", arg: "pattern", readableResult: true },
  grep: { label: "Search files", icon: "search", arg: "pattern", readableResult: true },
  execute: { label: "Run command", icon: "command", arg: "command", readableResult: true }
};

/** One line of text with no control or format characters (they can hide or
 *  reorder text), cut to the limit with an ellipsis. */
export function oneLine(value: string, limit = TARGET_LIMIT): string {
  const clean = value.slice(0, 10_000).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  const points = Array.from(clean);
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : clean;
}

/** The tool name as words: `jira_get_issue` is "Jira get issue". */
export function nameAsWords(name: string): string {
  const words = oneLine(name, 80).replace(/[_\-.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeToolCall(name: string, parameters: unknown): ToolActivity {
  const args = isRecord(parameters) ? parameters : {};
  const known = Object.hasOwn(KNOWN, name) ? KNOWN[name] : undefined;
  if (!known) return { label: nameAsWords(name), target: null, icon: "tool", readableResult: false };
  const value = known.arg
    ? Object.hasOwn(args, known.arg) ? args[known.arg] : known.fallbackArg ? args[known.fallbackArg] : undefined
    : undefined;
  const target = typeof value === "string" && oneLine(value) ? oneLine(value) : null;
  // An argument of another shape is not what the schema documents, so the
  // card does not describe the call as the known tool.
  if (known.arg && value !== undefined && typeof value !== "string") {
    return { label: nameAsWords(name), target: null, icon: "tool", readableResult: false };
  }
  return { label: known.label, target, icon: known.icon, readableResult: known.readableResult === true };
}

export type ResultPreview = {
  /** The first part of the result, as written. */
  text: string;
  /** Characters left out of `text`. Zero when `text` is the whole result. */
  hidden: number;
};

/** Text for a tool result. Zero and false are results, so only a missing
 *  value and an empty string have none. */
export function resultText(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

/** The part of a result that the card shows. A result of spaces only is empty.
 *  The cut does not split a surrogate pair. `hidden` counts UTF-16 units. */
export function previewResult(result: unknown, limit = RESULT_PREVIEW_LIMIT): ResultPreview | null {
  const text = resultText(result);
  if (text === null) return null;
  if (text.trim() === "") return { text: "", hidden: 0 };
  if (text.length <= limit) return { text, hidden: 0 };
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), hidden: text.length - end };
}
