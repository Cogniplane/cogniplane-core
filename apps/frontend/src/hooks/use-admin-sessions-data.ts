"use client";

import { useState } from "react";

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
    queryKey: queryKeys.admin.sessions(params),
    queryFn: ({ pageParam }) =>
      listAdminSessions({
        ...params,
        cursor: typeof pageParam === "string" ? pageParam : undefined
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined
  });

  const [retryFailure, setRetryFailure] = useState<{ scope: string | null; error: unknown } | null>(null);
  const scope = JSON.stringify(params);
  const loadError = sessionsQuery.error ?? (sessionsQuery.isFetching && retryFailure?.scope === scope ? retryFailure.error : null);
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
    hasData: sessionsQuery.data !== undefined,
    isRefreshing: sessionsQuery.isFetching && !sessionsQuery.isFetchingNextPage,
    retry: () => {
      if (sessionsQuery.isFetching) return;
      const failure = { scope, error: sessionsQuery.error };
      setRetryFailure(failure);
      void sessionsQuery.refetch({ cancelRefetch: false }).finally(() => setRetryFailure(current => current === failure ? null : current));
    },
    hasMore: sessionsQuery.hasNextPage,
    isLoadingMore: sessionsQuery.isFetchingNextPage,
    loadMore: () => {
      if (sessionsQuery.hasNextPage && !sessionsQuery.isFetchingNextPage) {
        void sessionsQuery.fetchNextPage({ cancelRefetch: false });
      }
    }
  };
}
