import { describe, expect, it } from "vitest";

import type { Approval, Message, ToolResult } from "@cogniplane/shared-types";

import {
  buildTimeline,
  classifyToolRow,
  groupTimelineRows,
  messageToRows,
  summarizeGroup,
  type ApprovalRow,
  type ArtifactReadRow,
  type ArtifactWriteRow,
  type AssistantTextRow,
  type McpServerEventInput,
  type McpServerStatusRow,
  type McpToolCallRow,
  type PolicyBlockRow,
  type RuntimeNoticeInput,
  type RuntimeNoticeRow,
  type ShellCommandRow,
  type TimelineGroup,
  type UserMessageRow
} from "./timeline.logic";

// ---------------------------------------------------------------------------
// Builders. The Message and ToolResult schemas are wide; tests only ever care
// about a handful of fields, so these helpers fill in defaults.
// ---------------------------------------------------------------------------

function makeToolResult(overrides: Partial<ToolResult>): ToolResult {
  return {
    toolResultId: "tr-default",
    kind: "command",
    title: "tool",
    status: "completed",
    command: null,
    cwd: null,
    server: null,
    toolName: null,
    input: "",
    output: "",
    exitCode: null,
    durationMs: null,
    ...overrides
  };
}

function makeAssistant(overrides: Partial<Message>): Message {
  return {
    messageId: "m-asst",
    sessionId: "s-1",
    role: "assistant",
    status: "completed",
    content: "",
    reasoningContent: "",
    planContent: "",
    toolResults: [],
    tokenUsage: null,
    modelName: null,
    costUsd: null,
    feedbackRating: null,
    piiScanRunId: null,
    createdAt: "2026-05-09T10:00:00.000Z",
    updatedAt: "2026-05-09T10:00:00.000Z",
    ...overrides
  };
}

function makeUser(overrides: Partial<Message>): Message {
  return makeAssistant({
    messageId: "m-user",
    role: "user",
    content: "hello",
    status: "completed",
    ...overrides
  });
}

function makeApproval(overrides: Partial<Approval>): Approval {
  return {
    approvalId: "a-default",
    sessionId: "s-1",
    itemId: "item-1",
    kind: "command_execution",
    title: "Run something",
    summary: "rm -rf /tmp/foo",
    status: "pending",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// classifyToolRow — covers the spec's classification table.
// ---------------------------------------------------------------------------

describe("classifyToolRow", () => {
  it("classifies any command-kind tool result as shell-command", () => {
    const tr = makeToolResult({ kind: "command", command: "ls" });
    expect(classifyToolRow(tr)).toBe("shell-command");
  });

  it("classifies framework/write_artifact as artifact-write", () => {
    const tr = makeToolResult({ kind: "mcp", server: "framework", toolName: "write_artifact" });
    expect(classifyToolRow(tr)).toBe("artifact-write");
  });

  it("classifies framework/read_text_artifact as artifact-read", () => {
    const tr = makeToolResult({ kind: "mcp", server: "framework", toolName: "read_text_artifact" });
    expect(classifyToolRow(tr)).toBe("artifact-read");
  });

  it("classifies framework/read_artifact as artifact-read (forward-compat)", () => {
    const tr = makeToolResult({ kind: "mcp", server: "framework", toolName: "read_artifact" });
    expect(classifyToolRow(tr)).toBe("artifact-read");
  });

  it("classifies framework/list_artifacts as artifact-read", () => {
    const tr = makeToolResult({ kind: "mcp", server: "framework", toolName: "list_artifacts" });
    expect(classifyToolRow(tr)).toBe("artifact-read");
  });

  it("falls back to mcp-tool-call for any other server/tool combination", () => {
    expect(
      classifyToolRow(makeToolResult({ kind: "mcp", server: "github", toolName: "create_pr" }))
    ).toBe("mcp-tool-call");
    expect(
      classifyToolRow(makeToolResult({ kind: "mcp", server: "notion", toolName: "search" }))
    ).toBe("mcp-tool-call");
  });

  it("does not classify framework/write_artifact when server is missing", () => {
    expect(
      classifyToolRow(makeToolResult({ kind: "mcp", server: null, toolName: "write_artifact" }))
    ).toBe("mcp-tool-call");
  });

  it("is case-insensitive on the server name", () => {
    expect(
      classifyToolRow(makeToolResult({ kind: "mcp", server: "Framework", toolName: "write_artifact" }))
    ).toBe("artifact-write");
  });
});

// ---------------------------------------------------------------------------
// messageToRows — derivation for every status / role / shape combination.
// ---------------------------------------------------------------------------

describe("messageToRows — user role", () => {
  it("emits a single UserMessageRow with no PII banner when piiScanRunId is null", () => {
    const rows = messageToRows(makeUser({ content: "hi", piiScanRunId: null }));
    expect(rows).toHaveLength(1);
    const row = rows[0] as UserMessageRow;
    expect(row.type).toBe("user-message");
    expect(row.text).toBe("hi");
    expect(row.piiScanRunId).toBeNull();
  });

  it("propagates piiScanRunId so the renderer can attach the banner", () => {
    const rows = messageToRows(makeUser({ piiScanRunId: "scan-42" }));
    const row = rows[0] as UserMessageRow;
    expect(row.piiScanRunId).toBe("scan-42");
  });
});

describe("messageToRows — assistant role", () => {
  it("emits a single AssistantTextRow when only content is present", () => {
    const rows = messageToRows(
      makeAssistant({ content: "Done.", status: "completed" })
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as AssistantTextRow;
    expect(row.type).toBe("assistant-text");
    expect(row.text).toBe("Done.");
    expect(row.status).toBe("completed");
  });

  it("orders rows reasoning, plan, tools, then assistant text", () => {
    const message = makeAssistant({
      reasoningContent: "thinking…",
      planContent: "step 1",
      content: "ok",
      toolResults: [
        makeToolResult({ toolResultId: "tr-1", kind: "command", command: "ls" }),
        makeToolResult({
          toolResultId: "tr-2",
          kind: "mcp",
          server: "framework",
          toolName: "write_artifact",
          input: "{\"name\":\"out.md\"}"
        })
      ]
    });
    const types = messageToRows(message).map((r) => r.type);
    expect(types).toEqual([
      "reasoning",
      "plan",
      "shell-command",
      "artifact-write",
      "assistant-text"
    ]);
  });

  it("omits assistant text when there is no content but tool calls exist", () => {
    const message = makeAssistant({
      content: "",
      status: "completed",
      toolResults: [
        makeToolResult({ toolResultId: "tr-1", kind: "command", command: "ls" })
      ]
    });
    const types = messageToRows(message).map((r) => r.type);
    expect(types).toEqual(["shell-command"]);
  });

  it("renders an empty AssistantTextRow placeholder when there is nothing else (status: pending/streaming)", () => {
    const message = makeAssistant({ content: "", status: "streaming" });
    const rows = messageToRows(message);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("assistant-text");
  });

  it("appends a RuntimeErrorRow after the assistant text on error status", () => {
    const message = makeAssistant({
      content: "Sorry, ran out of tokens.",
      status: "error"
    });
    const types = messageToRows(message).map((r) => r.type);
    expect(types).toEqual(["assistant-text", "runtime-error"]);
  });

  it("emits only RuntimeErrorRow when status is error and content is empty", () => {
    const message = makeAssistant({ content: "", status: "error" });
    const types = messageToRows(message).map((r) => r.type);
    expect(types).toEqual(["runtime-error"]);
  });

  it("classifies tool results into the right row variants", () => {
    const message = makeAssistant({
      content: "",
      toolResults: [
        makeToolResult({ toolResultId: "tr-1", kind: "command", command: "ls -la" }),
        makeToolResult({
          toolResultId: "tr-2",
          kind: "mcp",
          server: "github",
          toolName: "list_pull_requests"
        }),
        makeToolResult({
          toolResultId: "tr-3",
          kind: "mcp",
          server: "framework",
          toolName: "write_artifact"
        }),
        makeToolResult({
          toolResultId: "tr-4",
          kind: "mcp",
          server: "framework",
          toolName: "read_text_artifact"
        })
      ]
    });
    const types = messageToRows(message).map((r) => r.type);
    expect(types).toEqual([
      "shell-command",
      "mcp-tool-call",
      "artifact-write",
      "artifact-read"
    ]);
  });

  it("preserves shell command fields verbatim on the row", () => {
    const message = makeAssistant({
      toolResults: [
        makeToolResult({
          toolResultId: "tr-x",
          kind: "command",
          command: "pnpm test",
          cwd: "/repo",
          output: "1 passing",
          exitCode: 0,
          durationMs: 1234,
          status: "completed"
        })
      ]
    });
    const row = messageToRows(message).find((r) => r.type === "shell-command") as ShellCommandRow;
    expect(row.command).toBe("pnpm test");
    expect(row.cwd).toBe("/repo");
    expect(row.output).toBe("1 passing");
    expect(row.exitCode).toBe(0);
    expect(row.durationMs).toBe(1234);
  });

  it("preserves MCP tool call fields verbatim on the row", () => {
    const message = makeAssistant({
      toolResults: [
        makeToolResult({
          toolResultId: "tr-y",
          kind: "mcp",
          server: "github",
          toolName: "create_pr",
          input: "{\"branch\":\"main\"}",
          output: "PR created",
          durationMs: 500,
          status: "completed"
        })
      ]
    });
    const row = messageToRows(message).find((r) => r.type === "mcp-tool-call") as McpToolCallRow;
    expect(row.server).toBe("github");
    expect(row.toolName).toBe("create_pr");
    expect(row.input).toBe("{\"branch\":\"main\"}");
    expect(row.output).toBe("PR created");
  });

  it("preserves artifact-write fields", () => {
    const message = makeAssistant({
      toolResults: [
        makeToolResult({
          toolResultId: "tr-aw",
          kind: "mcp",
          server: "framework",
          toolName: "write_artifact",
          input: "{\"name\":\"summary.md\"}",
          output: "{\"id\":\"art-1\"}",
          status: "completed"
        })
      ]
    });
    const row = messageToRows(message).find((r) => r.type === "artifact-write") as ArtifactWriteRow;
    expect(row.toolName).toBe("write_artifact");
    expect(row.input).toContain("summary.md");
    expect(row.output).toContain("art-1");
    expect(row.status).toBe("completed");
  });

  it("preserves artifact-read fields", () => {
    const message = makeAssistant({
      toolResults: [
        makeToolResult({
          toolResultId: "tr-ar",
          kind: "mcp",
          server: "framework",
          toolName: "read_text_artifact",
          input: "{\"id\":\"art-1\"}",
          output: "file contents…",
          status: "completed"
        })
      ]
    });
    const row = messageToRows(message).find((r) => r.type === "artifact-read") as ArtifactReadRow;
    expect(row.toolName).toBe("read_text_artifact");
    expect(row.input).toContain("art-1");
    expect(row.output).toContain("file contents");
  });
});

describe("messageToRows — system role", () => {
  it("renders a system message as a PolicyBlockRow", () => {
    const message = makeAssistant({
      messageId: "m-sys",
      role: "system",
      content: "Your message contained sensitive data and was blocked."
    });
    const rows = messageToRows(message);
    expect(rows).toHaveLength(1);
    const row = rows[0] as PolicyBlockRow;
    expect(row.type).toBe("policy-block");
    expect(row.message).toContain("sensitive data");
  });
});

// ---------------------------------------------------------------------------
// buildTimeline — interleaving of approvals, mcp-server events, notices.
// ---------------------------------------------------------------------------

describe("buildTimeline", () => {
  it("returns an empty timeline when there are no inputs", () => {
    expect(
      buildTimeline({
        messages: [],
        pendingApprovals: [],
        approvalDecision: null,
        mcpServerEvents: [],
        runtimeNotices: []
      })
    ).toEqual([]);
  });

  it("appends pending approvals after all messages", () => {
    const rows = buildTimeline({
      messages: [makeUser({})],
      pendingApprovals: [makeApproval({ approvalId: "a-1" })],
      approvalDecision: null,
      mcpServerEvents: [],
      runtimeNotices: []
    });
    const types = rows.map((r) => r.type);
    expect(types).toEqual(["user-message", "approval"]);
    const approval = rows[1] as ApprovalRow;
    expect(approval.decisionState).toBe("pending");
  });

  it("flips an approval to 'approving' state when an approve decision is in flight", () => {
    const rows = buildTimeline({
      messages: [],
      pendingApprovals: [makeApproval({ approvalId: "a-1" })],
      approvalDecision: { approvalId: "a-1", kind: "approve" },
      mcpServerEvents: [],
      runtimeNotices: []
    });
    const approval = rows[0] as ApprovalRow;
    expect(approval.decisionState).toBe("approving");
  });

  it("flips an approval to 'rejecting' state when a reject decision is in flight", () => {
    const rows = buildTimeline({
      messages: [],
      pendingApprovals: [makeApproval({ approvalId: "a-1" })],
      approvalDecision: { approvalId: "a-1", kind: "reject" },
      mcpServerEvents: [],
      runtimeNotices: []
    });
    const approval = rows[0] as ApprovalRow;
    expect(approval.decisionState).toBe("rejecting");
  });

  it("preserves the order of multiple pending approvals", () => {
    const rows = buildTimeline({
      messages: [],
      pendingApprovals: [
        makeApproval({ approvalId: "a-1" }),
        makeApproval({ approvalId: "a-2" })
      ],
      approvalDecision: null,
      mcpServerEvents: [],
      runtimeNotices: []
    });
    expect(rows.map((r) => (r as ApprovalRow).approvalId)).toEqual(["a-1", "a-2"]);
  });

  it("renders mcp-server transitions, dropping ready states", () => {
    const events: McpServerEventInput[] = [
      { serverName: "github", status: "starting", error: null },
      { serverName: "github", status: "ready", error: null },
      { serverName: "notion", status: "failed", error: "boom" }
    ];
    const rows = buildTimeline({
      messages: [],
      pendingApprovals: [],
      approvalDecision: null,
      mcpServerEvents: events,
      runtimeNotices: []
    });
    const statusRows = rows.filter((r): r is McpServerStatusRow => r.type === "mcp-server-status");
    expect(statusRows).toHaveLength(2);
    expect(statusRows[0]!.status).toBe("starting");
    expect(statusRows[1]!.status).toBe("failed");
    expect(statusRows[1]!.error).toBe("boom");
  });

  it("appends runtime notices after mcp-server rows", () => {
    const notices: RuntimeNoticeInput[] = [
      {
        noticeId: "approval-expired:a-9",
        level: "warning",
        title: "Approval expired",
        message: "The runtime continued without action.",
        createdAt: "2026-05-09T11:00:00.000Z"
      }
    ];
    const rows = buildTimeline({
      messages: [],
      pendingApprovals: [],
      approvalDecision: null,
      mcpServerEvents: [{ serverName: "github", status: "starting", error: null }],
      runtimeNotices: notices
    });
    const types = rows.map((r) => r.type);
    expect(types).toEqual(["mcp-server-status", "runtime-notice"]);
    const notice = rows[1] as RuntimeNoticeRow;
    expect(notice.level).toBe("warning");
    expect(notice.noticeId).toBe("approval-expired:a-9");
  });

  it("interleaves all sources end-to-end", () => {
    const rows = buildTimeline({
      messages: [
        makeUser({ piiScanRunId: "scan-1" }),
        makeAssistant({ content: "Working on it…", status: "streaming" })
      ],
      pendingApprovals: [makeApproval({ approvalId: "a-1" })],
      approvalDecision: null,
      mcpServerEvents: [{ serverName: "github", status: "starting", error: null }],
      runtimeNotices: [
        {
          noticeId: "n-1",
          level: "info",
          title: "MCP fallback",
          message: "Switched server.",
          createdAt: "2026-05-09T10:01:00.000Z"
        }
      ]
    });
    expect(rows.map((r) => r.type)).toEqual([
      "user-message",
      "assistant-text",
      "approval",
      "mcp-server-status",
      "runtime-notice"
    ]);
    const userRow = rows[0] as UserMessageRow;
    expect(userRow.piiScanRunId).toBe("scan-1");
  });
});

// ---------------------------------------------------------------------------
// groupTimelineRows — the >=2-same-subtype boundary.
// ---------------------------------------------------------------------------

function makeShellRow(id: string): ShellCommandRow {
  return {
    type: "shell-command",
    rowId: `tool:${id}`,
    messageId: "m-asst",
    toolResultId: id,
    command: "ls",
    cwd: null,
    output: "",
    exitCode: 0,
    durationMs: 100,
    status: "completed"
  };
}

function makeMcpRow(id: string, status: ToolResult["status"] = "completed"): McpToolCallRow {
  return {
    type: "mcp-tool-call",
    rowId: `tool:${id}`,
    messageId: "m-asst",
    toolResultId: id,
    server: "github",
    toolName: "list_prs",
    input: "",
    output: "",
    durationMs: 250,
    status
  };
}

function makeArtifactWriteRow(id: string): ArtifactWriteRow {
  return {
    type: "artifact-write",
    rowId: `tool:${id}`,
    messageId: "m-asst",
    toolResultId: id,
    toolName: "write_artifact",
    input: "",
    output: "",
    status: "completed",
    durationMs: 50
  };
}

describe("groupTimelineRows", () => {
  it("does not group when count is below the threshold of 2", () => {
    const fragments = groupTimelineRows([makeShellRow("a")]);
    expect(fragments.map((f) => f.type)).toEqual(["shell-command"]);
  });

  it("groups exactly when count is the threshold of 2", () => {
    const fragments = groupTimelineRows([makeShellRow("a"), makeShellRow("b")]);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.type).toBe("group");
    const group = fragments[0] as TimelineGroup;
    expect(group.kind).toBe("shell-command");
    expect(group.rows.map((r) => r.toolResultId)).toEqual(["a", "b"]);
  });

  it("does not group across different subtypes — same kind only", () => {
    const fragments = groupTimelineRows([
      makeShellRow("a"),
      makeMcpRow("b"),
      makeShellRow("c")
    ]);
    // 1 shell + 1 mcp + 1 shell — no same-kind run reaches the threshold of 2.
    expect(fragments.map((f) => f.type)).toEqual([
      "shell-command",
      "mcp-tool-call",
      "shell-command"
    ]);
  });

  it("emits two separate groups when a non-groupable row breaks the run", () => {
    const fragments = groupTimelineRows([
      makeShellRow("a"),
      makeShellRow("b"),
      makeArtifactWriteRow("aw"),
      makeShellRow("c"),
      makeShellRow("d")
    ]);
    expect(fragments.map((f) => f.type)).toEqual([
      "group",
      "artifact-write",
      "group"
    ]);
  });

  it("never groups artifact-write rows even if N adjacent ones exist", () => {
    const fragments = groupTimelineRows([
      makeArtifactWriteRow("a"),
      makeArtifactWriteRow("b"),
      makeArtifactWriteRow("c")
    ]);
    expect(fragments.map((f) => f.type)).toEqual([
      "artifact-write",
      "artifact-write",
      "artifact-write"
    ]);
  });

  it("preserves non-groupable rows verbatim around groups", () => {
    const userRow: UserMessageRow = {
      type: "user-message",
      rowId: "u-1",
      messageId: "m-1",
      text: "go",
      piiScanRunId: null,
      createdAt: "2026-05-09T10:00:00.000Z"
    };
    const fragments = groupTimelineRows([
      userRow,
      makeMcpRow("a"),
      makeMcpRow("b"),
      makeMcpRow("c"),
      userRow
    ]);
    expect(fragments.map((f) => f.type)).toEqual([
      "user-message",
      "group",
      "user-message"
    ]);
  });

  it("summarizes a group correctly across mixed statuses", () => {
    const group: TimelineGroup = {
      type: "group",
      rowId: "g",
      kind: "mcp-tool-call",
      rows: [
        makeMcpRow("a", "completed"),
        makeMcpRow("b", "in_progress"),
        makeMcpRow("c", "failed"),
        makeMcpRow("d", "declined")
      ]
    };
    const summary = summarizeGroup(group);
    expect(summary.count).toBe(4);
    expect(summary.inProgress).toBe(1);
    expect(summary.failed).toBe(2); // failed + declined
    expect(summary.totalDurationMs).toBe(1000);
  });
});
