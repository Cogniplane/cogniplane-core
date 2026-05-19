"use client";

import { useState } from "react";

import { createAdminArtifactDownload } from "../lib/admin-api";
import { API_URL } from "../lib/api-client";
import type { AdminSessionDetailArtifact } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";

const PILL_GRAY =
  "inline-flex items-center rounded-full bg-surface-container px-2 py-0.5 text-xs font-medium text-on-surface-variant";
const HINT = "text-sm text-on-surface-faint";
const LIST_ITEM = "rounded-lg border border-outline-variant bg-surface-container-lowest p-3";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AdminSessionArtifactsTab(props: { artifacts: AdminSessionDetailArtifact[] }) {
  const [busyArtifactId, setBusyArtifactId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (props.artifacts.length === 0) {
    return <p className={HINT}>No artifacts in this session.</p>;
  }

  const handleDownload = async (artifactId: string) => {
    setBusyArtifactId(artifactId);
    setError(null);
    try {
      const download = await createAdminArtifactDownload(artifactId);
      window.location.assign(`${API_URL}${download.url}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start download.");
    } finally {
      setBusyArtifactId(null);
    }
  };

  return (
    <>
      {error ? <p className="mb-2 text-sm text-danger">{error}</p> : null}
      <div className="flex flex-col gap-2">
        {props.artifacts.map((artifact) => (
          <div className={LIST_ITEM} key={artifact.artifactId}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm font-semibold text-on-surface">
                {artifact.artifactName}
              </strong>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={PILL_GRAY}>{artifact.artifactType}</span>
                <span className={PILL_GRAY}>{artifact.mimeType}</span>
                <span className={PILL_GRAY}>{artifact.status}</span>
              </div>
            </div>
            <p className="mt-1 text-xs text-on-surface-faint">
              {formatBytes(artifact.fileSizeBytes)} · created{" "}
              {formatTimestamp(artifact.createdAt)}
            </p>
            <p className="text-xs text-on-surface-faint">{artifact.artifactId}</p>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="mt-2"
              disabled={busyArtifactId === artifact.artifactId}
              onClick={() => void handleDownload(artifact.artifactId)}
            >
              {busyArtifactId === artifact.artifactId ? "Preparing…" : "Download"}
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}
