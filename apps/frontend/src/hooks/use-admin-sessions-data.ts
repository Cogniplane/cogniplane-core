"use client";

import { useInfiniteQuery } from "@tanstack/react-query";

import { listAdminSessions } from "../lib/admin-api";
import { isRouteNotFoundError, toRouteUnavailableMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import type {
  AdminSessionRow,
  AdminSessionsListParams,
  AdminSessionsListResponse
} from "@cogniplane/shared-types";

export function useAdminSessionsData(params: AdminSessionsListParams = {}) {
  const sessionsQuery = useInfiniteQuery<AdminSessionsListResponse>({
    queryKey: queryKeys.admin.sessions(params as Record<string, unknown>),
    queryFn: ({ pageParam }) =>
      listAdminSessions({
        ...params,
        cursor: typeof pageParam === "string" ? pageParam : undefined
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined
  });

  const loadError = sessionsQuery.error;
  const available = loadError ? !isRouteNotFoundError(loadError, "GET", "/admin/sessions") : true;
  const sessions: AdminSessionRow[] = available
    ? sessionsQuery.data?.pages.flatMap((page) => page.items) ?? []
    : [];
  const errorMessage = loadError
    ? toRouteUnavailableMessage(loadError, {
        method: "GET",
        pathPrefix: "/admin/sessions",
        featureName: "Session review",
        fallback: "Failed to load sessions."
      })
    : null;

  return {
    sessions,
    error: errorMessage,
    available,
    isLoading: sessionsQuery.isLoading,
    hasMore: sessionsQuery.hasNextPage,
    isLoadingMore: sessionsQuery.isFetchingNextPage,
    loadMore: () => {
      if (sessionsQuery.hasNextPage && !sessionsQuery.isFetchingNextPage) {
        void sessionsQuery.fetchNextPage();
      }
    }
  };
}
