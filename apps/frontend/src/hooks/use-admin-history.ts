"use client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { listAdminHistory, type HistoryFilters } from "../lib/admin-history-api";
import { queryKeys } from "../lib/query-keys";

export function useAdminHistory(filters: HistoryFilters = {}, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.admin.historyList(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => listAdminHistory({ ...filters, cursor: pageParam, limit: 25 }, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled, refetchOnWindowFocus: true, refetchInterval: 60_000
  });
}
export function useRecentAdminHistory(filters: HistoryFilters, limit: number) {
  return useQuery({
    queryKey: queryKeys.admin.historyRecent(filters, limit),
    queryFn: ({ signal }) => listAdminHistory({ ...filters, limit }, signal),
    refetchOnWindowFocus: true, refetchInterval: 60_000
  });
}
