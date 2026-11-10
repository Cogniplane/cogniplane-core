"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import type { Artifact } from "@cogniplane/shared-types";
import { classifyMimeClass } from "@cogniplane/shared-types";

import {
  ARTIFACT_MIME_CLASS_LABELS,
  ARTIFACT_MIME_CLASS_OPTIONS,
  ARTIFACT_SORT_LABELS,
  ARTIFACT_SORT_OPTIONS,
  ARTIFACT_STATUS_OPTIONS,
  ARTIFACT_STATUS_LABELS,
  ARTIFACT_TYPE_OPTIONS,
  ARTIFACT_TYPE_LABELS,
  EMPTY_ARTIFACT_FILTER_STATE,
  artifactFilterStateToParams,
  artifactFilterStateToSearchString,
  artifactSearchHasAnyFilter,
  parseArtifactFilterState,
  toggleInArray,
  type ArtifactBrowserFilterState
} from "./artifact-browser.logic";
import {
  canDownloadArtifact,
  formatArtifactStatus,
  formatFileSize,
  getArtifactOrigin
} from "./artifact-panel.logic";
import { PiiChip } from "./artifact-pii-chip";
import { ArtifactPreviewModal } from "./artifact-preview-modal";
import { canPreviewArtifact, exceedsTextPreviewLimit } from "../lib/artifact-preview";
import { useArtifactActions } from "../hooks/use-artifact-actions";
import { useArtifactBrowserData } from "../hooks/use-artifact-browser-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { PILL_GRAY } from "../lib/ui-tokens";

function MultiSelectFilter(props: {
  label: string;
  options: readonly string[];
  selected: string[];
  optionLabel?: (value: string) => string;
  onToggle: (value: string) => void;
}) {
  const count = props.selected.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-10 sm:h-8">
          {props.label}
          {count > 0 ? ` (${count})` : ""}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {props.options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option}
            checked={props.selected.includes(option)}
            onCheckedChange={() => props.onToggle(option)}
            onSelect={(event) => event.preventDefault()}
          >
            {props.optionLabel ? props.optionLabel(option) : option}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArtifactBrowserRow(props: {
  artifact: Artifact;
  isDownloading: boolean;
  onPreview: (artifact: Artifact) => void;
  onDownload: (artifactId: string) => void;
}) {
  const { artifact } = props;
  const pii = artifact.detail?.pii;
  const availabilityId = useId();
  const availability = artifact.status !== "ready"
    ? artifact.status === "pending" || artifact.status === "processing"
      ? "Preview and download will be available when the file is ready."
      : `Preview and download are unavailable for this ${artifact.status} file.`
    : !canPreviewArtifact(artifact)
      ? "Preview is not supported for this file format. You can download the file."
      : null;

  return (
    <div role="listitem" className="flex flex-col gap-3 border-b border-outline-variant p-4 text-sm last:border-b-0 hover:bg-surface-container-low sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="font-medium leading-6 text-on-surface [overflow-wrap:anywhere]" title={artifact.artifactName}>
          {artifact.artifactName}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className={PILL_GRAY}>{getArtifactOrigin(artifact).label}</span>
          <span className="text-xs text-on-surface-faint">{ARTIFACT_MIME_CLASS_LABELS[classifyMimeClass(artifact.mimeType)]}</span>
          <span className="text-xs text-on-surface-faint">·</span>
          <span className="text-xs text-on-surface-faint">{formatFileSize(artifact.fileSizeBytes)}</span>
          {artifact.status !== "ready" ? (
            <span className={PILL_GRAY}>{formatArtifactStatus(artifact.status)}</span>
          ) : null}
          {pii ? <span className="inline-flex rounded bg-surface-container-lowest"><PiiChip pii={pii} /></span> : null}
          <time className="text-xs text-on-surface-faint" dateTime={artifact.createdAt}>
            {new Date(artifact.createdAt).toLocaleDateString()}
          </time>
        </div>
        {availability ? <p id={availabilityId} className="mt-2 max-w-prose text-xs leading-5 text-on-surface-variant">{availability}</p> : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-0.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-10 sm:h-8"
          aria-label={`Preview ${artifact.artifactName}`}
          aria-describedby={availability ? availabilityId : undefined}
          disabled={!canPreviewArtifact(artifact)}
          onClick={() => props.onPreview(artifact)}
        >
          Preview
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-10 sm:h-8"
          aria-label={`${props.isDownloading ? "Downloading" : "Download"} ${artifact.artifactName}`}
          aria-describedby={availability ? availabilityId : undefined}
          disabled={!canDownloadArtifact(artifact) || props.isDownloading}
          onClick={() => props.onDownload(artifact.artifactId)}
        >
          {props.isDownloading ? "Downloading…" : "Download"}
        </Button>
      </div>
    </div>
  );
}

export function ArtifactBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [state, setState] = useState<ArtifactBrowserFilterState>(() =>
    parseArtifactFilterState(new URLSearchParams(searchParams.toString()))
  );

  // The search box fires on every keystroke. Debounce the query term so neither
  // the URL nor the backend request updates per character; the non-text filters
  // (type/status/kind/sort) commit immediately.
  const [debouncedQ, setDebouncedQ] = useState(state.q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQ(state.q), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [state.q]);

  // The settled state that drives both the URL and the query: the live filters
  // with the debounced query substituted in. Keystrokes only move `state.q`;
  // this updates 300ms later (or immediately for a non-text filter change).
  const settledState = useMemo<ArtifactBrowserFilterState>(
    () => ({ ...state, q: debouncedQ }),
    [state, debouncedQ]
  );

  // Sync the settled filters to the URL so the view is bookmarkable.
  useEffect(() => {
    const qs = artifactFilterStateToSearchString(settledState);
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [settledState, pathname, router]);

  const filters = useMemo(() => artifactFilterStateToParams(settledState), [settledState]);
  const { artifacts, error, isLoading, hasMore, isLoadingMore, loadMore, isRetrying, retry } =
    useArtifactBrowserData(filters);

  const onError = useCallback((message: string) => toast.error(message), []);
  const actions = useArtifactActions({ onError });

  // Live filters drive the Clear button (appears as soon as the user types);
  // settled filters drive the empty-state copy (matches what was queried).
  const hasFilters = artifactSearchHasAnyFilter(
    new URLSearchParams(artifactFilterStateToSearchString(state))
  );
  const hasSettledFilters = Boolean(settledState.q.trim() || settledState.type.length || settledState.status.length || settledState.mimeClass.length);

  const clearFilters = useCallback(() => {
    setState(EMPTY_ARTIFACT_FILTER_STATE);
    setDebouncedQ(""); // clear the query immediately, don't wait out the debounce
  }, []);

  const previewTarget = artifacts.find(artifact => artifact.artifactId === actions.previewArtifactId);

  return (
    <section aria-label="Artifact library" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label="Search artifacts by name"
          placeholder="Search by name…"
          value={state.q}
          onChange={(event) => setState((s) => ({ ...s, q: event.target.value }))}
          className="w-full sm:w-64"
        />
        <MultiSelectFilter
          label="Source"
          options={ARTIFACT_TYPE_OPTIONS}
          optionLabel={(value) => ARTIFACT_TYPE_LABELS[value as keyof typeof ARTIFACT_TYPE_LABELS]}
          selected={state.type}
          onToggle={(value) => setState((s) => ({ ...s, type: toggleInArray(s.type, value) }))}
        />
        <MultiSelectFilter
          label="File status"
          options={ARTIFACT_STATUS_OPTIONS}
          optionLabel={(value) => ARTIFACT_STATUS_LABELS[value as keyof typeof ARTIFACT_STATUS_LABELS]}
          selected={state.status}
          onToggle={(value) => setState((s) => ({ ...s, status: toggleInArray(s.status, value) }))}
        />
        <MultiSelectFilter
          label="File format"
          options={ARTIFACT_MIME_CLASS_OPTIONS}
          selected={state.mimeClass}
          optionLabel={(value) => ARTIFACT_MIME_CLASS_LABELS[value as keyof typeof ARTIFACT_MIME_CLASS_LABELS]}
          onToggle={(value) => setState((s) => ({ ...s, mimeClass: toggleInArray(s.mimeClass, value) }))}
        />
        <Select
          value={state.sort}
          onValueChange={(value) => setState((s) => ({ ...s, sort: value as ArtifactBrowserFilterState["sort"] }))}
        >
          <SelectTrigger aria-label="Sort artifacts" size="sm" className="h-10 w-44 sm:h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ARTIFACT_SORT_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {ARTIFACT_SORT_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearFilters}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="space-y-2 text-sm text-danger">
          <p>{error}</p>
          {artifacts.length > 0 ? <p className="text-on-surface-variant">Your loaded artifacts are still shown.</p> : null}
          {artifacts.length === 0 || !hasMore ? (
            <Button type="button" variant="outline" size="sm" disabled={isRetrying} onClick={retry}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {!error || artifacts.length > 0 ? (
        <div role={artifacts.length ? "list" : undefined} aria-label={artifacts.length ? "Artifacts" : undefined} className="rounded-lg border border-outline-variant bg-surface">
          {isLoading ? (
            <p role="status" className="px-4 py-8 text-center text-sm text-on-surface-variant">Loading artifacts…</p>
          ) : artifacts.length === 0 ? (
            <div className="space-y-3 px-4 py-8 text-center text-sm">
              <h2 className="font-medium text-on-surface">{hasSettledFilters ? "No artifacts match these filters." : "No artifacts yet."}</h2>
              {hasSettledFilters ? (
                <Button type="button" variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button>
              ) : (
                <p className="mx-auto max-w-prose text-on-surface-variant">Upload a file in a session or ask the assistant to create one. Files from your sessions appear here when you have access.</p>
              )}
            </div>
          ) : (
            artifacts.map((artifact) => (
              <ArtifactBrowserRow
                key={artifact.artifactId}
                artifact={artifact}
                isDownloading={actions.downloadArtifactId === artifact.artifactId}
                onPreview={(a) => void actions.openPreview(a)}
                onDownload={(id) => void actions.handleDownloadArtifact(id)}
              />
            ))
          )}
        </div>
      ) : null}

      {hasMore ? (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="sm" disabled={isLoadingMore} onClick={loadMore}>
            {isLoadingMore ? "Loading more…" : error ? "Retry loading more" : "Load more"}
          </Button>
        </div>
      ) : null}

      {actions.previewArtifactId ? (
        <ArtifactPreviewModal
          artifactName={actions.previewName}
          mimeType={actions.previewMimeType}
          content={actions.previewContent}
          imageUrl={actions.previewImageUrl}
          error={actions.previewError}
          onRetry={previewTarget && canPreviewArtifact(previewTarget) && !exceedsTextPreviewLimit(previewTarget) ? () => { void actions.openPreview(previewTarget); } : undefined}
          onClose={actions.closePreview}
        />
      ) : null}
    </section>
  );
}
