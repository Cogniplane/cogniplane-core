"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ARTIFACT_TYPE_OPTIONS,
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
  formatPiiLabel,
  getArtifactOrigin,
  piiTone,
  type PiiTone
} from "./artifact-panel.logic";
import { ArtifactPreviewModal } from "./artifact-preview-modal";
import { canPreviewArtifact } from "../lib/artifact-preview";
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

const PILL_GRAY =
  "inline-flex items-center rounded-full bg-surface-container px-2 py-0.5 text-xs font-medium text-on-surface-variant";

const PII_TONE_CLASS: Record<PiiTone, string> = {
  neutral: PILL_GRAY,
  pending: "inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent",
  blocked: "inline-flex items-center rounded-full bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger",
  failed: "inline-flex items-center rounded-full bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger",
  transformed: "inline-flex items-center rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success"
};

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
        <Button type="button" variant="outline" size="sm">
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
  const piiLabel = pii ? formatPiiLabel(pii) : null;

  return (
    <div className="flex items-center gap-3 border-b border-outline-variant px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-on-surface" title={artifact.artifactName}>
          {artifact.artifactName}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className={PILL_GRAY}>{getArtifactOrigin(artifact)}</span>
          <span className="text-xs text-on-surface-faint">{classifyMimeClass(artifact.mimeType)}</span>
          <span className="text-xs text-on-surface-faint">·</span>
          <span className="text-xs text-on-surface-faint">{formatFileSize(artifact.fileSizeBytes)}</span>
          {artifact.status !== "ready" ? (
            <span className={PILL_GRAY}>{formatArtifactStatus(artifact.status)}</span>
          ) : null}
          {piiLabel ? <span className={PII_TONE_CLASS[piiTone(pii!)]}>{piiLabel}</span> : null}
        </div>
      </div>

      <time className="hidden shrink-0 text-xs text-on-surface-faint sm:block" dateTime={artifact.createdAt}>
        {new Date(artifact.createdAt).toLocaleDateString()}
      </time>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!canPreviewArtifact(artifact)}
          onClick={() => props.onPreview(artifact)}
        >
          Preview
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canDownloadArtifact(artifact) || props.isDownloading}
          onClick={() => props.onDownload(artifact.artifactId)}
        >
          {props.isDownloading ? "…" : "Download"}
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
  const { artifacts, error, isLoading, hasMore, isLoadingMore, loadMore } =
    useArtifactBrowserData(filters);

  const onError = useCallback((message: string) => toast.error(message), []);
  const actions = useArtifactActions({ onError });

  // Live filters drive the Clear button (appears as soon as the user types);
  // settled filters drive the empty-state copy (matches what was queried).
  const hasFilters = artifactSearchHasAnyFilter(
    new URLSearchParams(artifactFilterStateToSearchString(state))
  );
  const hasSettledFilters = artifactSearchHasAnyFilter(
    new URLSearchParams(artifactFilterStateToSearchString(settledState))
  );

  const clearFilters = useCallback(() => {
    setState(EMPTY_ARTIFACT_FILTER_STATE);
    setDebouncedQ(""); // clear the query immediately, don't wait out the debounce
  }, []);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search by name…"
          value={state.q}
          onChange={(event) => setState((s) => ({ ...s, q: event.target.value }))}
          className="w-56"
        />
        <MultiSelectFilter
          label="Type"
          options={ARTIFACT_TYPE_OPTIONS}
          selected={state.type}
          onToggle={(value) => setState((s) => ({ ...s, type: toggleInArray(s.type, value) }))}
        />
        <MultiSelectFilter
          label="Status"
          options={ARTIFACT_STATUS_OPTIONS}
          selected={state.status}
          onToggle={(value) => setState((s) => ({ ...s, status: toggleInArray(s.status, value) }))}
        />
        <MultiSelectFilter
          label="Kind"
          options={ARTIFACT_MIME_CLASS_OPTIONS}
          selected={state.mimeClass}
          optionLabel={(value) => ARTIFACT_MIME_CLASS_LABELS[value as keyof typeof ARTIFACT_MIME_CLASS_LABELS]}
          onToggle={(value) => setState((s) => ({ ...s, mimeClass: toggleInArray(s.mimeClass, value) }))}
        />
        <Select
          value={state.sort}
          onValueChange={(value) => setState((s) => ({ ...s, sort: value as ArtifactBrowserFilterState["sort"] }))}
        >
          <SelectTrigger size="sm" className="w-44">
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

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <div className="rounded-lg border border-outline-variant">
        {isLoading ? (
          <p className="px-3 py-8 text-center text-sm text-on-surface-faint">Loading artifacts…</p>
        ) : artifacts.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-on-surface-faint">
            {hasSettledFilters ? "No artifacts match these filters." : "No artifacts yet."}
          </p>
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

      {hasMore ? (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="sm" disabled={isLoadingMore} onClick={loadMore}>
            {isLoadingMore ? "Loading…" : "Load more"}
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
          onClose={actions.closePreview}
        />
      ) : null}
    </section>
  );
}
