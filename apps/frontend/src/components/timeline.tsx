"use client";

import { ChevronDownIcon } from "lucide-react";

import {
  buildTimeline,
  groupTimelineRows,
  summarizeGroup,
  type ApprovalDecision,
  type GroupableKind,
  type TimelineFragment,
  type TimelineGroup,
  type TimelineInputs,
  type TimelineRow
} from "./timeline.logic";
import { formatElapsed } from "./timeline/shared";
import {
  AssistantTextRowView,
  PlanRowView,
  ReasoningRowView,
  UserMessageRowView
} from "./timeline/message-rows";
import { McpToolCallRowView, ShellCommandRowView } from "./timeline/tool-rows";
import { ArtifactReadRowView, ArtifactWriteRowView } from "./timeline/artifact-rows";
import { ApprovalRowView } from "./timeline/approval-row";
import {
  McpServerStatusRowView,
  PolicyBlockRowView,
  RuntimeErrorRowView,
  RuntimeNoticeRowView
} from "./timeline/status-rows";

// ---------------------------------------------------------------------------
// Group renderer.
// ---------------------------------------------------------------------------

const GROUP_KIND_LABEL: Record<GroupableKind, string> = {
  "shell-command": "shell commands",
  "mcp-tool-call": "tool calls",
  "artifact-read": "artifact reads"
};

function GroupView({
  group,
  onPreviewArtifact,
  onApprovalDecision
}: {
  group: TimelineGroup;
  onPreviewArtifact?: (artifactId: string) => void;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  const summary = summarizeGroup(group);
  const elapsed = formatElapsed(summary.totalDurationMs);
  const hasFailed = summary.failed > 0;
  const hasInProgress = summary.inProgress > 0;
  const open = hasInProgress;

  const headline = [
    `${summary.count} ${GROUP_KIND_LABEL[group.kind]}`,
    hasInProgress ? `${summary.inProgress} in progress` : null,
    hasFailed ? `${summary.failed} failed` : null,
    elapsed
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <details
      open={open}
      className={`group rounded-lg bg-surface-container-low p-3 ${hasFailed ? "ring-1 ring-danger-surface" : ""}`}
    >
      <summary className="flex cursor-pointer items-center gap-2 text-sm outline-none">
        <ChevronDownIcon className="size-4 -rotate-90 text-on-surface-faint transition-transform group-open:rotate-0" />
        <span className="font-medium text-on-surface">{headline}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-1.5">
        {group.rows.map((row) => (
          <RowView
            key={row.rowId}
            row={row}
            onPreviewArtifact={onPreviewArtifact}
            onApprovalDecision={onApprovalDecision}
          />
        ))}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Row dispatch.
// ---------------------------------------------------------------------------

function RowView({
  row,
  onPreviewArtifact,
  onApprovalDecision
}: {
  row: TimelineRow;
  onPreviewArtifact?: (artifactId: string) => void;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  switch (row.type) {
    case "user-message":
      return <UserMessageRowView row={row} />;
    case "assistant-text":
      return <AssistantTextRowView row={row} />;
    case "reasoning":
      return <ReasoningRowView row={row} />;
    case "plan":
      return <PlanRowView row={row} />;
    case "shell-command":
      return <ShellCommandRowView row={row} />;
    case "mcp-tool-call":
      return <McpToolCallRowView row={row} />;
    case "artifact-write":
      return <ArtifactWriteRowView row={row} onPreviewArtifact={onPreviewArtifact} />;
    case "artifact-read":
      return <ArtifactReadRowView row={row} />;
    case "approval":
      return <ApprovalRowView row={row} onDecision={onApprovalDecision} />;
    case "mcp-server-status":
      return <McpServerStatusRowView row={row} />;
    case "runtime-notice":
      return <RuntimeNoticeRowView row={row} />;
    case "policy-block":
      return <PolicyBlockRowView row={row} />;
    case "runtime-error":
      return <RuntimeErrorRowView row={row} />;
  }
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export type ActivityTimelineProps = TimelineInputs & {
  onPreviewArtifact?: (artifactId: string) => void;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
};

export function ActivityTimeline(props: ActivityTimelineProps) {
  const rows = buildTimeline({
    messages: props.messages,
    pendingApprovals: props.pendingApprovals,
    approvalDecision: props.approvalDecision,
    mcpServerEvents: props.mcpServerEvents,
    runtimeNotices: props.runtimeNotices
  });
  const fragments = groupTimelineRows(rows);

  return (
    <>
      {fragments.map((fragment) => (
        <FragmentView
          key={fragment.rowId}
          fragment={fragment}
          onPreviewArtifact={props.onPreviewArtifact}
          onApprovalDecision={props.onApprovalDecision}
        />
      ))}
    </>
  );
}

function FragmentView({
  fragment,
  onPreviewArtifact,
  onApprovalDecision
}: {
  fragment: TimelineFragment;
  onPreviewArtifact?: (artifactId: string) => void;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  if (fragment.type === "group") {
    return (
      <GroupView
        group={fragment}
        onPreviewArtifact={onPreviewArtifact}
        onApprovalDecision={onApprovalDecision}
      />
    );
  }
  return (
    <RowView
      row={fragment}
      onPreviewArtifact={onPreviewArtifact}
      onApprovalDecision={onApprovalDecision}
    />
  );
}
