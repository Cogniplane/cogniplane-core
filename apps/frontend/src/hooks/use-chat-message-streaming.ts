"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { streamMessage, type McpServerStatusEvent, type RuntimeNoticeEvent } from "../lib/streaming-api";
import { interruptSession } from "../lib/session-api";
import type { Approval, EffortLevel, Message } from "@cogniplane/shared-types";

import {
  buildOptimisticMessage,
  patchMessage as applyMessagePatch,
  patchToolResultOutput,
  updateMessageById as updateMessageCollectionById
} from "./chat-message-state";
import { createChatStreamHandlers } from "./chat-stream-handlers";
import { expiredApprovalIdFromNotice } from "./use-approval-state";

export function useChatMessageStreaming(input: {
  selectedSessionId: string | null;
  visibleSelectedArtifactIds: string[];
  onError: (message: string) => void;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  registerPendingApproval: (approval: Approval) => void;
  removePendingApproval: (approvalId: string) => void;
  refreshSessionData: (sessionId: string) => Promise<void>;
  invalidateInFlightSessionRefreshes: () => void;
  model: string;
  effort?: EffortLevel;
}) {
  const {
    selectedSessionId,
    visibleSelectedArtifactIds,
    onError,
    setMessages,
    registerPendingApproval,
    removePendingApproval,
    refreshSessionData,
    invalidateInFlightSessionRefreshes,
    model,
    effort
  } = input;

  const [isSending, setIsSending] = useState(false);
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null);
  const [mcpServerErrors, setMcpServerErrors] = useState<McpServerStatusEvent[]>([]);
  const [runtimeNotices, setRuntimeNotices] = useState<RuntimeNoticeEvent[]>([]);
  const lastSentTextRef = useRef<string | null>(null);
  const activeAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Abort any in-flight stream when the hook unmounts so the fetch, reader,
    // and handler closures release promptly instead of running to completion.
    return () => {
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
    };
  }, []);

  const updateMessageById = useCallback(
    (messageId: string, recipe: (message: Message) => Message): void => {
      setMessages((current) => updateMessageCollectionById(current, messageId, recipe));
    },
    [setMessages]
  );

  const patchMessage = useCallback(
    (messageId: string, patch: Partial<Message>): void => {
      setMessages((current) => applyMessagePatch(current, messageId, patch));
    },
    [setMessages]
  );

  const patchToolResult = useCallback(
    (messageId: string, toolResultId: string, delta: string): void => {
      setMessages((current) => patchToolResultOutput(current, messageId, toolResultId, delta));
    },
    [setMessages]
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (!selectedSessionId) {
        return;
      }

      lastSentTextRef.current = text;
      const sessionId = selectedSessionId;
      const userMessage = buildOptimisticMessage({
        sessionId,
        role: "user",
        status: "completed",
        content: text
      });
      const assistantMessage = buildOptimisticMessage({
        sessionId,
        role: "assistant",
        status: "pending",
        content: ""
      });

      invalidateInFlightSessionRefreshes();
      setMessages((current) => [...current, userMessage, assistantMessage]);
      setMcpServerErrors([]);
      setRuntimeNotices([]);
      setIsSending(true);
      setStreamingSessionId(sessionId);

      const controller = new AbortController();
      activeAbortRef.current?.abort();
      activeAbortRef.current = controller;

      try {
        const streamHandlers = createChatStreamHandlers({
          assistantMessageId: assistantMessage.messageId,
          optimisticUserMessageId: userMessage.messageId,
          patchMessage,
          updateMessageById,
          patchToolResult,
          registerPendingApproval,
          onMcpServerStatus: (event) => {
            if (event.status === "failed" || event.status === "cancelled") {
              setMcpServerErrors((current) => [...current, event]);
            }
          },
          onRuntimeNotice: (event) => {
            setRuntimeNotices((current) => [...current, event]);
            const expiredApprovalId = expiredApprovalIdFromNotice(event.noticeId);
            if (expiredApprovalId) {
              removePendingApproval(expiredApprovalId);
            }
          },
          refreshSessionData,
          sessionId,
          onError
        });

        await streamMessage({
          sessionId,
          text,
          artifactIds: visibleSelectedArtifactIds,
          model,
          effort,
          signal: controller.signal,
          ...streamHandlers
        });
      } catch (caughtError) {
        if (controller.signal.aborted) {
          // Unmount or caller-initiated abort — don't surface as a user-facing error.
          return;
        }
        const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
        onError(message);
        updateMessageById(assistantMessage.messageId, (entry) => ({
          ...entry,
          status: "error",
          content: entry.content || message,
          updatedAt: new Date().toISOString()
        }));
      } finally {
        // A superseded send's finally runs while the replacing send is still
        // streaming — only the owner of the active controller may reset state.
        if (activeAbortRef.current === controller) {
          activeAbortRef.current = null;
          setIsSending(false);
          setStreamingSessionId((current) => (current === sessionId ? null : current));
        }
      }
    },
    [
      model,
      effort,
      invalidateInFlightSessionRefreshes,
      onError,
      patchMessage,
      patchToolResult,
      refreshSessionData,
      registerPendingApproval,
      removePendingApproval,
      selectedSessionId,
      setMessages,
      updateMessageById,
      visibleSelectedArtifactIds
    ]
  );

  const retryLastMessage = useCallback(() => {
    const text = lastSentTextRef.current;
    if (!text || isSending) return;
    void sendMessage(text);
  }, [isSending, sendMessage]);

  // Stop button — asks the backend to interrupt the in-flight turn so the
  // partial assistant text persists with status="interrupted" and any token
  // usage observed so far is recorded for accounting. The local fetch is NOT
  // aborted: the SSE stream will deliver the terminal response.completed
  // event from the synthesized terminal frame, which lets the message land in
  // its final state and the read loop exit cleanly. Aborting locally would
  // race the persistence write and leave the message stuck in "streaming".
  const stopStreaming = useCallback(async () => {
    if (!streamingSessionId) return;
    try {
      await interruptSession(streamingSessionId);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [streamingSessionId, onError]);

  const dismissMcpServerError = useCallback((serverName: string) => {
    setMcpServerErrors((current) => current.filter((e) => e.serverName !== serverName));
  }, []);

  return {
    isSending,
    streamingSessionId,
    sendMessage,
    stopStreaming,
    retryLastMessage,
    mcpServerErrors,
    dismissMcpServerError,
    runtimeNotices
  };
}
