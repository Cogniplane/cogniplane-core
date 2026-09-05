"use client";

import { useState, useMemo, useCallback } from "react";

import { uploadArtifact } from "../lib/artifact-api";
import type { Artifact } from "@cogniplane/shared-types";
import { isArtifactEligibleForChatContext } from "../lib/artifact-eligibility";
import { useArtifactActions } from "./use-artifact-actions";

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

export function useArtifacts(input: {
  selectedSessionId: string | null;
  artifacts: Artifact[];
  onError: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const { selectedSessionId, artifacts, onError, onRefresh } = input;

  const [selectionSessionId, setSelectionSessionId] = useState(selectedSessionId);
  const [previousArtifacts, setPreviousArtifacts] = useState(artifacts);
  // null means automatic selection; [] is an explicit choice to use no files.
  const [manualSelectedIds, setManualSelectedIds] = useState<string[] | null>(null);
  if (selectionSessionId !== selectedSessionId) {
    setSelectionSessionId(selectedSessionId);
    setPreviousArtifacts(artifacts);
    setManualSelectedIds(null);
  } else if (previousArtifacts !== artifacts) {
    // Imports can select an ID before the refreshed inventory reaches this hook.
    setPreviousArtifacts(artifacts);
    if (manualSelectedIds !== null) {
      const presentIds = new Set(artifacts.map((artifact) => artifact.artifactId));
      const retained = manualSelectedIds.filter((id) => presentIds.has(id));
      if (retained.length !== manualSelectedIds.length) setManualSelectedIds(retained);
    }
  }
  const [isUploadingArtifact, setIsUploadingArtifact] = useState(false);

  // Preview + download are shared with the artifact browser. The chat call
  // sites pass an artifactId string to openPreview, so hand the hook the
  // current `artifacts` list to resolve against.
  const actions = useArtifactActions({ onError, artifacts });

  const visibleSelectedArtifactIds = useMemo(() => {
    const candidateIds = manualSelectedIds ?? getAutoScopedArtifactIds(artifacts);
    // Always gate the final list on eligibility so that a freshly flagged
    // (pending/blocked) artifact cannot leak into the message request even if
    // the user had previously selected it in manual mode.
    const eligibleById = new Set(
      artifacts
        .filter(isArtifactEligibleForChatContext)
        .map((artifact) => artifact.artifactId)
    );
    return candidateIds.filter((id) => eligibleById.has(id));
  }, [manualSelectedIds, artifacts]);

  const toggleArtifactSelection = useCallback((artifactId: string) => {
    setManualSelectedIds((current) => {
      const base = current ?? getAutoScopedArtifactIds(artifacts);
      return base.includes(artifactId)
        ? base.filter((id) => id !== artifactId)
        : [...base, artifactId];
    });
  }, [artifacts]);

  const selectArtifact = useCallback((artifactId: string) => {
    setManualSelectedIds((current) => {
      const base = current ?? getAutoScopedArtifactIds(artifacts);
      return base.includes(artifactId) ? base : [...base, artifactId];
    });
  }, [artifacts]);

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
    visibleSelectedArtifactIds,
    isUploadingArtifact,
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
