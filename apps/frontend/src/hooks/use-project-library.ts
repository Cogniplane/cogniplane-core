"use client";

import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import * as api from "../lib/project-file-api";
import { queryKeys } from "../lib/query-keys";
import { uniquePageItems } from "../lib/unique-page-items";

// Disabled queries never fetch. Each hook gets its own key so that cache
// entries for different data shapes cannot collide.
const disabledKey = (name: string) => ["projects", "library-disabled", name] as const;

type Filters<T> = Omit<T, "cursor" | "limit">;

export function useProjectLibraryFiles(
  projectId: string,
  filters: Filters<api.ProjectLibraryFilesParams>,
) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.projects.libraryFiles(projectId, filters);
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      api.listProjectLibraryFiles(projectId, { ...filters, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = useMemo(
    () => uniquePageItems(query.data?.pages, (file) => file.fileId),
    [query.data],
  );
  // A later page can report that a file changed after the first page. The
  // scroll can then miss that file.
  const listChanged = query.data?.pages.some((page) => page.listChanged) ?? false;
  // Drops the loaded pages and loads the list again from the first page.
  const reload = () => queryClient.resetQueries({ queryKey, exact: true });
  return { query, items, listChanged, reload };
}

export function useProjectFolders(
  projectId: string,
  filters: Filters<api.ProjectFolderListParams>,
  enabled = true,
) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.projects.libraryFolders(projectId, filters),
    queryFn: ({ pageParam, signal }) =>
      api.listProjectFolders(projectId, { ...filters, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
  });
  const items = useMemo(
    () => uniquePageItems(query.data?.pages, (folder) => folder.folderId),
    [query.data],
  );
  return { query, items };
}

export function useProjectFolder(projectId: string, folderId: string | null) {
  return useQuery({
    queryKey: folderId
      ? queryKeys.projects.libraryFolder(projectId, folderId)
      : disabledKey("folder"),
    queryFn: ({ signal }) => api.getProjectFolder(projectId, folderId!, signal),
    enabled: Boolean(folderId),
  });
}

export function useProjectFilePicker(
  projectId: string | null,
  filters: Filters<api.ProjectFilePickerParams>,
  enabled = true,
) {
  const query = useInfiniteQuery({
    queryKey: projectId
      ? queryKeys.projects.libraryPicker(projectId, filters)
      : disabledKey("picker"),
    queryFn: ({ pageParam, signal }) =>
      api.listProjectFilePicker(projectId!, { ...filters, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: enabled && Boolean(projectId),
  });
  const items = useMemo(
    () => uniquePageItems(query.data?.pages, (file) => file.fileId),
    [query.data],
  );
  return { query, items };
}

/**
 * Loads the exact files in `fileIds` (at most 20). A file that the response
 * leaves out was deleted, moved to Trash, or is no longer accessible.
 * While a changed ID list loads, the previous result stays as placeholder data.
 * Check `isPlaceholderData` before you treat an absent ID as removed.
 */
export function useProjectFileSelection(projectId: string | null, fileIds: string[]) {
  const sortedIds = useMemo(() => [...new Set(fileIds)].sort(), [fileIds]);
  return useQuery({
    queryKey: projectId && sortedIds.length > 0
      ? queryKeys.projects.librarySelection(projectId, sortedIds)
      : disabledKey("selection"),
    queryFn: ({ signal }) => api.getProjectFilePickerSelection(projectId!, sortedIds, signal),
    enabled: Boolean(projectId) && sortedIds.length > 0,
    placeholderData: keepPreviousData,
  });
}
