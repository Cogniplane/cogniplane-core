import type { Approval } from "@cogniplane/shared-types";

// ---------------------------------------------------------------------------
// Chat-card row types.
//
// These are the row shapes the CopilotKit chat host still renders as cards
// (approvals, MCP-server status, runtime notices, plan). They outlived the
// activity-timeline UI removed in the Track B cutover — the timeline's row
// taxonomy, buildTimeline, and grouping went with it. Fed from custom AG-UI
// events (`use-agui-custom-events.ts`).
// ---------------------------------------------------------------------------

export type RuntimeNoticeLevel = "info" | "warning" | "error";

export type McpServerTransitionStatus = "starting" | "failed" | "cancelled";

export type ApprovalDecisionState = "pending" | "approving" | "rejecting";

// A user's verdict on a pending approval. `rememberForTurn` upgrades a plain
// "approve" into "allow every matching action for the rest of this turn" — the
// backend honors this flag on POST /approvals/:id/decision.
export type ApprovalDecision = {
  decision: "approve" | "reject";
  rememberForTurn?: boolean;
};

export type PlanRow = {
  type: "plan";
  rowId: string;
  messageId: string;
  text: string;
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

// A tool call that failed or was declined on the LIVE turn. CopilotKit's native
// tool card can't render failure (its render props expose no toolCallId to
// correlate with the tool_status CUSTOM event), so failures surface as a
// side-channel row instead. `server` comes from the companion tool_meta event
// when present (MCP tools); built-ins have none.
export type ToolStatusRow = {
  type: "tool-status";
  rowId: string;
  toolCallId: string;
  toolName: string;
  status: "failed" | "declined";
  server: string | null;
  durationMs: number | null;
};
