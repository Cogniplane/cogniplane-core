"use client";

import { useState, useMemo, useCallback } from "react";

import { uploadArtifact } from "../lib/artifact-api";
import type { Artifact } from "@cogniplane/shared-types";
import { isArtifactEligibleForChatContext } from "../lib/artifact-eligibility";
import { useArtifactActions } from "./use-artifact-actions";

type ArtifactSelectionMode = "auto" | "manual";

function compareArtifactsByRecency(left: Artifact, right: Artifact): number {
  return (
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

function getAutoScopedArtifactIds(artifacts: Artifact[]): string[] {
  const eligible = artifacts.filter(isArtifactEligibleForChatContext);
  const eligibleUploads = eligible
    .filter((artifact) => artifact.artifactType === "upload")
    .sort(compareArtifactsByRecency);
  if (eligibleUploads.length) return [eligibleUploads[0].artifactId];
  if (eligible.length === 1) return [eligible[0].artifactId];
  return [];
}

function retainSelectedArtifactIds(
  currentArtifactIds: string[],
  nextArtifacts: Artifact[],
): string[] {
  return currentArtifactIds.filter((artifactId) =>
    nextArtifacts.some((artifact) => artifact.artifactId === artifactId),
  );
}

export function useArtifacts(input: {
  selectedSessionId: string | null;
  artifacts: Artifact[];
  onError: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const { selectedSessionId, artifacts, onError, onRefresh } = input;

  const [artifactSelectionMode, setArtifactSelectionMode] =
    useState<ArtifactSelectionMode>("auto");
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([]);
  const [isUploadingArtifact, setIsUploadingArtifact] = useState(false);

  // Preview + download are shared with the artifact browser. The chat call
  // sites pass an artifactId string to openPreview, so hand the hook the
  // current `artifacts` list to resolve against.
  const actions = useArtifactActions({ onError, artifacts });

  const visibleSelectedArtifactIds = useMemo(() => {
    const candidateIds =
      artifactSelectionMode === "manual"
        ? selectedArtifactIds
        : getAutoScopedArtifactIds(artifacts);
    // Always gate the final list on eligibility so that a freshly flagged
    // (pending/blocked) artifact cannot leak into the message request even if
    // the user had previously selected it in manual mode.
    const eligibleById = new Map(
      artifacts
        .filter(isArtifactEligibleForChatContext)
        .map((artifact) => [artifact.artifactId, artifact])
    );
    return candidateIds.filter((id) => eligibleById.has(id));
  }, [artifactSelectionMode, selectedArtifactIds, artifacts]);

  const resetSelection = useCallback(() => {
    setArtifactSelectionMode("auto");
    setSelectedArtifactIds([]);
  }, []);

  const updateArtifactSelection = useCallback((nextArtifacts: Artifact[]) => {
    if (artifactSelectionMode === "manual") {
      setSelectedArtifactIds((current) =>
        retainSelectedArtifactIds(current, nextArtifacts),
      );
    } else {
      setSelectedArtifactIds(getAutoScopedArtifactIds(nextArtifacts));
    }
  }, [artifactSelectionMode]);

  const toggleArtifactSelection = useCallback((artifactId: string) => {
    const base =
      artifactSelectionMode === "manual"
        ? selectedArtifactIds
        : getAutoScopedArtifactIds(artifacts);

    setArtifactSelectionMode("manual");
    setSelectedArtifactIds(
      base.includes(artifactId)
        ? base.filter((id) => id !== artifactId)
        : [...base, artifactId],
    );
  }, [artifactSelectionMode, artifacts, selectedArtifactIds]);

  const selectArtifact = useCallback((artifactId: string) => {
    setArtifactSelectionMode("manual");
    setSelectedArtifactIds((current) =>
      current.includes(artifactId) ? current : [...current, artifactId]
    );
  }, []);

  const handleUploadArtifact = useCallback(async (file: File | null) => {
    if (!file || !selectedSessionId) return;
    setIsUploadingArtifact(true);
    try {
      await uploadArtifact({ sessionId: selectedSessionId, file });
      await onRefresh();
    } catch {
      onError("Failed to upload artifact.");
    } finally {
      setIsUploadingArtifact(false);
    }
  }, [onError, onRefresh, selectedSessionId]);

  return {
    artifactSelectionMode,
    selectedArtifactIds,
    visibleSelectedArtifactIds,
    isUploadingArtifact,
    resetSelection,
    updateArtifactSelection,
    toggleArtifactSelection,
    selectArtifact,
    handleUploadArtifact,
    // Preview + download (shared via useArtifactActions) — re-exported so the
    // chat panel's consumption of useArtifacts is unchanged.
    downloadArtifactId: actions.downloadArtifactId,
    previewArtifactId: actions.previewArtifactId,
    previewContent: actions.previewContent,
    previewImageUrl: actions.previewImageUrl,
    previewMimeType: actions.previewMimeType,
    previewName: actions.previewName,
    previewError: actions.previewError,
    isLoadingPreview: actions.isLoadingPreview,
    handleDownloadArtifact: actions.handleDownloadArtifact,
    openPreview: actions.openPreview,
    closePreview: actions.closePreview,
  };
}
