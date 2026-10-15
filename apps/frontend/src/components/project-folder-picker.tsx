"use client";

import { useId, useState } from "react";
import type { ProjectFolderDetail } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useProjectFolder, useProjectFolders } from "@/hooks/use-project-library";
import { folderDetailPath } from "./project-files.logic";

/** Breadcrumb buttons for a folder. `detail` is undefined at the root or while it loads. */
export function FolderBreadcrumbs({
  detail,
  onNavigate,
}: {
  detail: ProjectFolderDetail | undefined;
  onNavigate: (folderId: string | null) => void;
}) {
  return (
    <>
      <Button type="button" size="xs" variant="ghost" onClick={() => onNavigate(null)}>
        Files
      </Button>
      {detail?.ancestorsTruncated ? <span className="text-sm">/ …</span> : null}
      {detail?.ancestors.map((ancestor) => (
        <span key={ancestor.folderId} className="flex items-center gap-1 text-sm">
          /
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onNavigate(ancestor.folderId)}
          >
            {ancestor.name}
          </Button>
        </span>
      ))}
      {detail ? (
        <span aria-current="location" className="text-sm font-medium">
          / {detail.folder.name}
        </span>
      ) : null}
    </>
  );
}

type FolderDestination = {
  status: "live" | "missing" | "loading";
  label: string;
  /** For a deleted folder, the nearest live folder above it. An empty `folderId` is the Files root. */
  nearestLive?: { folderId: string; name: string };
};

/**
 * Status of a chosen destination. An empty `folderId` is the Files root.
 * A removed or unreadable folder is "missing" and cannot receive files.
 */
export function useFolderDestination(projectId: string, folderId: string): FolderDestination {
  const detail = useProjectFolder(projectId, folderId || null);
  if (!folderId) return { status: "live", label: "Files" };
  if (detail.isError) return { status: "missing", label: "Missing folder" };
  if (detail.data?.folder.deletedAt) {
    const nearestId = detail.data.nearestLiveFolderId;
    // The ancestor list can be truncated, so the nearest folder name is not always known.
    const name = nearestId === null
      ? "Files"
      : detail.data.ancestors.find((ancestor) => ancestor.folderId === nearestId)?.name ??
        "nearest live folder";
    return {
      status: "missing",
      label: "Missing folder",
      nearestLive: { folderId: nearestId ?? "", name },
    };
  }
  if (!detail.data) return { status: "loading", label: "Loading folder..." };
  return { status: "live", label: folderDetailPath(detail.data) };
}

/**
 * Chooses a destination folder. It browses one folder level at a time and
 * searches every live folder by name, so it can reach any folder in the project.
 */
export function FolderDestinationPicker({
  projectId,
  label,
  value,
  onChange,
  disabled = false,
}: {
  projectId: string;
  label: string;
  /** Chosen folder ID. An empty string is the Files root. */
  value: string;
  onChange: (folderId: string) => void;
  disabled?: boolean;
}) {
  const labelId = useId();
  const [browseId, setBrowseId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim());
  const destination = useFolderDestination(projectId, value);
  const nearestLive = destination.nearestLive;
  const browse = useProjectFolder(projectId, browseId);
  const folders = useProjectFolders(
    projectId,
    q ? { q } : { parentId: browseId ?? undefined },
  );
  const browseName = browseId ? browse.data?.folder.name : "Files";
  const open = (folderId: string) => {
    setSearch("");
    setBrowseId(folderId);
  };
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="flex flex-col gap-2 rounded-md border border-outline-variant p-3"
    >
      <span id={labelId} className="text-sm font-medium">
        {label}
      </span>
      <p className="text-sm" aria-live="polite">
        Selected: <span className="font-medium">{destination.label}</span>
      </p>
      {destination.status === "missing" ? (
        <p role="status" className="text-sm text-danger">
          Missing folder. Choose a destination.
        </p>
      ) : null}
      {nearestLive ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="self-start"
          disabled={disabled}
          onClick={() => onChange(nearestLive.folderId)}
        >
          Choose nearest folder: {nearestLive.name}
        </Button>
      ) : null}
      <Input
        aria-label={`${label} search`}
        placeholder="Search folders"
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
      />
      {!q ? (
        <div className="flex flex-wrap items-center gap-1">
          <FolderBreadcrumbs
            detail={browseId ? browse.data : undefined}
            onNavigate={setBrowseId}
          />
          {browseName ? (
            <Button
              type="button"
              size="xs"
              variant={value === (browseId ?? "") ? "default" : "outline"}
              aria-pressed={value === (browseId ?? "")}
              disabled={disabled}
              onClick={() => onChange(browseId ?? "")}
            >
              Choose {browseName}
            </Button>
          ) : null}
        </div>
      ) : null}
      {folders.query.isError ? (
        <div role="alert" className="flex items-center gap-2 text-sm">
          Could not load folders.
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => void folders.query.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {folders.query.isSuccess && folders.items.length === 0 ? (
        <p className="text-sm text-on-surface-variant">
          {q ? "No folder names match your search." : "No folders here."}
        </p>
      ) : null}
      {folders.items.length > 0 ? (
        <ul className="max-h-48 divide-y divide-outline-variant overflow-y-auto">
          {folders.items.map((folder) => {
            const name = q ? folder.path : folder.name;
            const chosen = value === folder.folderId;
            return (
              <li key={folder.folderId} className="flex items-center gap-2 py-1">
                <span className="min-w-0 flex-1 break-words text-sm">{name}</span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label={`Open ${name}`}
                  onClick={() => open(folder.folderId)}
                >
                  Open
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant={chosen ? "default" : "outline"}
                  aria-label={`Choose ${name}`}
                  aria-pressed={chosen}
                  disabled={disabled}
                  onClick={() => onChange(folder.folderId)}
                >
                  {chosen ? "Chosen" : "Choose"}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {folders.query.hasNextPage ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="self-start"
          disabled={folders.query.isFetchingNextPage}
          onClick={() => void folders.query.fetchNextPage()}
        >
          {folders.query.isFetchingNextPage ? "Loading..." : "More folders"}
        </Button>
      ) : null}
    </div>
  );
}
