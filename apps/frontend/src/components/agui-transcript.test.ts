import { describe, expect, test } from "vitest";
import { ToolResultSchema, type Message } from "@cogniplane/shared-types";

import {
  mcpAppsFromMessages,
  runtimeNoticesFromMessages,
  toolStatusesFromMessages
} from "./agui-transcript";

test("reload links only completed app calls by tool call ID", () => {
  const app = { resourceUri: "ui://quote-picker/app.html", result: { content: [{ type: "text", text: "Quotes" }] } };
  const tool: Message["toolResults"][number] = {
    toolResultId: "call-1", kind: "mcp", title: "Quotes", status: "completed",
    command: null, cwd: null, server: "quote-server", toolName: "show_quote_picker",
    input: "{}", output: "Quotes", exitCode: null, durationMs: 1, textOffset: 0,
    mcpApp: app
  };
  const history = [
    makeMessage({ messageId: "a1", role: "assistant", toolResults: [tool] }),
    makeMessage({ messageId: "a2", role: "assistant", toolResults: [{ ...tool, toolResultId: "call-2", status: "in_progress" }] })
  ];
  expect(mcpAppsFromMessages(history)).toEqual({ "call-1": app });
});

test("reload does not link a retained legacy inline resource row as an app", () => {
  // Rows saved before the inline resource contract was retired keep uiResources.
  const tool = ToolResultSchema.parse({
    toolResultId: "call-1", kind: "mcp", title: "legacy_widget", status: "completed",
    command: null, cwd: null, server: "legacy", toolName: "legacy_widget",
    input: "{}", output: "[interactive UI: ui://legacy/card]", exitCode: null, durationMs: 1, textOffset: 0,
    uiResources: [{ uri: "ui://legacy/card", mimeType: "text/html", text: "<b>retained-html</b>" }]
  });
  expect(tool.uiResources).toEqual([{ uri: "ui://legacy/card", mimeType: "text/html", text: "<b>retained-html</b>" }]);
  const history = [makeMessage({ messageId: "a1", role: "assistant", content: "", toolResults: [tool] })];

  expect(mcpAppsFromMessages(history)).toEqual({});
});

function makeMessage(overrides: Partial<Message>): Message {
  return {
    role: "user",
    content: "",
    status: "completed",
    ...overrides
  } as Message;
}

describe("toolStatusesFromMessages", () => {
  function assistantWith(status: string, extra: Record<string, unknown> = {}) {
    return makeMessage({
      messageId: "a1",
      role: "assistant",
      content: "",
      toolResults: [
        {
          toolResultId: "call-1",
          kind: "mcp",
          title: "search",
          status,
          command: null,
          cwd: null,
          server: "github",
          toolName: "search_repos",
          input: "",
          output: "boom",
          exitCode: null,
          durationMs: 42,
          ...extra
        }
      ]
    } as Partial<Message>);
  }

  test("reconstructs a failed tool-status row matching the live tool_status shape", () => {
    expect(toolStatusesFromMessages([assistantWith("failed")])).toEqual([
      {
        type: "tool-status",
        rowId: "tool:call-1",
        toolCallId: "call-1",
        toolName: "search_repos",
        status: "failed",
        server: "github",
        durationMs: 42
      }
    ]);
  });

  test("reconstructs a declined tool-status row", () => {
    const rows = toolStatusesFromMessages([assistantWith("declined")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("declined");
  });

  test("ignores completed and in_progress results (only failures surface live)", () => {
    expect(toolStatusesFromMessages([assistantWith("completed")])).toEqual([]);
    expect(toolStatusesFromMessages([assistantWith("in_progress")])).toEqual([]);
  });

  test("falls back to title when toolName is null and null server/duration", () => {
    const rows = toolStatusesFromMessages([
      assistantWith("failed", { toolName: null, server: null, durationMs: null })
    ]);
    expect(rows[0].toolName).toBe("search");
    expect(rows[0].server).toBeNull();
    expect(rows[0].durationMs).toBeNull();
  });

  test("skips user/system rows and returns [] when nothing failed", () => {
    expect(
      toolStatusesFromMessages([
        makeMessage({ messageId: "u1", role: "user", content: "hi" }),
        makeMessage({ messageId: "s1", role: "system", content: "titled" })
      ])
    ).toEqual([]);
  });
});

describe("runtimeNoticesFromMessages", () => {
  const saved = (noticeId: string, overrides: Record<string, unknown> = {}) => ({
    noticeId, level: "warning", title: "Tool slow", message: "The tool took 30 s.",
    createdAt: "2026-09-22T00:00:00.000Z", ...overrides
  });
  const withNotices = (messageId: string, runtimeNotices: unknown, role: Message["role"] = "assistant") =>
    makeMessage({ messageId, role, detail: { runtimeNotices } } as Partial<Message>);

  test("builds notice rows in history order from the assistant rows", () => {
    const rows = runtimeNoticesFromMessages([
      withNotices("a-1", [saved("n-1")]),
      withNotices("a-2", [saved("n-2", { level: "error", title: "Failed" })])
    ]);

    expect(rows).toEqual([
      {
        type: "runtime-notice", rowId: "notice:n-1", noticeId: "n-1", level: "warning",
        title: "Tool slow", message: "The tool took 30 s.", createdAt: "2026-09-22T00:00:00.000Z"
      },
      expect.objectContaining({ rowId: "notice:n-2", level: "error", title: "Failed" })
    ]);
  });

  test("drops entries that fail the runtime_notice schema", () => {
    const rows = runtimeNoticesFromMessages([
      withNotices("a-1", [
        saved("ok"),
        saved("bad-level", { level: "debug" }),
        saved("", {}),
        saved("bad-date", { createdAt: "yesterday" }),
        { noticeId: "missing-fields" },
        "text",
        null
      ])
    ]);

    expect(rows.map((row) => row.noticeId)).toEqual(["ok"]);
  });

  test("ignores a detail without a notice array and rows that are not assistant rows", () => {
    expect(runtimeNoticesFromMessages([
      makeMessage({ role: "assistant" }),
      withNotices("a-1", { noticeId: "not-an-array" }),
      withNotices("u-1", [saved("user-row")], "user"),
      withNotices("s-1", [saved("system-row")], "system")
    ])).toEqual([]);
  });

  test("keeps the first entry for a noticeId", () => {
    const rows = runtimeNoticesFromMessages([
      withNotices("a-1", [saved("n-1", { title: "First" }), saved("n-1", { title: "Again" })]),
      withNotices("a-2", [saved("n-1", { title: "Later" })])
    ]);

    expect(rows.map((row) => row.title)).toEqual(["First"]);
  });
});
