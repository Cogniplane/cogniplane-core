"use client";

import { useEffect } from "react";

import type { Artifact } from "@cogniplane/shared-types";

import { useArtifacts } from "./use-artifacts";

export function useWorkspaceArtifacts(input: {
  selectedSessionId: string | null;
  artifacts: Artifact[];
  onError: (message: string) => void;
  refreshSessionData: (sessionId: string) => Promise<void>;
}) {
  const { selectedSessionId, artifacts, onError, refreshSessionData } = input;

  const artifactState = useArtifacts({
    selectedSessionId,
    artifacts,
    onError,
    onRefresh: async () => {
      if (selectedSessionId) {
        await refreshSessionData(selectedSessionId);
      }
    }
  });

  const { updateArtifactSelection } = artifactState;
  useEffect(() => {
    updateArtifactSelection(artifacts);
  }, [artifacts, updateArtifactSelection]);

  return {
    artifactState
  };
}
