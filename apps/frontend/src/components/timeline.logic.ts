import type { Approval, Message, ToolResult } from "@cogniplane/shared-types";

// ---------------------------------------------------------------------------
// Activity timeline taxonomy.
// Spec: docs/design/activity-timeline-taxonomy.md
//
// `buildTimeline` is the only entry point. It is pure: it takes the chat
// state the host already has (messages, pending approvals, transient runtime
// notices and MCP server transitions) and produces an ordered list of typed
// rows. The renderer walks the list and emits a component per row.
// ---------------------------------------------------------------------------

export type ToolRowKind =
  | "shell-command"
  | "mcp-tool-call"
  | "artifact-write"
  | "artifact-read";

export type RuntimeNoticeLevel = "info" | "warning" | "error";

export type McpServerTransitionStatus = "starting" | "failed" | "cancelled";

export type ApprovalDecisionState = "pending" | "approving" | "rejecting";

// Concrete row variants. Discriminated by `type`.

export type UserMessageRow = {
  type: "user-message";
  rowId: string;
  messageId: string;
  text: string;
  piiScanRunId: string | null;
  createdAt: string;
};

export type AssistantTextRow = {
  type: "assistant-text";
  rowId: string;
  messageId: string;
  text: string;
  status: Message["status"];
  tokenUsage: Message["tokenUsage"];
  costUsd: Message["costUsd"];
  modelName: Message["modelName"];
  feedbackRating: Message["feedbackRating"];
  createdAt: string;
};

export type ReasoningRow = {
  type: "reasoning";
  rowId: string;
  messageId: string;
  text: string;
};

export type PlanRow = {
  type: "plan";
  rowId: string;
  messageId: string;
  text: string;
};

export type ShellCommandRow = {
  type: "shell-command";
  rowId: string;
  messageId: string;
  toolResultId: string;
  command: string;
  cwd: string | null;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
  status: ToolResult["status"];
};

export type McpToolCallRow = {
  type: "mcp-tool-call";
  rowId: string;
  messageId: string;
  toolResultId: string;
  server: string | null;
  toolName: string | null;
  input: string;
  output: string;
  durationMs: number | null;
  status: ToolResult["status"];
};

export type ArtifactWriteRow = {
  type: "artifact-write";
  rowId: string;
  messageId: string;
  toolResultId: string;
  toolName: string;
  input: string;
  output: string;
  status: ToolResult["status"];
  durationMs: number | null;
};

export type ArtifactReadRow = {
  type: "artifact-read";
  rowId: string;
  messageId: string;
  toolResultId: string;
  toolName: string;
  input: string;
  output: string;
  status: ToolResult["status"];
  durationMs: number | null;
};

export type ApprovalRow = {
  type: "approval";
  rowId: string;
  approvalId: string;
  itemId: string;
  kind: Approval["kind"];
  title: string;
  summary: string;
  status: Approval["status"];
  decisionState: ApprovalDecisionState;
};

export type McpServerStatusRow = {
  type: "mcp-server-status";
  rowId: string;
  serverName: string;
  status: McpServerTransitionStatus;
  error: string | null;
};

export type RuntimeNoticeRow = {
  type: "runtime-notice";
  rowId: string;
  noticeId: string;
  level: RuntimeNoticeLevel;
  title: string;
  message: string;
  createdAt: string;
};

export type RuntimeErrorRow = {
  type: "runtime-error";
  rowId: string;
  messageId: string;
  message: string;
};

export type PolicyBlockRow = {
  type: "policy-block";
  rowId: string;
  messageId: string;
  blockReason: string;
  message: string;
  scanRunId: string | null;
};

export type ToolCallRow =
  | ShellCommandRow
  | McpToolCallRow
  | ArtifactWriteRow
  | ArtifactReadRow;

export type TimelineRow =
  | UserMessageRow
  | AssistantTextRow
  | ReasoningRow
  | PlanRow
  | ToolCallRow
  | ApprovalRow
  | McpServerStatusRow
  | RuntimeNoticeRow
  | RuntimeErrorRow
  | PolicyBlockRow;

// ---------------------------------------------------------------------------
// Inputs.
// ---------------------------------------------------------------------------

export type McpServerEventInput = {
  serverName: string;
  status: "starting" | "ready" | "failed" | "cancelled";
  error: string | null;
};

export type RuntimeNoticeInput = {
  noticeId: string;
  level: RuntimeNoticeLevel;
  title: string;
  message: string;
  createdAt: string;
};

export type TimelineInputs = {
  messages: Message[];
  pendingApprovals: Approval[];
  approvalDecisionId: string | null;
  mcpServerEvents: McpServerEventInput[];
  runtimeNotices: RuntimeNoticeInput[];
};

// ---------------------------------------------------------------------------
// Tool-call classification.
// ---------------------------------------------------------------------------

const FRAMEWORK_SERVER_NAMES = new Set(["framework", "cogniplane"]);

const ARTIFACT_WRITE_TOOLS = new Set(["write_artifact"]);

const ARTIFACT_READ_TOOLS = new Set([
  "read_text_artifact",
  "read_artifact",
  "list_artifacts"
]);

export function classifyToolRow(toolResult: ToolResult): ToolRowKind {
  if (toolResult.kind === "command") return "shell-command";

  const server = toolResult.server?.toLowerCase() ?? "";
  const toolName = toolResult.toolName ?? "";
  if (FRAMEWORK_SERVER_NAMES.has(server)) {
    if (ARTIFACT_WRITE_TOOLS.has(toolName)) return "artifact-write";
    if (ARTIFACT_READ_TOOLS.has(toolName)) return "artifact-read";
  }
  return "mcp-tool-call";
}

function toolResultToRow(messageId: string, toolResult: ToolResult): ToolCallRow {
  const rowId = `tool:${toolResult.toolResultId}`;
  const kind = classifyToolRow(toolResult);

  if (kind === "shell-command") {
    return {
      type: "shell-command",
      rowId,
      messageId,
      toolResultId: toolResult.toolResultId,
      command: toolResult.command ?? "",
      cwd: toolResult.cwd,
      output: toolResult.output,
      exitCode: toolResult.exitCode,
      durationMs: toolResult.durationMs,
      status: toolResult.status
    };
  }

  if (kind === "artifact-write") {
    return {
      type: "artifact-write",
      rowId,
      messageId,
      toolResultId: toolResult.toolResultId,
      toolName: toolResult.toolName ?? "write_artifact",
      input: toolResult.input,
      output: toolResult.output,
      status: toolResult.status,
      durationMs: toolResult.durationMs
    };
  }

  if (kind === "artifact-read") {
    return {
      type: "artifact-read",
      rowId,
      messageId,
      toolResultId: toolResult.toolResultId,
      toolName: toolResult.toolName ?? "read_artifact",
      input: toolResult.input,
      output: toolResult.output,
      status: toolResult.status,
      durationMs: toolResult.durationMs
    };
  }

  return {
    type: "mcp-tool-call",
    rowId,
    messageId,
    toolResultId: toolResult.toolResultId,
    server: toolResult.server,
    toolName: toolResult.toolName,
    input: toolResult.input,
    output: toolResult.output,
    durationMs: toolResult.durationMs,
    status: toolResult.status
  };
}

// ---------------------------------------------------------------------------
// Per-message row derivation.
// ---------------------------------------------------------------------------

export function messageToRows(message: Message): TimelineRow[] {
  if (message.role === "user") {
    return [
      {
        type: "user-message",
        rowId: `user:${message.messageId}`,
        messageId: message.messageId,
        text: message.content,
        piiScanRunId: message.piiScanRunId ?? null,
        createdAt: message.createdAt
      }
    ];
  }

  if (message.role === "system") {
    // Today the only "system" role bubble is the policy-block synthetic
    // message produced by `chat-stream-handlers.ts.onMessageBlocked`. Detect
    // it via a marker on the content; for v1 we treat any system message as
    // a policy block since there is no other source.
    return [
      {
        type: "policy-block",
        rowId: `block:${message.messageId}`,
        messageId: message.messageId,
        blockReason: "blocked",
        message: message.content,
        scanRunId: null
      }
    ];
  }

  // Assistant.
  const rows: TimelineRow[] = [];

  if (message.reasoningContent) {
    rows.push({
      type: "reasoning",
      rowId: `reasoning:${message.messageId}`,
      messageId: message.messageId,
      text: message.reasoningContent
    });
  }

  if (message.planContent) {
    rows.push({
      type: "plan",
      rowId: `plan:${message.messageId}`,
      messageId: message.messageId,
      text: message.planContent
    });
  }

  for (const toolResult of message.toolResults) {
    rows.push(toolResultToRow(message.messageId, toolResult));
  }

  const hasAnyContent = message.content.length > 0;
  const isError = message.status === "error";
  const showAssistantText =
    hasAnyContent || (rows.length === 0 && !isError);

  if (showAssistantText) {
    rows.push({
      type: "assistant-text",
      rowId: `assistant:${message.messageId}`,
      messageId: message.messageId,
      text: message.content,
      status: message.status,
      tokenUsage: message.tokenUsage,
      costUsd: message.costUsd,
      modelName: message.modelName,
      feedbackRating: message.feedbackRating,
      createdAt: message.createdAt
    });
  }

  if (isError) {
    rows.push({
      type: "runtime-error",
      rowId: `error:${message.messageId}`,
      messageId: message.messageId,
      message: message.content || "The assistant response failed."
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Approval / mcp-server / runtime-notice projection (v1: tail-appended).
// ---------------------------------------------------------------------------

function approvalRow(approval: Approval, decisionState: ApprovalDecisionState): ApprovalRow {
  return {
    type: "approval",
    rowId: `approval:${approval.approvalId}`,
    approvalId: approval.approvalId,
    itemId: approval.itemId,
    kind: approval.kind,
    title: approval.title,
    summary: approval.summary,
    status: approval.status,
    decisionState
  };
}

function mcpServerStatusRow(event: McpServerEventInput, index: number): McpServerStatusRow | null {
  // `ready` is the resolved/healthy state; we don't render it as a row since
  // a tool call landing on the server is itself the success signal.
  if (event.status === "ready") return null;
  return {
    type: "mcp-server-status",
    rowId: `mcp-status:${event.serverName}:${index}`,
    serverName: event.serverName,
    status: event.status,
    error: event.error
  };
}

function runtimeNoticeRow(notice: RuntimeNoticeInput): RuntimeNoticeRow {
  return {
    type: "runtime-notice",
    rowId: `notice:${notice.noticeId}`,
    noticeId: notice.noticeId,
    level: notice.level,
    title: notice.title,
    message: notice.message,
    createdAt: notice.createdAt
  };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export function buildTimeline(inputs: TimelineInputs): TimelineRow[] {
  const rows: TimelineRow[] = [];

  for (const message of inputs.messages) {
    rows.push(...messageToRows(message));
  }

  // V1 tail-append: pending approvals, then transient mcp-server transitions,
  // then runtime notices. They render at the end of the timeline because we
  // don't have createdAt timestamps on these inputs; they belong to the
  // currently-streaming turn.
  for (const approval of inputs.pendingApprovals) {
    const decisionState: ApprovalDecisionState =
      inputs.approvalDecisionId === approval.approvalId ? "approving" : "pending";
    rows.push(approvalRow(approval, decisionState));
  }

  inputs.mcpServerEvents.forEach((event, index) => {
    const row = mcpServerStatusRow(event, index);
    if (row) rows.push(row);
  });

  for (const notice of inputs.runtimeNotices) {
    rows.push(runtimeNoticeRow(notice));
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Grouping (render-time helper).
// Walks a row list and emits a flat list of group placeholders interleaved
// with ungrouped rows. Groups only form when 3+ adjacent rows share the same
// tool-row subtype. ArtifactWriteRow is intentionally excluded — it's the
// "important event" type.
// ---------------------------------------------------------------------------

export type TimelineGroup = {
  type: "group";
  rowId: string;
  kind: GroupableKind;
  rows: ToolCallRow[];
};

export type GroupableKind = "shell-command" | "mcp-tool-call" | "artifact-read";

export type TimelineFragment = TimelineRow | TimelineGroup;

const GROUPABLE: ReadonlySet<GroupableKind> = new Set([
  "shell-command",
  "mcp-tool-call",
  "artifact-read"
]);

const GROUP_THRESHOLD = 2;

function isGroupable(row: TimelineRow): row is ToolCallRow & { type: GroupableKind } {
  return GROUPABLE.has(row.type as GroupableKind);
}

export function groupTimelineRows(rows: TimelineRow[]): TimelineFragment[] {
  const fragments: TimelineFragment[] = [];
  let i = 0;

  while (i < rows.length) {
    const row = rows[i]!;
    if (!isGroupable(row)) {
      fragments.push(row);
      i += 1;
      continue;
    }

    const kind = row.type;
    let j = i + 1;
    while (j < rows.length) {
      const next = rows[j]!;
      if (!isGroupable(next) || next.type !== kind) break;
      j += 1;
    }

    const run = rows.slice(i, j) as ToolCallRow[];
    if (run.length >= GROUP_THRESHOLD) {
      fragments.push({
        type: "group",
        rowId: `group:${kind}:${run[0]!.rowId}`,
        kind,
        rows: run
      });
    } else {
      for (const r of run) fragments.push(r);
    }
    i = j;
  }

  return fragments;
}

// Group summary helpers used by both the renderer and tests.

export function summarizeGroup(group: TimelineGroup): {
  count: number;
  inProgress: number;
  failed: number;
  totalDurationMs: number;
} {
  let inProgress = 0;
  let failed = 0;
  let totalDurationMs = 0;
  for (const row of group.rows) {
    if (row.status === "in_progress") inProgress += 1;
    if (row.status === "failed" || row.status === "declined") failed += 1;
    totalDurationMs += row.durationMs ?? 0;
  }
  return { count: group.rows.length, inProgress, failed, totalDurationMs };
}
