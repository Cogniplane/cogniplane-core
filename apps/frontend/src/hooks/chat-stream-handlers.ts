import type { Approval, Message, ToolResult } from "@cogniplane/shared-types";
import type {
  McpServerStatusEvent,
  MessageBlockedEvent,
  RuntimeNoticeEvent,
  StreamMessageHandlers
} from "../lib/streaming-api";

import { upsertToolResult } from "./chat-message-state";

export function createChatStreamHandlers(input: {
  assistantMessageId: string;
  optimisticUserMessageId: string;
  patchMessage: (messageId: string, patch: Partial<Message>) => void;
  updateMessageById: (messageId: string, recipe: (message: Message) => Message) => void;
  patchToolResult: (messageId: string, toolResultId: string, delta: string) => void;
  registerPendingApproval: (approval: Approval) => void;
  onMcpServerStatus: (event: McpServerStatusEvent) => void;
  onRuntimeNotice?: (event: RuntimeNoticeEvent) => void;
  onMessageBlocked?: (event: MessageBlockedEvent) => void;
  refreshSessionData: (sessionId: string) => Promise<void>;
  sessionId: string;
  onError: (message: string) => void;
}): StreamMessageHandlers {
  const {
    assistantMessageId,
    optimisticUserMessageId,
    patchMessage,
    updateMessageById,
    patchToolResult,
    registerPendingApproval,
    onMcpServerStatus,
    onRuntimeNotice,
    onMessageBlocked: onMessageBlockedCallback,
    refreshSessionData,
    sessionId,
    onError
  } = input;

  function applyToolResult(toolResult: ToolResult) {
    updateMessageById(assistantMessageId, (message) => ({
      ...message,
      toolResults: upsertToolResult(message.toolResults, toolResult),
      updatedAt: new Date().toISOString()
    }));
  }

  return {
    onCreated: () => {
      patchMessage(assistantMessageId, { status: "pending" });
    },
    onStatusChange: (status) => {
      patchMessage(assistantMessageId, { status });
    },
    onToolStarted: applyToolResult,
    onToolDelta: (toolResultId, delta) => {
      patchToolResult(assistantMessageId, toolResultId, delta);
    },
    onToolCompleted: applyToolResult,
    onApprovalRequired: (approval) => {
      registerPendingApproval(approval);
    },
    onMcpServerStatus,
    onRuntimeNotice,
    onUserMessageReplaced: (event) => {
      updateMessageById(optimisticUserMessageId, (message) => ({
        ...message,
        content: event.text,
        piiScanRunId: event.scanRunId,
        updatedAt: new Date().toISOString()
      }));
    },
    onMessageBlocked: (event) => {
      // Block mode never persists the raw user prompt; replace the optimistic
      // user bubble with the system "blocked" message so the UI matches what
      // the backend persisted.
      updateMessageById(optimisticUserMessageId, (message) => ({
        ...message,
        role: "system",
        content: event.message,
        updatedAt: new Date().toISOString()
      }));
      updateMessageById(assistantMessageId, (message) => ({
        ...message,
        status: "completed",
        content: "",
        updatedAt: new Date().toISOString()
      }));
      onMessageBlockedCallback?.(event);
    },
    onDelta: (delta) => {
      updateMessageById(assistantMessageId, (message) => ({
        ...message,
        status: "streaming",
        content: `${message.content}${delta}`,
        updatedAt: new Date().toISOString()
      }));
    },
    onReasoningDelta: (delta) => {
      updateMessageById(assistantMessageId, (message) => ({
        ...message,
        reasoningContent: `${message.reasoningContent}${delta}`,
        updatedAt: new Date().toISOString()
      }));
    },
    onReasoningSummaryDelta: (delta) => {
      updateMessageById(assistantMessageId, (message) => ({
        ...message,
        reasoningContent: `${message.reasoningContent}${delta}`,
        updatedAt: new Date().toISOString()
      }));
    },
    onPlanDelta: (delta) => {
      updateMessageById(assistantMessageId, (message) => ({
        ...message,
        planContent: `${message.planContent}${delta}`,
        updatedAt: new Date().toISOString()
      }));
    },
    onFailed: (message) => {
      updateMessageById(assistantMessageId, (currentMessage) => ({
        ...currentMessage,
        status: "error",
        content: currentMessage.content || message,
        updatedAt: new Date().toISOString()
      }));
    },
    onComplete: async (status, tokenUsage, costUsd, modelName) => {
      patchMessage(assistantMessageId, {
        status,
        tokenUsage: tokenUsage ?? null,
        costUsd: costUsd ?? null,
        modelName: modelName ?? null
      });

      try {
        await refreshSessionData(sessionId);
      } catch (caughtError) {
        onError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      }
    }
  };
}
