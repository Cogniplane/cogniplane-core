"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";

import type { FileSourceSummary } from "./file-source-picker";
import type { Artifact, ArtifactPiiDetail } from "@cogniplane/shared-types";
import { canPreviewArtifact } from "../lib/artifact-preview";
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
  formatPiiLabel,
  getArtifactOrigin,
  piiTone
} from "./artifact-panel.logic";

const PII_TONE_CLASS: Record<ReturnType<typeof piiTone>, string> = {
  pending: "bg-accent-soft text-accent",
  blocked: "bg-danger-surface text-danger",
  failed: "bg-warning-surface text-warning",
  transformed: "bg-warning-surface text-warning",
  neutral: "bg-success-surface text-success"
};

function PiiChip({ pii }: { pii: ArtifactPiiDetail }) {
  const label = formatPiiLabel(pii);
  if (!label) return null;
  const tone = PII_TONE_CLASS[piiTone(pii)];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[0.62rem] font-semibold ${tone}`}>{label}</span>
  );
}

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
  const sourceIsMicrosoft = artifact.detail?.source === "microsoft";

  return (
    <article className="flex items-start gap-3 rounded-md bg-surface-container-lowest p-3">
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
              className={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-semibold ${
                sourceIsMicrosoft
                  ? "bg-accent-soft text-accent"
                  : "bg-surface-container text-on-surface-variant"
              }`}
            >
              {getArtifactOrigin(artifact)}
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
                    <span className="rounded bg-warning-surface px-1.5 py-0.5 text-[0.6rem] font-semibold text-warning">
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

export function ArtifactPanel(props: {
  artifacts: Artifact[];
  visibleSelectedArtifactIds: string[];
  isUploadingArtifact: boolean;
  downloadArtifactId: string | null;
  previewArtifactId: string | null;
  isLoadingPreview: boolean;
  selectedSessionId: string | null;
  onUpload: (file: File | null) => void;
  onToggleSelection: (artifactId: string) => void;
  onDownload: (artifactId: string) => void;
  onPreview: (artifactId: string) => void;
  fileSources: FileSourceSummary[];
  onOpenFileSource: (sourceId: string) => void;
}) {
  const [tab, setTab] = useState<"context" | "artifacts">("context");

  const selectedIdSet = useMemo(
    () => new Set(props.visibleSelectedArtifactIds),
    [props.visibleSelectedArtifactIds]
  );
  const selectedArtifacts = props.artifacts.filter((artifact) =>
    selectedIdSet.has(artifact.artifactId)
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <Tabs value={tab} onValueChange={(value) => setTab(value as "context" | "artifacts")} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-4 mt-3 grid grid-cols-2">
          <TabsTrigger value="context" className="gap-2">
            Context
            <span className="rounded bg-surface-container px-1.5 py-0.5 text-[0.62rem] font-semibold text-on-surface-faint">
              {selectedArtifacts.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="artifacts" className="gap-2">
            Artifacts
            <span className="rounded bg-surface-container px-1.5 py-0.5 text-[0.62rem] font-semibold text-on-surface-faint">
              {props.artifacts.length}
            </span>
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
                  downloadArtifactId={props.downloadArtifactId}
                  isLoadingPreview={props.isLoadingPreview}
                  previewArtifactId={props.previewArtifactId}
                  onDownload={props.onDownload}
                  onPreview={props.onPreview}
                  onToggleSelection={props.onToggleSelection}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-md bg-surface-container-lowest p-4 text-sm">
              <p className="font-medium text-on-surface">No documents in play</p>
              <p className="text-on-surface-variant">
                Use &ldquo;Add source&rdquo; to upload a file or pull one from a connected provider.
              </p>
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <AddSourceMenu
              fileSources={props.fileSources}
              isUploadingArtifact={props.isUploadingArtifact}
              onOpenSource={props.onOpenFileSource}
              onUpload={props.onUpload}
              selectedSessionId={props.selectedSessionId}
            />
          </div>
        </TabsContent>

        <TabsContent value="artifacts" className="flex-1 overflow-y-auto px-4 py-3 data-[state=inactive]:hidden">
          {props.artifacts.length ? (
            <div className="flex flex-col gap-2">
              {props.artifacts.map((artifact) => (
                <ArtifactRow
                  key={artifact.artifactId}
                  artifact={artifact}
                  isSelected={selectedIdSet.has(artifact.artifactId)}
                  downloadArtifactId={props.downloadArtifactId}
                  isLoadingPreview={props.isLoadingPreview}
                  previewArtifactId={props.previewArtifactId}
                  onDownload={props.onDownload}
                  onPreview={props.onPreview}
                  onToggleSelection={props.onToggleSelection}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-md bg-surface-container-lowest p-4 text-sm">
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
