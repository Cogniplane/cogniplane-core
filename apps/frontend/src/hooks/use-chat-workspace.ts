"use client";

import { useEffect } from "react";

import { useApprovalState } from "./use-approval-state";
import { useSessionData } from "./use-session-data";
import { useWorkspaceArtifacts } from "./use-workspace-artifacts";

export function useChatWorkspace(input: {
  selectedSessionId: string | null;
  onError: (message: string) => void;
}) {
  const { selectedSessionId, onError } = input;

  // Live approvals now come from the AG-UI stream (useAguiCustomEvents inside
  // CopilotChatHost); this REST snapshot only seeds pendingApprovals at load and
  // on refresh for cross-session attention. replacePendingApprovals is the only
  // mutator still wired (via useSessionData).
  const { pendingApprovals, replacePendingApprovals } = useApprovalState({ onError });

  const {
    messages,
    artifacts,
    refreshSessionData,
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

  const { resetSelection } = artifactState;

  useEffect(() => {
    resetSelection();
  }, [resetSelection, selectedSessionId]);

  return {
    messages,
    artifacts,
    pendingApprovals,
    artifactState,
    refreshSessionData,
    isSessionDataReady
  };
}
