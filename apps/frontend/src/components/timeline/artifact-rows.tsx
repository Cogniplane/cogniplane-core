"use client";

import { ChevronDownIcon, DownloadIcon, FileTextIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ArtifactReadRow, ArtifactWriteRow } from "../timeline.logic";
import { formatElapsed, STATUS_BADGE, STATUS_BORDER, statusBadgeLabel } from "./shared";

export function ArtifactWriteRowView({
  row,
  onPreviewArtifact
}: {
  row: ArtifactWriteRow;
  onPreviewArtifact?: (artifactId: string) => void;
}) {
  const artifactId = parseArtifactIdFromOutput(row.output);
  const artifactName = parseArtifactNameFromInput(row.input) ?? row.toolName;
  const isWorking = row.status === "in_progress";
  const isFailed = row.status === "failed" || row.status === "declined";

  return (
    <article
      className={`flex items-center gap-3 rounded-md border bg-surface-container-low px-3 py-2.5 ${
        isFailed ? "border-danger/40" : "border-outline-variant"
      }`}
    >
      <FileTextIcon className="size-4 shrink-0 text-on-surface-faint" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium text-on-surface">
          <span className="truncate">{isWorking ? "Preparing artifact…" : artifactName}</span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider ${STATUS_BADGE[row.status]}`}
          >
            {statusBadgeLabel(row.status)}
          </span>
        </div>
        {isFailed && row.output ? (
          <p className="mt-1 text-xs text-danger">{row.output.slice(0, 200)}</p>
        ) : null}
      </div>
      {!isWorking && !isFailed && artifactId && onPreviewArtifact ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPreviewArtifact(artifactId)}
        >
          <DownloadIcon />
          Preview
        </Button>
      ) : null}
    </article>
  );
}

export function ArtifactReadRowView({ row }: { row: ArtifactReadRow }) {
  const artifactId = parseArtifactIdFromInput(row.input);
  const elapsed = formatElapsed(row.durationMs);

  return (
    <details className={`group rounded-md border-l-2 bg-surface-container-low pl-3 pr-2 py-2 ${STATUS_BORDER[row.status]}`}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm outline-none">
        <ChevronDownIcon className="size-3 -rotate-90 text-on-surface-faint transition-transform group-open:rotate-0" />
        <FileTextIcon className="size-3 shrink-0 text-on-surface-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-on-surface">
          {row.toolName}
          {artifactId ? `: ${artifactId}` : ""}
        </span>
        {elapsed ? (
          <span className="shrink-0 font-mono text-[0.7rem] text-on-surface-faint">{elapsed}</span>
        ) : null}
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider ${STATUS_BADGE[row.status]}`}
        >
          {statusBadgeLabel(row.status)}
        </span>
      </summary>
      <div className="mt-2 overflow-x-auto">
        <pre className="whitespace-pre-wrap break-all font-mono text-[0.78rem] leading-snug text-on-surface-variant">
          {previewOutput(row.output)}
        </pre>
      </div>
    </details>
  );
}

const ARTIFACT_READ_PREVIEW_LINES = 20;

function previewOutput(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= ARTIFACT_READ_PREVIEW_LINES) return output;
  return `${lines.slice(0, ARTIFACT_READ_PREVIEW_LINES).join("\n")}\n…`;
}

function parseArtifactIdFromOutput(output: string): string | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const id = parsed["artifactId"] ?? parsed["id"];
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function parseArtifactNameFromInput(input: string): string | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const name = parsed["name"] ?? parsed["fileName"] ?? parsed["filename"];
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

function parseArtifactIdFromInput(input: string): string | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const id = parsed["artifactId"] ?? parsed["id"];
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}
