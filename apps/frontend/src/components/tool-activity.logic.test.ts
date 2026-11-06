import { describe, expect, it } from "vitest";
import { describeToolCall, nameAsWords, oneLine, previewResult, resultText, RESULT_PREVIEW_LIMIT } from "./tool-activity.logic";

describe("describeToolCall", () => {
  it.each([
    ["read_file", { file_path: "/src/app.ts", offset: 0, limit: 100 }, "Read file", "/src/app.ts", "file"],
    ["write_file", { file_path: "/notes.md", content: "text" }, "Write file", "/notes.md", "file"],
    ["edit_file", { file_path: "/a.ts", old_string: "a", new_string: "b" }, "Edit file", "/a.ts", "file"],
    ["delete", { file_path: "/old.txt" }, "Delete file", "/old.txt", "file"],
    ["ls", { path: "/src" }, "List folder", "/src", "folder"],
    ["glob", { pattern: "**/*.ts" }, "Find files", "**/*.ts", "search"],
    ["grep", { pattern: "TODO", path: "/" }, "Search files", "TODO", "search"],
    ["execute", { command: "pnpm test" }, "Run command", "pnpm test", "command"]
  ] as const)("describes %s from the argument its schema documents", (name, args, label, target, icon) => {
    expect(describeToolCall(name, args)).toMatchObject({ label, target, icon });
  });

  it.each(["read_file", "write_file", "edit_file", "delete"])("accepts the path alias for %s without replacing file_path", (name) => {
    expect(describeToolCall(name, { path: "/alias" }).target).toBe("/alias");
    expect(describeToolCall(name, { file_path: "/primary", path: "/alias" }).target).toBe("/primary");
    expect(describeToolCall(name, { file_path: 7, path: "/alias" })).toMatchObject({ target: null, icon: "tool" });
  });

  it.each(["write_artifact", "memory_search", "notion_search", "jira_search_issues"])("does not assume the server that owns %s", (name) => {
    expect(describeToolCall(name, { name: "report.md", query: "roadmap", jql: "project = ABC" }))
      .toEqual({ label: nameAsWords(name), target: null, icon: "tool", readableResult: false });
  });

  it("marks only the built-in tools that return plain text as readable", () => {
    expect(describeToolCall("read_file", { file_path: "/a" }).readableResult).toBe(true);
    expect(describeToolCall("execute", { command: "ls" }).readableResult).toBe(true);
    expect(describeToolCall("notion_search", { query: "a" }).readableResult).toBe(false);
    expect(describeToolCall("unknown_tool", { query: "a" }).readableResult).toBe(false);
  });

  it("gives an unknown tool its name as words and no target, whatever its arguments say", () => {
    expect(describeToolCall("jira_get_issue", { issueIdOrKey: "ABC-1" })).toEqual({
      label: "Jira get issue", target: null, icon: "tool", readableResult: false
    });
    expect(describeToolCall("search", { query: "cats" }).target).toBeNull();
  });

  it("gives a known tool without its argument a label and no target", () => {
    expect(describeToolCall("read_file", {})).toMatchObject({ label: "Read file", target: null });
    expect(describeToolCall("execute", { command: "   " })).toMatchObject({ label: "Run command", target: null });
    expect(describeToolCall("ls", undefined)).toMatchObject({ label: "List folder", target: null });
  });

  it("does not describe a known tool whose argument has another shape as that tool", () => {
    expect(describeToolCall("execute", { command: ["rm", "-rf", "/"] })).toEqual({
      label: "Execute", target: null, icon: "tool", readableResult: false
    });
    expect(describeToolCall("read_file", { file_path: 7 })).toMatchObject({ label: "Read file", target: null, icon: "tool" });
  });

  it("ignores prototype names", () => {
    expect(describeToolCall("constructor", { command: "x" })).toMatchObject({ label: "Constructor", icon: "tool" });
    expect(describeToolCall("__proto__", {}).icon).toBe("tool");
  });
});

describe("oneLine", () => {
  it("collapses whitespace and removes control and direction characters", () => {
    expect(oneLine("a\n\tb\u0000c\u202Ed  e\u2028f")).toBe("a b c d e f");
  });

  it("cuts long text on a character, with an ellipsis", () => {
    const cut = oneLine("😀".repeat(200), 10);
    expect(Array.from(cut)).toHaveLength(10);
    expect(cut.endsWith("…")).toBe(true);
    expect(oneLine("short", 10)).toBe("short");
  });

  it("returns nothing for text that is only blanks", () => {
    expect(oneLine(" \n\u200b ")).toBe("");
  });
});

describe("nameAsWords", () => {
  it("makes words of a name and keeps a name that has no letters readable", () => {
    expect(nameAsWords("github_create_pr")).toBe("Github create pr");
    expect(nameAsWords("server.tool-name")).toBe("Server tool name");
    expect(nameAsWords("___")).toBe("Tool");
  });
});

describe("resultText", () => {
  it("keeps zero, false and empty text as results, and treats only a missing value as none", () => {
    expect(resultText(undefined)).toBeNull();
    expect(resultText(null)).toBeNull();
    expect(resultText("")).toBe("");
    expect(resultText(0)).toBe("0");
    expect(resultText(false)).toBe("false");
    expect(resultText("0")).toBe("0");
    expect(resultText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("falls back to String() for a value that JSON cannot write", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(resultText(circular)).toBe("[object Object]");
    expect(resultText(() => 1)).toContain("=>");
  });
});

describe("previewResult", () => {
  it("shows a short result whole", () => {
    expect(previewResult("3 matches")).toEqual({ text: "3 matches", hidden: 0 });
    expect(previewResult("0")).toEqual({ text: "0", hidden: 0 });
    expect(previewResult(false)).toEqual({ text: "false", hidden: 0 });
  });

  it("has no preview before a result, and an empty one for blank text", () => {
    expect(previewResult(undefined)).toBeNull();
    expect(previewResult("")).toEqual({ text: "", hidden: 0 });
    expect(previewResult("  \n ")).toEqual({ text: "", hidden: 0 });
  });

  it("keeps only the first part of a long result, and counts what it left out", () => {
    const long = "x".repeat(RESULT_PREVIEW_LIMIT + 500);
    const preview = previewResult(long)!;
    expect(preview.text).toHaveLength(RESULT_PREVIEW_LIMIT);
    expect(preview.hidden).toBe(500);
  });

  it("does not cut a surrogate pair in two", () => {
    const text = `${"a".repeat(9)}😀tail`;
    const preview = previewResult(text, 10)!;
    expect(preview.text).toBe("aaaaaaaaa");
    expect(preview.hidden).toBe(text.length - 9);
  });
});
