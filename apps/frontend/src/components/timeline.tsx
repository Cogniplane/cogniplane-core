"use client";

import React, { useState } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardIcon,
  DownloadIcon,
  FileTextIcon,
  InfoIcon,
  ServerIcon,
  ShieldAlertIcon,
  TerminalIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  WrenchIcon,
  XCircleIcon
} from "lucide-react";

import type { Approval, MessageFeedbackRating, TokenUsage } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { SafeMarkdown } from "./safe-markdown";
import { submitMessageFeedback } from "../lib/message-feedback-api";
import {
  formatCostUsd,
  formatMessageTimestamp,
  formatTokenCount,
  STATUS_LABELS
} from "./message-list.logic";
import {
  buildTimeline,
  groupTimelineRows,
  summarizeGroup,
  type ApprovalRow,
  type ArtifactReadRow,
  type ArtifactWriteRow,
  type AssistantTextRow,
  type GroupableKind,
  type McpServerStatusRow,
  type McpToolCallRow,
  type PlanRow,
  type PolicyBlockRow,
  type ReasoningRow,
  type RuntimeErrorRow,
  type RuntimeNoticeRow,
  type ShellCommandRow,
  type TimelineFragment,
  type TimelineGroup,
  type TimelineInputs,
  type TimelineRow,
  type ToolCallRow,
  type UserMessageRow
} from "./timeline.logic";

// ---------------------------------------------------------------------------
// Common helpers and small atoms shared across rows.
// ---------------------------------------------------------------------------

const STATUS_BORDER: Record<ToolCallRow["status"], string> = {
  in_progress: "border-l-accent",
  completed: "border-l-outline-variant",
  failed: "border-l-danger",
  declined: "border-l-warning"
};

const STATUS_BADGE: Record<ToolCallRow["status"], string> = {
  in_progress: "bg-info-surface text-info",
  completed: "bg-success-surface text-success",
  failed: "bg-danger-surface text-danger",
  declined: "bg-warning-surface text-warning"
};

function statusBadgeLabel(status: ToolCallRow["status"]): string {
  return status === "in_progress" ? "running" : status === "completed" ? "ok" : status;
}

function formatElapsed(ms: number | null): string | null {
  if (ms == null || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      title={copied ? "Copied!" : "Copy to clipboard"}
      aria-label={copied ? "Copied!" : "Copy to clipboard"}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon className="text-success" /> : <ClipboardIcon />}
    </Button>
  );
}

function FeedbackButtons({
  messageId,
  initialRating
}: {
  messageId: string;
  initialRating: MessageFeedbackRating | null;
}) {
  const [rating, setRating] = useState<MessageFeedbackRating | null>(initialRating);
  const [submitting, setSubmitting] = useState(false);

  async function handleVote(next: MessageFeedbackRating) {
    if (submitting || rating === next) return;
    setRating(next);
    setSubmitting(true);
    try {
      await submitMessageFeedback(messageId, next);
    } catch {
      setRating(initialRating);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <span className="flex items-center" aria-label="Rate this response">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title="Good response"
        aria-pressed={rating === "thumbs_up"}
        disabled={submitting}
        onClick={() => void handleVote("thumbs_up")}
        className={rating === "thumbs_up" ? "text-success" : undefined}
      >
        <ThumbsUpIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title="Bad response"
        aria-pressed={rating === "thumbs_down"}
        disabled={submitting}
        onClick={() => void handleVote("thumbs_down")}
        className={rating === "thumbs_down" ? "text-danger" : undefined}
      >
        <ThumbsDownIcon />
      </Button>
    </span>
  );
}

function TokenUsageBadge({
  tokenUsage,
  costUsd,
  modelName
}: {
  tokenUsage: TokenUsage;
  costUsd: number | null;
  modelName: string | null;
}) {
  return (
    <span
      className="group relative inline-flex cursor-default items-center text-[0.7rem] font-medium text-on-surface-faint"
      aria-label={`${formatTokenCount(tokenUsage.totalTokens)} tokens`}
    >
      {formatTokenCount(tokenUsage.totalTokens)} tok
      <span
        role="tooltip"
        className="invisible absolute right-0 top-full z-10 mt-1 flex w-56 flex-col gap-1 rounded-md border border-outline-variant bg-popover p-3 text-xs text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100"
      >
        <span className="text-[0.62rem] font-bold uppercase tracking-wider text-on-surface-faint">
          Token usage
        </span>
        {modelName ? (
          <span className="flex justify-between gap-3">
            <span className="shrink-0">Model</span>
            <span className="break-all text-right font-mono">{modelName}</span>
          </span>
        ) : null}
        <span className="flex justify-between">
          <span>Input</span>
          <span>{formatTokenCount(tokenUsage.inputTokens)}</span>
        </span>
        {tokenUsage.cachedInputTokens > 0 ? (
          <span className="flex justify-between text-on-surface-variant">
            <span>Cached input</span>
            <span>{formatTokenCount(tokenUsage.cachedInputTokens)}</span>
          </span>
        ) : null}
        <span className="flex justify-between">
          <span>Output</span>
          <span>{formatTokenCount(tokenUsage.outputTokens)}</span>
        </span>
        {tokenUsage.reasoningOutputTokens > 0 ? (
          <span className="flex justify-between">
            <span>Reasoning</span>
            <span>{formatTokenCount(tokenUsage.reasoningOutputTokens)}</span>
          </span>
        ) : null}
        <span className="flex justify-between border-t border-outline-variant pt-1 font-semibold">
          <span>Total</span>
          <span>{formatTokenCount(tokenUsage.totalTokens)}</span>
        </span>
        {costUsd != null ? (
          <span className="flex justify-between font-semibold">
            <span>Cost</span>
            <span>{formatCostUsd(costUsd)}</span>
          </span>
        ) : null}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Per-row components.
// ---------------------------------------------------------------------------

function UserMessageRowView({ row }: { row: UserMessageRow }) {
  return (
    <article className="ml-auto max-w-[680px] rounded-lg bg-primary-container px-4 py-3 text-on-primary-container">
      <div className="mb-1 flex items-center justify-between gap-3 text-xs text-on-surface-faint">
        <span className="font-semibold uppercase tracking-wide">You</span>
        <time dateTime={row.createdAt} className="font-mono">
          {formatMessageTimestamp(row.createdAt)}
        </time>
      </div>
      <p className="m-0 whitespace-pre-wrap">{row.text}</p>
      {row.piiScanRunId ? (
        <div className="mt-2 flex items-center gap-1.5 text-[0.7rem] text-on-surface-faint">
          <ShieldAlertIcon className="size-3" />
          <span>This message was scanned and redacted before sending.</span>
        </div>
      ) : null}
    </article>
  );
}

function AssistantTextRowView({ row }: { row: AssistantTextRow }) {
  const isStreamingPlaceholder = !row.text && (row.status === "streaming" || row.status === "pending");
  const isError = row.status === "error";

  return (
    <article className="rounded-lg bg-surface-container-lowest p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-on-surface-faint">
        <span className="font-semibold uppercase tracking-wide">Agent</span>
        <div className="flex items-center gap-2">
          {row.text && row.status === "completed" ? (
            <>
              <FeedbackButtons messageId={row.messageId} initialRating={row.feedbackRating} />
              <CopyButton text={row.text} />
            </>
          ) : null}
          {row.tokenUsage ? (
            <TokenUsageBadge
              tokenUsage={row.tokenUsage}
              costUsd={row.costUsd}
              modelName={row.modelName}
            />
          ) : null}
          <span
            className={`rounded px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider ${
              row.status === "completed"
                ? "bg-success-surface text-success"
                : row.status === "error"
                  ? "bg-danger-surface text-danger"
                  : row.status === "interrupted"
                    ? "bg-warning-surface text-warning"
                    : "bg-info-surface text-info"
            }`}
          >
            {STATUS_LABELS[row.status]}
          </span>
          <time dateTime={row.createdAt} className="font-mono">
            {formatMessageTimestamp(row.createdAt)}
          </time>
        </div>
      </div>

      {row.text ? (
        <div className="prose prose-sm max-w-none text-on-surface">
          <SafeMarkdown>{row.text}</SafeMarkdown>
        </div>
      ) : isStreamingPlaceholder ? (
        <p className="m-0 text-on-surface-faint">…</p>
      ) : !isError ? (
        <p className="m-0 text-on-surface-faint">{statusFallbackText(row.status)}</p>
      ) : null}
    </article>
  );
}

function statusFallbackText(status: AssistantTextRow["status"]): string {
  switch (status) {
    case "interrupted":
      return "Stopped before the assistant finished.";
    default:
      return "";
  }
}

function ReasoningRowView({ row }: { row: ReasoningRow }) {
  return (
    <details className="group rounded-md bg-surface-container-low p-3">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-on-surface-variant outline-none">
        <ChevronDownIcon className="size-3 -rotate-90 transition-transform group-open:rotate-0" />
        <span>Thinking</span>
      </summary>
      <div className="mt-2 prose prose-sm max-w-none text-on-surface-variant">
        <SafeMarkdown>{row.text}</SafeMarkdown>
      </div>
    </details>
  );
}

function PlanRowView({ row }: { row: PlanRow }) {
  return (
    <details open className="group rounded-md border border-accent/20 bg-accent-soft p-3">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-accent outline-none">
        <ChevronDownIcon className="size-3 -rotate-90 transition-transform group-open:rotate-0" />
        <span>Plan</span>
      </summary>
      <div className="mt-2 prose prose-sm max-w-none">
        <SafeMarkdown>{row.text}</SafeMarkdown>
      </div>
    </details>
  );
}

function ShellCommandRowView({ row }: { row: ShellCommandRow }) {
  const elapsed = formatElapsed(row.durationMs);
  const open = row.status === "in_progress" || row.status === "failed";

  return (
    <details
      open={open}
      className={`group rounded-md border-l-2 bg-surface-container-low pl-3 pr-2 py-2 ${STATUS_BORDER[row.status]}`}
    >
      <summary className="flex cursor-pointer items-center gap-2 text-sm outline-none">
        <ChevronDownIcon className="size-3 -rotate-90 text-on-surface-faint transition-transform group-open:rotate-0" />
        <TerminalIcon className="size-3 shrink-0 text-on-surface-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-on-surface">
          {row.command || "shell command"}
        </span>
        {elapsed ? (
          <span className="shrink-0 font-mono text-[0.7rem] text-on-surface-faint">{elapsed}</span>
        ) : null}
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider ${STATUS_BADGE[row.status]}`}
        >
          {statusBadgeLabel(row.status)}
        </span>
      </summary>
      <div className="mt-2 overflow-x-auto">
        <pre className="whitespace-pre-wrap break-all font-mono text-[0.78rem] leading-snug text-on-surface-variant">
          {row.cwd ? `cwd: ${row.cwd}\n` : ""}
          {row.command}
          {row.output ? `\n\n${row.output}` : ""}
          {row.exitCode != null ? `\n\nexit code: ${row.exitCode}` : ""}
        </pre>
      </div>
    </details>
  );
}

function McpToolCallRowView({ row }: { row: McpToolCallRow }) {
  const elapsed = formatElapsed(row.durationMs);
  const open = row.status === "in_progress" || row.status === "failed";

  const label = `${row.toolName ?? "tool"}${row.server ? ` @ ${row.server}` : ""}`;

  return (
    <details
      open={open}
      className={`group rounded-md border-l-2 bg-surface-container-low pl-3 pr-2 py-2 ${STATUS_BORDER[row.status]}`}
    >
      <summary className="flex cursor-pointer items-center gap-2 text-sm outline-none">
        <ChevronDownIcon className="size-3 -rotate-90 text-on-surface-faint transition-transform group-open:rotate-0" />
        <WrenchIcon className="size-3 shrink-0 text-on-surface-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-on-surface">{label}</span>
        {elapsed ? (
          <span className="shrink-0 font-mono text-[0.7rem] text-on-surface-faint">{elapsed}</span>
        ) : null}
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider ${STATUS_BADGE[row.status]}`}
        >
          {statusBadgeLabel(row.status)}
        </span>
      </summary>
      <div className="mt-2 overflow-x-auto">
        <pre className="whitespace-pre-wrap break-all font-mono text-[0.78rem] leading-snug text-on-surface-variant">
          {row.input ? `${row.input}\n\n` : ""}
          {row.output}
        </pre>
      </div>
    </details>
  );
}

function ArtifactWriteRowView({
  row,
  onPreviewArtifact
}: {
  row: ArtifactWriteRow;
  onPreviewArtifact?: (artifactId: string) => void;
}) {
  const artifactId = parseArtifactIdFromOutput(row.output);
  const artifactName = parseArtifactNameFromInput(row.input) ?? row.toolName;
  const isWorking = row.status === "in_progress";
  const isFailed = row.status === "failed" || row.status === "declined";

  return (
    <article
      className={`flex items-center gap-3 rounded-md border bg-surface-container-low px-3 py-2.5 ${
        isFailed ? "border-danger/40" : "border-outline-variant"
      }`}
    >
      <FileTextIcon className="size-4 shrink-0 text-on-surface-faint" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium text-on-surface">
          <span className="truncate">{isWorking ? "Preparing artifact…" : artifactName}</span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider ${STATUS_BADGE[row.status]}`}
          >
            {statusBadgeLabel(row.status)}
          </span>
        </div>
        {isFailed && row.output ? (
          <p className="mt-1 text-xs text-danger">{row.output.slice(0, 200)}</p>
        ) : null}
      </div>
      {!isWorking && !isFailed && artifactId && onPreviewArtifact ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPreviewArtifact(artifactId)}
        >
          <DownloadIcon />
          Preview
        </Button>
      ) : null}
    </article>
  );
}

function ArtifactReadRowView({ row }: { row: ArtifactReadRow }) {
  const artifactId = parseArtifactIdFromInput(row.input);
  const elapsed = formatElapsed(row.durationMs);

  return (
    <details className={`group rounded-md border-l-2 bg-surface-container-low pl-3 pr-2 py-2 ${STATUS_BORDER[row.status]}`}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm outline-none">
        <ChevronDownIcon className="size-3 -rotate-90 text-on-surface-faint transition-transform group-open:rotate-0" />
        <FileTextIcon className="size-3 shrink-0 text-on-surface-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-on-surface">
          {row.toolName}
          {artifactId ? `: ${artifactId}` : ""}
        </span>
        {elapsed ? (
          <span className="shrink-0 font-mono text-[0.7rem] text-on-surface-faint">{elapsed}</span>
        ) : null}
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider ${STATUS_BADGE[row.status]}`}
        >
          {statusBadgeLabel(row.status)}
        </span>
      </summary>
      <div className="mt-2 overflow-x-auto">
        <pre className="whitespace-pre-wrap break-all font-mono text-[0.78rem] leading-snug text-on-surface-variant">
          {previewOutput(row.output)}
        </pre>
      </div>
    </details>
  );
}

const ARTIFACT_READ_PREVIEW_LINES = 20;

function previewOutput(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= ARTIFACT_READ_PREVIEW_LINES) return output;
  return `${lines.slice(0, ARTIFACT_READ_PREVIEW_LINES).join("\n")}\n…`;
}

function parseArtifactIdFromOutput(output: string): string | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const id = parsed["artifactId"] ?? parsed["id"];
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function parseArtifactNameFromInput(input: string): string | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const name = parsed["name"] ?? parsed["fileName"] ?? parsed["filename"];
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

function parseArtifactIdFromInput(input: string): string | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const id = parsed["artifactId"] ?? parsed["id"];
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function ApprovalRowView({
  row,
  onDecision
}: {
  row: ApprovalRow;
  onDecision: (approvalId: string, decision: "approve" | "reject") => void;
}) {
  const working = row.decisionState === "approving" || row.decisionState === "rejecting";

  return (
    <article
      role="alert"
      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-warning/30 bg-warning-surface/20 px-4 py-3"
    >
      <div
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-warning-surface text-warning"
      >
        <AlertTriangleIcon className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[0.64rem] font-extrabold uppercase tracking-[0.14em] text-warning">
          Approval needed · {kindLabel(row.kind)}
        </div>
        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-bold text-on-surface">
          {row.title}
        </div>
        {row.summary ? (
          <div className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-on-surface-variant">
            {row.summary}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={working}
          onClick={() => onDecision(row.approvalId, "reject")}
        >
          Reject
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={working}
          onClick={() => onDecision(row.approvalId, "approve")}
        >
          {working ? "Working…" : "Approve"}
        </Button>
      </div>
    </article>
  );
}

function kindLabel(kind: Approval["kind"]): string {
  switch (kind) {
    case "command_execution":
      return "Shell command";
    case "file_change":
      return "File change";
    case "permissions":
      return "Permission request";
    default:
      return "Approval";
  }
}

function McpServerStatusRowView({ row }: { row: McpServerStatusRow }) {
  const isFailed = row.status === "failed";
  return (
    <article
      className={`flex items-center gap-3 rounded-md border px-3 py-2 ${
        isFailed
          ? "border-danger/30 bg-danger-surface/20 text-on-surface"
          : "border-outline-variant bg-surface-container-low text-on-surface-variant"
      }`}
    >
      <ServerIcon className={`size-4 shrink-0 ${isFailed ? "text-danger" : "text-on-surface-faint"}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          {row.serverName} · {row.status}
        </div>
        {row.error ? (
          <div className="mt-0.5 truncate font-mono text-xs text-on-surface-faint">{row.error}</div>
        ) : null}
      </div>
    </article>
  );
}

function RuntimeNoticeRowView({ row }: { row: RuntimeNoticeRow }) {
  const Icon = row.level === "error" ? XCircleIcon : row.level === "warning" ? AlertTriangleIcon : InfoIcon;
  const tone =
    row.level === "error"
      ? "border-danger/30 bg-danger-surface/20 text-on-surface"
      : row.level === "warning"
        ? "border-warning/30 bg-warning-surface/20 text-on-surface"
        : "border-outline-variant bg-surface-container-low text-on-surface-variant";
  const open = row.level !== "info";

  return (
    <details open={open} className={`group rounded-md border px-3 py-2 ${tone}`}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm outline-none">
        <ChevronDownIcon className="size-3 -rotate-90 transition-transform group-open:rotate-0" />
        <Icon className="size-4 shrink-0" />
        <span className="font-semibold">{row.title}</span>
      </summary>
      <p className="mt-1 ml-6 text-xs text-on-surface-variant">{row.message}</p>
    </details>
  );
}

function PolicyBlockRowView({ row }: { row: PolicyBlockRow }) {
  return (
    <article
      role="alert"
      className="flex items-start gap-3 rounded-md border border-danger/30 bg-danger-surface/20 px-4 py-3"
    >
      <ShieldAlertIcon className="size-5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <div className="text-[0.64rem] font-extrabold uppercase tracking-[0.14em] text-danger">
          Policy block · {row.blockReason}
        </div>
        <p className="mt-1 text-sm text-on-surface">{row.message}</p>
      </div>
    </article>
  );
}

function RuntimeErrorRowView({ row }: { row: RuntimeErrorRow }) {
  return (
    <article
      role="alert"
      className="flex items-start gap-3 rounded-md border border-danger/30 bg-danger-surface/20 px-4 py-3"
    >
      <XCircleIcon className="size-5 shrink-0 text-danger" />
      <p className="m-0 text-sm text-on-surface">{row.message}</p>
    </article>
  );
}

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
  onApprovalDecision: (approvalId: string, decision: "approve" | "reject") => void;
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
  onApprovalDecision: (approvalId: string, decision: "approve" | "reject") => void;
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
  onApprovalDecision: (approvalId: string, decision: "approve" | "reject") => void;
};

export function ActivityTimeline(props: ActivityTimelineProps) {
  const rows = buildTimeline({
    messages: props.messages,
    pendingApprovals: props.pendingApprovals,
    approvalDecisionId: props.approvalDecisionId,
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
  onApprovalDecision: (approvalId: string, decision: "approve" | "reject") => void;
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
