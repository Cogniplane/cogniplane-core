"use client";

import { useSessionData } from "./use-session-data";
import { useArtifacts } from "./use-artifacts";

export function useChatWorkspace(input: {
  selectedSessionId: string | null;
  onError: (message: string) => void;
}) {
  const { selectedSessionId, onError } = input;
  const sessionData = useSessionData({ selectedSessionId, onError });
  const artifactState = useArtifacts({
    selectedSessionId,
    artifacts: sessionData.artifacts,
    onError,
    onRefresh: async () => {
      if (selectedSessionId) await sessionData.refreshSessionData(selectedSessionId);
    }
  });

  return { ...sessionData, artifactState };
}
