"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronDownIcon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";

import type { FileSourceSummary } from "./file-source-picker";
import type { Artifact } from "@cogniplane/shared-types";
import { canPreviewArtifact } from "../lib/artifact-preview";
import { PiiChip } from "./artifact-pii-chip";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  canDownloadArtifact,
  canSelectArtifact,
  formatArtifactStatus,
  formatFileSize,
  getArtifactOrigin
} from "./artifact-panel.logic";

const ORIGIN_TONE_CLASS: Record<ReturnType<typeof getArtifactOrigin>["tone"], string> = {
  accent: "bg-info-surface text-info",
  neutral: "bg-[var(--artifact-chip-surface)] text-on-surface-variant"
};

function ArtifactRow(props: {
  artifact: Artifact;
  isSelected: boolean;
  downloadArtifactId: string | null;
  previewArtifactId: string | null;
  isLoadingPreview: boolean;
  onToggleSelection: (artifactId: string) => void;
  onDownload: (artifactId: string) => void;
  onPreview: (artifactId: string) => void;
}) {
  const { artifact } = props;
  const pii = artifact.detail?.pii;
  const origin = getArtifactOrigin(artifact);

  return (
    <article className="flex items-start gap-3 rounded-md bg-[var(--artifact-card-surface)] p-3">
      <label className="flex min-w-0 flex-1 items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={props.isSelected}
          disabled={!canSelectArtifact(artifact)}
          onChange={() => props.onToggleSelection(artifact.artifactId)}
          className="mt-0.5 size-4 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <strong className="truncate text-sm font-medium text-on-surface">
              {artifact.artifactName}
            </strong>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-label font-semibold ${
                ORIGIN_TONE_CLASS[origin.tone]
              }`}
            >
              {origin.label}
            </span>
            {pii ? <PiiChip pii={pii} /> : null}
          </div>
          <p className="mt-1 text-xs text-on-surface-variant">
            {formatArtifactStatus(artifact.status)} · {formatFileSize(artifact.fileSizeBytes)}
          </p>
        </div>
      </label>
      <div className="flex shrink-0 flex-col gap-1">
        {canPreviewArtifact(artifact) ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={props.previewArtifactId === artifact.artifactId && props.isLoadingPreview}
            onClick={() => props.onPreview(artifact.artifactId)}
          >
            {props.previewArtifactId === artifact.artifactId && props.isLoadingPreview
              ? "Loading…"
              : "Preview"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={
            !canDownloadArtifact(artifact)
            || props.downloadArtifactId === artifact.artifactId
          }
          onClick={() => props.onDownload(artifact.artifactId)}
        >
          {props.downloadArtifactId === artifact.artifactId ? "Preparing..." : "Download"}
        </Button>
      </div>
    </article>
  );
}

function AddSourceMenu(props: {
  selectedSessionId: string | null;
  isUploadingArtifact: boolean;
  fileSources: FileSourceSummary[];
  onUpload: (file: File | null) => void;
  onOpenSource: (sourceId: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const triggerLabel = props.isUploadingArtifact ? "Uploading..." : "Add source";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!props.selectedSessionId || props.isUploadingArtifact}
          >
            {triggerLabel}
            <ChevronDownIcon className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem
            onSelect={() => fileInputRef.current?.click()}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="font-medium">Upload from this device</span>
            <span className="text-xs text-muted-foreground">Pick a file from your computer</span>
          </DropdownMenuItem>
          {props.fileSources.length > 0 ? <DropdownMenuSeparator /> : null}
          {props.fileSources.map((source) => {
            const connected = source.connection.kind === "connected";
            return (
              <DropdownMenuItem
                key={source.id}
                onSelect={() => props.onOpenSource(source.id)}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="flex items-center gap-1.5 font-medium">
                  {source.label}
                  {connected ? null : (
                    <span className="rounded bg-warning-surface px-1.5 py-0.5 text-label font-semibold text-warning">
                      Not connected
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {connected
                    ? `${source.description} — ${source.connection.label}`
                    : source.description}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInputRef}
        type="file"
        disabled={!props.selectedSessionId || props.isUploadingArtifact}
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          props.onUpload(file);
          event.currentTarget.value = "";
        }}
        className="hidden"
      />
    </>
  );
}

export type ArtifactInventoryModel = {
  artifacts: Artifact[];
  /** "loading" while the first load of the session runs, and "unavailable"
   *  after it failed with nothing cached. The list is empty then because it is
   *  not known, so the panel does not say that the session has no files. */
  status?: "ready" | "loading" | "unavailable";
  onRetry?: () => void;
  retrying?: boolean;
};

/** A list that is not known yet, or could not be loaded. */
function UnknownInventory({ status, onRetry, retrying }: {
  status: "loading" | "unavailable";
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return status === "loading" ? (
    <p role="status" className="flex items-center gap-2 rounded-md bg-[var(--artifact-card-surface)] p-4 text-sm text-on-surface-variant">
      <LoaderCircleIcon aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" /><span>Loading files…</span>
    </p>
  ) : (
    <div className="rounded-md bg-[var(--artifact-card-surface)] p-4 text-sm">
      <p className="flex items-center gap-2 font-medium text-on-surface"><CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-danger" />Files did not load</p>
      <p className="mt-1 text-on-surface-variant">The file list is unavailable. Try loading this session again.</p>
      {onRetry ? <Button type="button" variant="outline" size="sm" className="mt-3 aria-disabled:opacity-50"
        aria-disabled={retrying || undefined} aria-busy={retrying || undefined}
        onClick={() => { if (!retrying) onRetry(); }}>{retrying ? "Retrying…" : "Try again"}</Button> : null}
    </div>
  );
}

function CountBadge({ count, known }: { count: number; known: boolean }) {
  return (
    <span aria-hidden={!known || undefined} className="min-w-5 rounded bg-surface-container px-1.5 py-0.5 text-label font-semibold tabular-nums text-on-surface-faint">
      {known ? count : "–"}
    </span>
  );
}

export type ArtifactSelectionModel = {
  visibleSelectedArtifactIds: string[];
  onToggle: (artifactId: string) => void;
};

export type ArtifactTransferModel = {
  isUploading: boolean;
  downloadingId: string | null;
  onUpload: (file: File | null) => void;
  onDownload: (artifactId: string) => void;
};

export type ArtifactPreviewModel = {
  artifactId: string | null;
  isLoading: boolean;
  onOpen: (artifactId: string) => void;
};

export type ArtifactSourcesModel = {
  sessionId: string | null;
  items: FileSourceSummary[];
  onOpen: (sourceId: string) => void;
};

export function ArtifactPanel({ inventory, selection, transfers, preview, sources, surface = "inline" }: {
  inventory: ArtifactInventoryModel;
  selection: ArtifactSelectionModel;
  transfers: ArtifactTransferModel;
  preview: ArtifactPreviewModel;
  sources: ArtifactSourcesModel;
  surface?: "inline" | "raised";
}) {
  const [tab, setTab] = useState<"context" | "artifacts">("context");
  const status = inventory.status ?? "ready";
  const known = status === "ready";

  const selectedIdSet = useMemo(
    () => new Set(selection.visibleSelectedArtifactIds),
    [selection.visibleSelectedArtifactIds]
  );
  const selectedArtifacts = inventory.artifacts.filter((artifact) =>
    selectedIdSet.has(artifact.artifactId)
  );

  return (
    <section className={`flex min-h-0 flex-1 flex-col ${surface === "raised"
      ? "[--artifact-card-surface:var(--color-surface-container)] [--artifact-chip-surface:var(--color-surface-container-high)]"
      : "[--artifact-card-surface:var(--color-surface-container-lowest)] [--artifact-chip-surface:var(--color-surface-container)]"}`}>
      <Tabs value={tab} onValueChange={(value) => setTab(value as "context" | "artifacts")} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-4 mt-3 grid grid-cols-2">
          <TabsTrigger value="context" className="gap-2">
            Context
            <CountBadge count={selectedArtifacts.length} known={known} />
          </TabsTrigger>
          <TabsTrigger value="artifacts" className="gap-2">
            Artifacts
            <CountBadge count={inventory.artifacts.length} known={known} />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="context" className="flex-1 overflow-y-auto px-4 py-3 data-[state=inactive]:hidden">
          <p className="mb-3 text-xs text-on-surface-variant">
            These sources are deterministic context for every turn. Only you can add or remove them.
          </p>
          {selectedArtifacts.length ? (
            <div className="flex flex-col gap-2">
              {selectedArtifacts.map((artifact) => (
                <ArtifactRow
                  key={artifact.artifactId}
                  artifact={artifact}
                  isSelected
                  downloadArtifactId={transfers.downloadingId}
                  isLoadingPreview={preview.isLoading}
                  previewArtifactId={preview.artifactId}
                  onDownload={transfers.onDownload}
                  onPreview={preview.onOpen}
                  onToggleSelection={selection.onToggle}
                />
              ))}
            </div>
          ) : status !== "ready" ? (
            <UnknownInventory status={status} onRetry={inventory.onRetry} retrying={inventory.retrying} />
          ) : (
            <div className="rounded-md bg-[var(--artifact-card-surface)] p-4 text-sm">
              <p className="font-medium text-on-surface">No documents in play</p>
              <p className="text-on-surface-variant">
                Use &ldquo;Add source&rdquo; to upload a file or pull one from a connected provider.
              </p>
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <AddSourceMenu
              fileSources={sources.items}
              isUploadingArtifact={transfers.isUploading}
              onOpenSource={sources.onOpen}
              onUpload={transfers.onUpload}
              selectedSessionId={sources.sessionId}
            />
          </div>
        </TabsContent>

        <TabsContent value="artifacts" className="flex-1 overflow-y-auto px-4 py-3 data-[state=inactive]:hidden">
          {inventory.artifacts.length ? (
            <div className="flex flex-col gap-2">
              {inventory.artifacts.map((artifact) => (
                <ArtifactRow
                  key={artifact.artifactId}
                  artifact={artifact}
                  isSelected={selectedIdSet.has(artifact.artifactId)}
                  downloadArtifactId={transfers.downloadingId}
                  isLoadingPreview={preview.isLoading}
                  previewArtifactId={preview.artifactId}
                  onDownload={transfers.onDownload}
                  onPreview={preview.onOpen}
                  onToggleSelection={selection.onToggle}
                />
              ))}
            </div>
          ) : status !== "ready" ? (
            <UnknownInventory status={status} onRetry={inventory.onRetry} retrying={inventory.retrying} />
          ) : (
            <div className="rounded-md bg-[var(--artifact-card-surface)] p-4 text-sm">
              <p className="font-medium text-on-surface">No artifacts yet</p>
              <p className="text-on-surface-variant">
                Files generated by the agent during this session appear here.
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
