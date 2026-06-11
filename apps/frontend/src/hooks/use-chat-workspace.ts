"use client";

import { useEffect } from "react";

import { useApprovalState } from "./use-approval-state";
import { useChatMessageStreaming } from "./use-chat-message-streaming";
import { useSessionData } from "./use-session-data";
import { useWorkspaceArtifacts } from "./use-workspace-artifacts";

export function useChatWorkspace(input: {
  selectedSessionId: string | null;
  onError: (message: string) => void;
  model: string;
  effort?: import("@cogniplane/shared-types").EffortLevel;
}) {
  const { selectedSessionId, onError, model, effort } = input;

  const {
    pendingApprovals,
    approvalDecision,
    replacePendingApprovals,
    registerPendingApproval,
    removePendingApproval,
    handleApprovalDecision
  } = useApprovalState({ onError });

  const {
    messages,
    setMessages,
    artifacts,
    refreshSessionData,
    invalidateInFlightSessionRefreshes,
    isSessionDataReady
  } = useSessionData({
    selectedSessionId,
    onError,
    replacePendingApprovals
  });

  const { artifactState } = useWorkspaceArtifacts({
    selectedSessionId,
    artifacts,
    onError,
    refreshSessionData
  });

  const { isSending, streamingSessionId, sendMessage, stopStreaming, retryLastMessage, mcpServerErrors, dismissMcpServerError, runtimeNotices } = useChatMessageStreaming({
    selectedSessionId,
    visibleSelectedArtifactIds: artifactState.visibleSelectedArtifactIds,
    onError,
    setMessages,
    registerPendingApproval,
    removePendingApproval,
    refreshSessionData,
    invalidateInFlightSessionRefreshes,
    model,
    effort
  });

  const { resetSelection } = artifactState;

  useEffect(() => {
    resetSelection();
  }, [resetSelection, selectedSessionId]);

  return {
    messages,
    artifacts,
    pendingApprovals,
    approvalDecision,
    handleApprovalDecision,
    artifactState,
    isSending,
    streamingSessionId,
    sendMessage,
    stopStreaming,
    retryLastMessage,
    mcpServerErrors,
    dismissMcpServerError,
    runtimeNotices,
    refreshSessionData,
    isSessionDataReady
  };
}
