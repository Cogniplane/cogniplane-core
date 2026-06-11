"use client";

import { useState } from "react";
import { CheckIcon, ClipboardIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";

import type { MessageFeedbackRating, TokenUsage } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { submitMessageFeedback } from "../../lib/message-feedback-api";
import { formatCostUsd, formatTokenCount } from "../message-list.logic";
import type { ToolCallRow } from "../timeline.logic";

// ---------------------------------------------------------------------------
// Common helpers and small atoms shared across timeline rows.
// ---------------------------------------------------------------------------

export const STATUS_BORDER: Record<ToolCallRow["status"], string> = {
  in_progress: "border-l-accent",
  completed: "border-l-outline-variant",
  failed: "border-l-danger",
  declined: "border-l-warning"
};

export const STATUS_BADGE: Record<ToolCallRow["status"], string> = {
  in_progress: "bg-info-surface text-info",
  completed: "bg-success-surface text-success",
  failed: "bg-danger-surface text-danger",
  declined: "bg-warning-surface text-warning"
};

export function statusBadgeLabel(status: ToolCallRow["status"]): string {
  return status === "in_progress" ? "running" : status === "completed" ? "ok" : status;
}

export function formatElapsed(ms: number | null): string | null {
  if (ms == null || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function CopyButton({ text }: { text: string }) {
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

export function FeedbackButtons({
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

export function TokenUsageBadge({
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
