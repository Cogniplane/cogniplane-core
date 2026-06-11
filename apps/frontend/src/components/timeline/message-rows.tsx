"use client";

import { ChevronDownIcon, ShieldAlertIcon } from "lucide-react";

import { SafeMarkdown } from "../safe-markdown";
import { STATUS_LABELS } from "../message-list.logic";
import { formatMessageTimestamp } from "../../lib/time-format";
import type {
  AssistantTextRow,
  PlanRow,
  ReasoningRow,
  UserMessageRow
} from "../timeline.logic";
import { CopyButton, FeedbackButtons, TokenUsageBadge } from "./shared";

export function UserMessageRowView({ row }: { row: UserMessageRow }) {
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

export function AssistantTextRowView({ row }: { row: AssistantTextRow }) {
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

export function ReasoningRowView({ row }: { row: ReasoningRow }) {
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

export function PlanRowView({ row }: { row: PlanRow }) {
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
