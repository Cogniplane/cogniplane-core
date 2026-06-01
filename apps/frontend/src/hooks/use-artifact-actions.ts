"use client";

import { useState, useCallback, useRef } from "react";

import { createArtifactDownload } from "../lib/artifact-api";
import type { Artifact } from "@cogniplane/shared-types";
import { artifactApiBase, loadArtifactPreview } from "../lib/artifact-preview-loader";

/**
 * Preview + download actions for a single artifact, shared by the chat artifact
 * panel and the cross-session artifact browser. This is the half of the old
 * `useArtifacts` that has nothing to do with chat-context selection/upload — it
 * was extracted so the two surfaces share ONE 3-way preview loader (image / PDF
 * / other), one signed-URL/download flow, and one request-race guard.
 *
 * `openPreview` accepts either the full `Artifact` (the browser already holds
 * the row) or an `artifactId` string (the chat message list only has the id).
 * When given an id, it resolves against the optional `artifacts` lookup the
 * caller passes in — a paginated browser, which may not have the artifact in
 * any array, passes the object directly instead.
 *
 * The `previewRequestRef` symbol guard is carried here verbatim: each
 * `openPreview` tags its in-flight request, and every state write checks it is
 * still the current request before applying, so a fast click-through doesn't
 * render a stale artifact's content.
 */
export function useArtifactActions(input: {
  onError: (message: string) => void;
  /** Optional id→artifact lookup for the string-id form of openPreview. */
  artifacts?: Artifact[];
}) {
  const { onError, artifacts } = input;

  const [downloadArtifactId, setDownloadArtifactId] = useState<string | null>(null);
  const [previewArtifactId, setPreviewArtifactId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewMimeType, setPreviewMimeType] = useState<string>("");
  const [previewName, setPreviewName] = useState<string>("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  const previewRequestRef = useRef<symbol | null>(null);

  const handleDownloadArtifact = useCallback(async (artifactId: string) => {
    setDownloadArtifactId(artifactId);
    try {
      const download = await createArtifactDownload(artifactId);
      window.location.assign(`${artifactApiBase()}${download.url}`);
    } catch {
      onError("Failed to download artifact.");
    } finally {
      setDownloadArtifactId(null);
    }
  }, [onError]);

  const openPreview = useCallback(async (target: Artifact | string) => {
    const artifact =
      typeof target === "string"
        ? artifacts?.find((a) => a.artifactId === target)
        : target;
    if (!artifact) return;

    const thisRequest = Symbol();
    previewRequestRef.current = thisRequest;

    setPreviewArtifactId(artifact.artifactId);
    setPreviewName(artifact.artifactName);
    setPreviewMimeType(artifact.mimeType);
    setPreviewContent(null);
    setPreviewError(null);
    setIsLoadingPreview(true);
    setPreviewImageUrl(null);

    try {
      const result = await loadArtifactPreview(artifact);
      // Apply only if this is still the latest request — guards against a fast
      // click-through rendering a stale artifact's content.
      if (previewRequestRef.current === thisRequest) {
        if (result.kind === "image") {
          setPreviewImageUrl(result.imageUrl);
          // previewContent stays null for images — modal uses previewImageUrl !== null as readiness signal
        } else {
          setPreviewContent(result.text);
        }
      }
    } catch (_err) {
      if (previewRequestRef.current === thisRequest)
        setPreviewError("Failed to load preview. Try downloading the file instead.");
    } finally {
      setIsLoadingPreview(false);
    }
  }, [artifacts]);

  const closePreview = useCallback(() => {
    // Invalidate any in-flight request so a late resolve cannot repopulate a
    // closed preview.
    previewRequestRef.current = null;
    setPreviewArtifactId(null);
    setPreviewContent(null);
    setPreviewImageUrl(null);
    setPreviewError(null);
    setPreviewMimeType("");
    setPreviewName("");
    setIsLoadingPreview(false);
  }, []);

  return {
    downloadArtifactId,
    previewArtifactId,
    previewContent,
    previewImageUrl,
    previewMimeType,
    previewName,
    previewError,
    isLoadingPreview,
    handleDownloadArtifact,
    openPreview,
    closePreview
  };
}
