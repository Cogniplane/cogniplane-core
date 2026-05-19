"use client";

import Image from "next/image";
import React from "react";

import type { Approval, Message } from "@cogniplane/shared-types";
import type { McpServerStatusEvent, RuntimeNoticeEvent } from "../lib/streaming-api";

import { Button } from "@/components/ui/button";
import { ActivityTimeline } from "./timeline";
import { PROMPT_SUGGESTIONS, shouldShowRetry } from "./message-list.logic";

export function MessageList({
  messages,
  pendingApprovals,
  approvalDecisionId,
  mcpServerEvents,
  runtimeNotices,
  onApprovalDecision,
  onPreviewArtifact,
  onRetry,
  onSend,
  ref,
  selectedSessionId,
  children
}: {
  messages: Message[];
  pendingApprovals: Approval[];
  approvalDecisionId: string | null;
  mcpServerEvents: McpServerStatusEvent[];
  runtimeNotices: RuntimeNoticeEvent[];
  onApprovalDecision: (approvalId: string, decision: "approve" | "reject") => void;
  onPreviewArtifact?: (artifactId: string) => void;
  onRetry?: () => void;
  onSend?: (text: string) => void;
  ref: React.RefObject<HTMLElement | null>;
  selectedSessionId: string | null;
  children?: React.ReactNode;
}) {
  const showRetry = shouldShowRetry(messages, onRetry != null);
  const isEmpty = messages.length === 0;

  return (
    <section
      ref={ref}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface px-6 py-4"
    >
      <div className="mx-auto flex w-[min(860px,100%)] flex-1 flex-col gap-5">
        {children}
        {!isEmpty ? (
          <>
            <ActivityTimeline
              messages={messages}
              pendingApprovals={pendingApprovals}
              approvalDecisionId={approvalDecisionId}
              mcpServerEvents={mcpServerEvents}
              runtimeNotices={runtimeNotices}
              onApprovalDecision={onApprovalDecision}
              onPreviewArtifact={onPreviewArtifact}
            />
            {showRetry ? (
              <div className="flex justify-center py-2">
                <Button type="button" variant="outline" onClick={onRetry}>
                  Retry last message
                </Button>
              </div>
            ) : null}
          </>
        ) : selectedSessionId ? (
          <div className="flex flex-col items-center gap-4 rounded-xl bg-surface-container-lowest px-8 py-12 text-center shadow-sm">
            <Image src="/brand/cogniplane.svg" alt="" width={36} height={36} priority className="opacity-80" />
            <h2 className="text-xl font-semibold text-on-surface">What do you want to do?</h2>
            <p className="max-w-md text-sm text-on-surface-variant">
              Ask a question or describe a task. The runtime is ready and your approved skills are loaded.
            </p>
            <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
              {PROMPT_SUGGESTIONS.map(({ tag, prompt }) => (
                <button
                  type="button"
                  key={prompt}
                  onClick={() => onSend?.(prompt)}
                  className="group flex flex-col items-start gap-1 rounded-md border border-outline-variant bg-surface-container-low p-3 text-left text-sm transition-colors hover:border-primary-mid hover:bg-surface-container"
                >
                  <span className="text-[0.62rem] font-bold uppercase tracking-wider text-on-surface-faint group-hover:text-primary-mid">
                    {tag}
                  </span>
                  <span className="text-on-surface-variant group-hover:text-on-surface">{prompt}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl bg-surface-container-lowest p-8 text-center shadow-sm">
            <p className="mb-2 text-[0.62rem] font-bold uppercase tracking-wider text-on-surface-faint">
              No session selected
            </p>
            <h3 className="mb-2 text-lg font-semibold text-on-surface">Select or create a session</h3>
            <p className="text-sm text-on-surface-variant">
              Each session keeps its own message history, tool runs, and artifacts. Pick one from the sidebar or create a new one to begin.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
