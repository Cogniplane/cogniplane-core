"use client";

import { useInfiniteQuery, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { SESSION_TRASH_RETENTION_DAYS, type ProjectDetail, type Session } from "@cogniplane/shared-types";
import { listArchivedSessions, listSessions, type SessionList } from "../lib/session-api";
import { listProjectSessions } from "../lib/project-api";
import { queryKeys } from "../lib/query-keys";

export function flattenSessionPages(data: InfiniteData<SessionList>): SessionList {
  const byId = new Map<string, Session>();
  for (const page of data.pages) {
    for (const session of page.sessions) {
      if (!byId.has(session.sessionId)) byId.set(session.sessionId, session);
    }
  }
  return {
    sessions: [...byId.values()],
    trashRetentionDays: data.pages[0]?.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS,
    nextCursor: data.pages.at(-1)?.nextCursor
  };
}

export function useProjectSessionPages(input: {
  projectId: string;
  status: "active" | "archived" | "deleted";
  detail?: ProjectDetail;
  updatedAt: number;
  enabled: boolean;
}) {
  const { projectId, status, detail, updatedAt, enabled } = input;
  return useInfiniteQuery({
    queryKey: ["projects", projectId, "sessions", status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => listProjectSessions(projectId, { status, cursor: pageParam, signal }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Reuse the bounded first pages already returned with the project details.
    initialData: detail ? {
      pages: [{
        sessions: status === "deleted" ? detail.trash?.sessions ?? []
          : detail.sessions.filter((session) => session.status === status),
        nextCursor: status === "deleted" ? detail.trash?.nextCursor : detail.sessionCursors?.[status],
        trashRetentionDays: detail.trash?.retentionDays ?? SESSION_TRASH_RETENTION_DAYS
      }],
      pageParams: [undefined]
    } : undefined,
    initialDataUpdatedAt: updatedAt,
    staleTime: 30_000,
    select: flattenSessionPages,
    enabled: enabled && Boolean(detail)
  });
}

export function useSessionPages(input: {
  status?: "active" | "archived";
  search?: string;
  personalOnly?: boolean;
  enabled?: boolean;
  poll?: boolean;
} = {}) {
  const { status = "active", search = "", personalOnly = false, enabled = true, poll = false } = input;
  const normalizedSearch = search.trim();
  const [settledSearch, setSettledSearch] = useState(normalizedSearch);
  useEffect(() => {
    const timer = setTimeout(() => setSettledSearch(normalizedSearch), 300);
    return () => clearTimeout(timer);
  }, [normalizedSearch]);
  // Clearing search restores the unfiltered list immediately.
  const effectiveSearch = normalizedSearch ? settledSearch : "";
  const isDebouncing = normalizedSearch !== effectiveSearch;
  const queryEnabled = enabled && !isDebouncing;
  const queryKey = useMemo(() => [
    ...(status === "archived" ? queryKeys.sessions.archived() : queryKeys.sessions.list()),
    "pages", { search: effectiveSearch, personalOnly }
  ], [status, effectiveSearch, personalOnly]);
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => (status === "archived" ? listArchivedSessions : listSessions)({
      cursor: pageParam, search: effectiveSearch, personalOnly, signal
    }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: flattenSessionPages,
    enabled: queryEnabled,
    refetchInterval: queryEnabled && poll ? 10_000 : false,
    refetchOnWindowFocus: true
  });
  return {
    ...query, queryKey,
    // Do not offer rows or a page cursor from the previous search term.
    data: isDebouncing ? undefined : query.data,
    isPending: isDebouncing || query.isPending,
    isSuccess: !isDebouncing && query.isSuccess,
    isError: !isDebouncing && query.isError,
    hasNextPage: !isDebouncing && query.hasNextPage
  };
}

// Update every loaded page and lookup after a mutation without changing cursors.
export function updateSessionCaches(client: QueryClient, update: (rows: Session[]) => Session[]) {
  client.setQueriesData<InfiniteData<SessionList> | SessionList>({ queryKey: queryKeys.sessions.all }, (data) => {
    if (!data) return data;
    if ("pages" in data) return { ...data, pages: data.pages.map((page) => ({ ...page, sessions: update(page.sessions) })) };
    if ("sessions" in data) return { ...data, sessions: update(data.sessions) };
    return data;
  });
}
