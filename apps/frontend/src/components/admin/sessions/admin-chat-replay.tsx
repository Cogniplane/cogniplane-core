"use client";

import { SafeMarkdown } from "../../safe-markdown";
import { summarizePiiRun } from "../../../lib/admin-session-pii-utils";
import {
  chatReplayStatusClass,
  indexPiiRuns,
  piiRunsForMessage
} from "./admin-chat-replay.logic";
import type {
  AdminSessionDetailMessage,
  AdminSessionDetailPiiRun
} from "@cogniplane/shared-types";
import { PILL_BLUE, HINT } from "../../../lib/ui-tokens";

const MESSAGE_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4 transition-colors";

const STATUS_BORDER: Record<string, string> = {
  pending: "border-l-4 border-l-accent",
  streaming: "border-l-4 border-l-accent",
  error: "border-l-4 border-l-danger",
  completed: ""
};

function formatTimeOfDay(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function PiiAnnotation(props: { runs: AdminSessionDetailPiiRun[] }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {props.runs.map((run) => (
        <details
          key={run.scanRunId}
          className="rounded-lg border border-outline-variant bg-surface-container-low p-2"
        >
          <summary className={`${PILL_BLUE} cursor-pointer`}>
            PII {run.status} — {summarizePiiRun(run)}
          </summary>
          <div className="mt-2 text-xs text-on-surface-variant">
            <p>
              Mode: {run.mode}
              {run.providerType ? ` · provider: ${run.providerType}` : ""}
              {run.actionTaken ? ` · action: ${run.actionTaken}` : ""}
            </p>
            {run.summaryText ? <p className="mt-1">{run.summaryText}</p> : null}
            {run.findings.length > 0 ? (
              <pre className="mt-1.5 overflow-auto text-[11px]">
                {JSON.stringify(run.findings, null, 2)}
              </pre>
            ) : null}
            {run.errorMessage ? <p className="mt-1">Error: {run.errorMessage}</p> : null}
          </div>
        </details>
      ))}
    </div>
  );
}

function MetaRight(props: { message: AdminSessionDetailMessage }) {
  const { message } = props;
  if (message.role !== "assistant") {
    return (
      <time className="text-xs text-on-surface-faint" dateTime={message.createdAt}>
        {formatTimeOfDay(message.createdAt)}
      </time>
    );
  }

  const tokens = message.totalTokens != null ? `${message.totalTokens} tok` : null;
  const cost = message.costUsd != null ? `$${message.costUsd.toFixed(4)}` : null;
  const meta = [message.modelName, tokens, cost].filter(Boolean).join(" · ");
  const statusClass = chatReplayStatusClass(message.status);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {meta ? <span className="text-xs text-on-surface-faint">{meta}</span> : null}
      <span
        className={`text-xs ${statusClass === "error" ? "text-danger" : "text-on-surface-variant"}`}
      >
        {message.status}
      </span>
      <time className="text-xs text-on-surface-faint" dateTime={message.createdAt}>
        {formatTimeOfDay(message.createdAt)}
      </time>
    </div>
  );
}

function ReplayMessageCard(props: {
  message: AdminSessionDetailMessage;
  piiRuns: AdminSessionDetailPiiRun[];
}) {
  const { message, piiRuns } = props;
  const role = message.role === "user" ? "user" : "assistant";
  const statusClass = chatReplayStatusClass(message.status);
  const userBg = role === "user" ? "bg-accent-soft/40" : "";

  return (
    <article
      id={`message-${message.messageId}`}
      className={`${MESSAGE_CARD} ${STATUS_BORDER[statusClass] ?? ""} ${userBg}`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
          {role === "user" ? "User" : "Agent"}
        </span>
        <MetaRight message={message} />
      </div>

      {role === "assistant" && message.reasoningContent ? (
        <details className="mb-2 rounded border border-outline-variant bg-surface-container-low p-2">
          <summary className="flex cursor-pointer items-center justify-between text-xs font-semibold text-on-surface-variant">
            <span>Thinking</span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <div className="mt-2 text-sm text-on-surface-variant">
            <SafeMarkdown>{message.reasoningContent}</SafeMarkdown>
          </div>
        </details>
      ) : null}

      {role === "assistant" && message.planContent ? (
        <details
          className="mb-2 rounded border border-outline-variant bg-surface-container-low p-2"
          open
        >
          <summary className="flex cursor-pointer items-center justify-between text-xs font-semibold text-on-surface-variant">
            <span>Plan</span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <div className="mt-2 text-sm text-on-surface-variant">
            <SafeMarkdown>{message.planContent}</SafeMarkdown>
          </div>
        </details>
      ) : null}

      <div className="text-sm text-on-surface">
        {role === "assistant" && message.contentText ? (
          <SafeMarkdown>{message.contentText}</SafeMarkdown>
        ) : (
          <p>{message.contentText || "(empty message)"}</p>
        )}
      </div>

      {piiRuns.length > 0 ? <PiiAnnotation runs={piiRuns} /> : null}
    </article>
  );
}

export function AdminChatReplay(props: {
  messages: AdminSessionDetailMessage[];
  piiRuns: AdminSessionDetailPiiRun[];
}) {
  const piiIndex = indexPiiRuns(props.piiRuns);

  if (props.messages.length === 0) {
    return <p className={HINT}>This session has no messages yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {props.messages.map((message) => (
        <ReplayMessageCard
          key={message.messageId}
          message={message}
          piiRuns={piiRunsForMessage(piiIndex, message)}
        />
      ))}
    </div>
  );
}
