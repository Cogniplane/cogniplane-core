"use client";

import { useState, useMemo, useCallback, useRef } from "react";

import {
  createArtifactDownload,
  fetchArtifactContent,
  fetchArtifactPreviewText,
  uploadArtifact
} from "../lib/artifact-api";
import type { Artifact } from "@cogniplane/shared-types";
import { isArtifactEligibleForChatContext } from "../lib/artifact-eligibility";
import { isImageArtifact, isPdfArtifact } from "../lib/artifact-preview";

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
  const [downloadArtifactId, setDownloadArtifactId] = useState<string | null>(
    null,
  );
  const [previewArtifactId, setPreviewArtifactId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewMimeType, setPreviewMimeType] = useState<string>("");
  const [previewName, setPreviewName] = useState<string>("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  const previewRequestRef = useRef<symbol | null>(null);

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

  const handleDownloadArtifact = useCallback(async (artifactId: string) => {
    setDownloadArtifactId(artifactId);
    try {
      const download = await createArtifactDownload(artifactId);
      window.location.assign(
        `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}${download.url}`
      );
    } catch {
      onError("Failed to download artifact.");
    } finally {
      setDownloadArtifactId(null);
    }
  }, [onError]);

  const openPreview = useCallback(async (artifactId: string) => {
    const artifact = artifacts.find((a) => a.artifactId === artifactId);
    if (!artifact) return;

    const thisRequest = Symbol();
    previewRequestRef.current = thisRequest;

    setPreviewArtifactId(artifactId);
    setPreviewName(artifact.artifactName);
    setPreviewMimeType(artifact.mimeType);
    setPreviewContent(null);
    setPreviewError(null);
    setIsLoadingPreview(true);
    setPreviewImageUrl(null);

    try {
      if (isImageArtifact(artifact.mimeType)) {
        const handle = await createArtifactDownload(artifactId);
        if (previewRequestRef.current === thisRequest) {
          setPreviewImageUrl(
            `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}${handle.url}`
          );
          // previewContent stays null for images — modal uses previewImageUrl !== null as readiness signal
        }
      } else if (isPdfArtifact(artifact.mimeType)) {
        const text = await fetchArtifactPreviewText(artifactId);
        if (previewRequestRef.current === thisRequest) setPreviewContent(text);
      } else {
        const handle = await createArtifactDownload(artifactId);
        const text = await fetchArtifactContent(
          `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}${handle.url}`
        );
        if (previewRequestRef.current === thisRequest) setPreviewContent(text);
      }
    } catch (_err) {
      if (previewRequestRef.current === thisRequest)
        setPreviewError("Failed to load preview. Try downloading the file instead.");
    } finally {
      setIsLoadingPreview(false);
    }
  }, [artifacts]);

  const closePreview = useCallback(() => {
    setPreviewArtifactId(null);
    setPreviewContent(null);
    setPreviewImageUrl(null);
    setPreviewError(null);
    setPreviewMimeType("");
    setPreviewName("");
    setIsLoadingPreview(false);
  }, []);

  return {
    artifactSelectionMode,
    selectedArtifactIds,
    visibleSelectedArtifactIds,
    isUploadingArtifact,
    downloadArtifactId,
    previewArtifactId,
    previewContent,
    previewImageUrl,
    previewMimeType,
    previewName,
    previewError,
    isLoadingPreview,
    resetSelection,
    updateArtifactSelection,
    toggleArtifactSelection,
    selectArtifact,
    handleUploadArtifact,
    handleDownloadArtifact,
    openPreview,
    closePreview,
  };
}
