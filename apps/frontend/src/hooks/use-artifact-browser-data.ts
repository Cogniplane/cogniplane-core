"use client";

import { useInfiniteQuery } from "@tanstack/react-query";

import { browseArtifacts, type ArtifactBrowseParams } from "../lib/artifact-api";
import { isRouteNotFoundError, toRouteUnavailableMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type { Artifact, ArtifactBrowseResponse } from "@cogniplane/shared-types";

// Cursor is owned by pagination, not the caller — strip it from the cache key
// so paging doesn't spawn a new query each page.
type ArtifactBrowseFilters = Omit<ArtifactBrowseParams, "cursor">;

export function useArtifactBrowserData(filters: ArtifactBrowseFilters = {}) {
  const query = useInfiniteQuery<ArtifactBrowseResponse>({
    queryKey: queryKeys.artifacts.browse(filters as Record<string, unknown>),
    queryFn: ({ pageParam }) =>
      browseArtifacts({
        ...filters,
        cursor: typeof pageParam === "string" ? pageParam : undefined
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined
  });

  const loadError = query.error;
  const available = loadError ? !isRouteNotFoundError(loadError, "GET", "/artifacts") : true;
  const artifacts: Artifact[] = available
    ? query.data?.pages.flatMap((page) => page.items) ?? []
    : [];
  const errorMessage = loadError
    ? toRouteUnavailableMessage(loadError, {
        method: "GET",
        pathPrefix: "/artifacts",
        featureName: "Artifact browser",
        fallback: "Failed to load artifacts."
      })
    : null;

  return {
    artifacts,
    error: errorMessage,
    available,
    isLoading: query.isLoading,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    }
  };
}
