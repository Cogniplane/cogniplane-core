"use client";

import { useMemo, useState } from "react";
import type { ProjectFilePickerEntry } from "@cogniplane/shared-types";

import { useDebouncedValue } from "../hooks/use-debounced-value";
import { useProjectFilePicker } from "../hooks/use-project-library";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export const MAX_PROJECT_FILE_SELECTIONS = 20;

function FileCheckbox({
  file,
  checked,
  disabled,
  onToggle,
}: {
  file: ProjectFilePickerEntry;
  checked: boolean;
  disabled: boolean;
  onToggle: (fileId: string) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(file.fileId)}
        disabled={disabled}
        className="mt-0.5"
      />
      <span className="min-w-0 break-words">
        {file.name}{file.kind === "draft" ? " (draft)" : ""}
      </span>
    </label>
  );
}

/**
 * Chooses project files for the next chat turn. Search and "More results"
 * load picker pages. Selected files come from `selectedEntries`, so they stay
 * visible when a search or page does not include them.
 */
export function ProjectFileSelection({
  projectId,
  selectedIds,
  selectedEntries,
  unavailableCount,
  checkingCount = 0,
  lookupFailed = false,
  lookupKeptLastCheck = false,
  onRetryLookup,
  onToggle,
}: {
  projectId: string;
  selectedIds: string[];
  /** Current data for the selected IDs, from the selection endpoint. */
  selectedEntries: ProjectFilePickerEntry[];
  /** Number of selected files that were removed because they are no longer available. */
  unavailableCount: number;
  /** Number of selected files that the selection lookup did not confirm yet. */
  checkingCount?: number;
  /** True when the selection lookup failed. Unconfirmed files are not sent. */
  lookupFailed?: boolean;
  /** True when a refetch failed but the last lookup result stays. Those files are still sent. */
  lookupKeptLastCheck?: boolean;
  onRetryLookup?: () => void;
  onToggle: (fileId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim());
  const picker = useProjectFilePicker(projectId, { q: q || undefined, kind: "any" });
  const atLimit = selectedIds.length >= MAX_PROJECT_FILE_SELECTIONS;
  const groups = useMemo(() => {
    const grouped = new Map<string, ProjectFilePickerEntry[]>();
    for (const file of picker.items) {
      const group = grouped.get(file.folderPath) ?? [];
      group.push(file);
      grouped.set(file.folderPath, group);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [picker.items]);
  const otherSelected = useMemo(() => {
    const listed = new Set(picker.items.map((file) => file.fileId));
    return selectedEntries.filter(
      (file) => selectedIds.includes(file.fileId) && !listed.has(file.fileId),
    );
  }, [picker.items, selectedEntries, selectedIds]);
  // Hide the section only when the project has no files to choose.
  const noFiles = !q && selectedIds.length === 0 &&
    (picker.query.isPending || (picker.query.isSuccess && picker.items.length === 0));
  if (noFiles && unavailableCount === 0) return null;
  const checkbox = (file: ProjectFilePickerEntry) => {
    const checked = selectedIds.includes(file.fileId);
    return (
      <FileCheckbox
        key={file.fileId}
        file={file}
        checked={checked}
        disabled={!checked && atLimit}
        onToggle={onToggle}
      />
    );
  };
  return (
    <section aria-labelledby="project-file-selection-title" className="border-b border-outline-variant p-4">
      <h2 id="project-file-selection-title" className="text-sm font-semibold">Project files</h2>
      <p className="mt-1 text-xs text-on-surface-variant">
        Prioritize up to {MAX_PROJECT_FILE_SELECTIONS} files for this turn. Other published files remain available when they are in the captured snapshot.
      </p>
      {unavailableCount > 0 ? (
        <p role="status" className="mt-2 text-xs text-danger">
          {unavailableCount === 1
            ? "1 selected file is no longer available. It was removed from your selection."
            : `${unavailableCount} selected files are no longer available. They were removed from your selection.`}
        </p>
      ) : null}
      {lookupFailed ? (
        <div role="alert" className="mt-2 flex items-center gap-2 text-xs text-danger">
          {lookupKeptLastCheck
            ? "Could not check the selected files again. A turn sent now includes the files from the last check."
            : "Could not check the selected files. A turn sent now does not include them."}
          {onRetryLookup ? (
            <Button size="xs" variant="ghost" onClick={onRetryLookup}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : checkingCount > 0 ? (
        <p role="status" className="mt-2 text-xs text-on-surface-variant">
          {checkingCount === 1
            ? "Checking 1 selected file. A turn sent now does not include it."
            : `Checking ${checkingCount} selected files. A turn sent now does not include them.`}
        </p>
      ) : null}
      <Input
        aria-label="Search project files"
        className="mt-3"
        placeholder="Search project files"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <p className="mt-2 text-xs text-on-surface-variant">
        {selectedIds.length}/{MAX_PROJECT_FILE_SELECTIONS} prioritized
      </p>
      <div className="mt-3 max-h-[min(38vh,22rem)] space-y-4 overflow-y-auto pr-1">
        {otherSelected.length > 0 ? (
          <section aria-label="Other selected files">
            <h3 className="mb-2 text-xs font-medium text-on-surface-variant">Other selected files</h3>
            <div className="space-y-2">{otherSelected.map(checkbox)}</div>
          </section>
        ) : null}
        {groups.map(([folder, entries]) => (
          <section key={folder} aria-label={folder}>
            <h3 className="mb-2 text-xs font-medium text-on-surface-variant">{folder}</h3>
            <div className="space-y-2">{entries.map(checkbox)}</div>
          </section>
        ))}
        {picker.query.isError ? (
          <div role="alert" className="flex items-center gap-2 text-sm">
            Could not load project files.
            <Button size="xs" variant="ghost" onClick={() => void picker.query.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}
        {picker.query.isSuccess && groups.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No project files match this search.</p>
        ) : null}
        {picker.query.hasNextPage ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={picker.query.isFetchingNextPage}
            onClick={() => void picker.query.fetchNextPage()}
          >
            {picker.query.isFetchingNextPage ? "Loading..." : "More results"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
