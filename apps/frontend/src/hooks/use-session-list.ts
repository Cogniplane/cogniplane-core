"use client";

import { useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "../lib/auth-context";
import {
  createSession as apiCreateSession,
  archiveSession as apiArchiveSession,
  deleteSession as apiDeleteSession,
  listSessions,
  type SessionList,
  renameSession as apiRenameSession
} from "../lib/session-api";
import { createProjectSession as apiCreateProjectSession } from "../lib/project-api";
import { SESSION_TRASH_RETENTION_DAYS, type Session } from "@cogniplane/shared-types";
import { useSessionPages, updateSessionCaches } from "./use-session-pages";
import { queryKeys } from "../lib/query-keys";

// Both keys are scoped to one organization and one user. A person who belongs
// to several organizations must not see, poll or change another organization's
// selection or pins.
const SELECTED_SESSION_KEY_PREFIX = "cogniplane:selected-session-id:v2:";
const PINNED_SESSIONS_KEY_PREFIX = "cogniplane:pinned-sessions:v2:";

// The v1 keys mixed the ids of all of a person's organizations, so they are
// removed, not migrated.
function removeUnscopedKeys(userId: string | undefined): void {
  try {
    window.localStorage.removeItem("cogniplane:selected-session-id:v1");
    if (userId) window.localStorage.removeItem(`cogniplane:pinned-sessions:v1:${userId}`);
  } catch {
    // Ignore storage errors
  }
}

function storageScope(user: { tenantId: string; userId: string } | null | undefined): string | null {
  return user ? `${user.tenantId}:${user.userId}` : null;
}

function readPersistedSessionId(scope: string | null): string | null {
  if (!scope) return null;
  try {
    return window.localStorage.getItem(SELECTED_SESSION_KEY_PREFIX + scope);
  } catch {
    return null;
  }
}

function persistSelectedSessionId(scope: string | null, sessionId: string | null): void {
  if (!scope) return;
  try {
    if (sessionId === null) {
      window.localStorage.removeItem(SELECTED_SESSION_KEY_PREFIX + scope);
    } else {
      window.localStorage.setItem(SELECTED_SESSION_KEY_PREFIX + scope, sessionId);
    }
  } catch {
    // Ignore storage errors
  }
}

function syncSessionLink(sessionId: string | null, mode: "push" | "replace" = "replace"): void {
  const url = new URL(window.location.href);
  if (url.pathname !== "/") return;
  if (sessionId === null) url.searchParams.delete("session");
  else url.searchParams.set("session", sessionId);
  if (url.href === window.location.href) return;
  if (mode === "push") window.history.pushState(window.history.state, "", url);
  else window.history.replaceState(window.history.state, "", url);
}

function readPinnedSessionIds(scope: string | null): Set<string> {
  if (!scope) return new Set();
  try {
    const raw = window.localStorage.getItem(PINNED_SESSIONS_KEY_PREFIX + scope);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writePinnedSessionIds(scope: string | null, ids: Set<string>): void {
  if (!scope) return;
  try {
    window.localStorage.setItem(PINNED_SESSIONS_KEY_PREFIX + scope, JSON.stringify([...ids]));
  } catch {
    // Ignore storage errors
  }
}

export function useSessionList(input?: { enabled?: boolean; syncUrl?: boolean }) {
  const enabled = input?.enabled ?? true;
  const syncUrl = input?.syncUrl ?? false;
  const { user } = useAuth();
  const scope = storageScope(user);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const sessionsQuery = useSessionPages({ enabled, poll: true });
  const searchQuery = useSessionPages({ search, enabled: enabled && Boolean(search.trim()) });

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(() => new Set());
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [restoreIds, setRestoreIds] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const baseSessions = useMemo(() => sessionsQuery.data?.sessions ?? [], [sessionsQuery.data?.sessions]);
  const lookupIds = useMemo(() => {
    const loadedIds = new Set(baseSessions.map((session) => session.sessionId));
    return [...new Set([...restoreIds, ...pinnedSessionIds, ...(selectedSessionId ? [selectedSessionId] : [])])]
      .filter((id) => id.length > 0 && id.length <= 200 && !id.includes(",") && !loadedIds.has(id)).sort();
  }, [baseSessions, restoreIds, pinnedSessionIds, selectedSessionId]);
  const lookupQuery = useQuery({
    queryKey: [...queryKeys.sessions.list(), "lookup", lookupIds],
    queryFn: async ({ signal }): Promise<SessionList> => {
      const rows: Session[] = [];
      // Bound each request even when a user has saved more than 100 pins.
      for (let offset = 0; offset < lookupIds.length; offset += 100) {
        const page = await listSessions({ ids: lookupIds.slice(offset, offset + 100), signal });
        rows.push(...page.sessions);
      }
      return { sessions: rows, trashRetentionDays: sessionsQuery.data?.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS };
    },
    enabled: enabled && hydrated && sessionsQuery.isSuccess && lookupIds.length > 0,
    refetchInterval: enabled ? 10_000 : false
  });
  const listedSessions = useMemo(() => {
    const rows = new Map(baseSessions.map((session) => [session.sessionId, session]));
    for (const session of lookupQuery.data?.sessions ?? []) rows.set(session.sessionId, session);
    return [...rows.values()];
  }, [baseSessions, lookupQuery.data?.sessions]);
  const sessions = useMemo(() => {
    if (!search.trim() || !searchQuery.data) return listedSessions;
    const rows = new Map(listedSessions.map((session) => [session.sessionId, session]));
    for (const session of searchQuery.data.sessions) rows.set(session.sessionId, session);
    return [...rows.values()];
  }, [listedSessions, search, searchQuery.data]);

  useEffect(() => {
    // SSR-safe localStorage hydration: lazy init would cause hydration mismatch.
    // The QueryProvider in lib/auth-context.tsx is keyed by user and tenant, so
    // a scope change mounts this hook again with fresh selection state.
    removeUnscopedKeys(user?.userId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPinnedSessionIds(readPinnedSessionIds(scope));
    const linked = syncUrl && window.location.pathname === "/" ? new URLSearchParams(window.location.search).get("session") : null;
    setRestoreIds([linked, readPersistedSessionId(scope)].filter((id): id is string => Boolean(id)));
    setHydrated(true);
  }, [scope, syncUrl, user?.userId]);

  // First-successful-load effect: restore the persisted selection or fall back
  // to the first session. Guarded by a local ref-ish state so we only restore
  // once per mount, not on every poll tick.
  const [hasRestored, setHasRestored] = useState(false);
  useEffect(() => {
    if (!enabled) {
      // Disabled (signed out): drop the selection and re-arm the restore so a
      // later sign-in restores again. Prop-change reset, not a render loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedSessionId(null);
      if (hasRestored && syncUrl) syncSessionLink(null);
      setHasRestored(false);
      return;
    }
    if (hasRestored) return;
    if (sessionsQuery.status !== "success" || !hydrated) return;
    if (lookupIds.length > 0 && !lookupQuery.isSuccess) return;
    if (listedSessions.length === 0) {
      setSelectedSessionId(null);
      persistSelectedSessionId(scope, null);
      if (syncUrl) syncSessionLink(null);
      setHasRestored(true);
      return;
    }
    const linkedId = syncUrl && window.location.pathname === "/"
      ? new URLSearchParams(window.location.search).get("session") : null;
    const persisted = listedSessions.some((session) => session.sessionId === linkedId)
      ? linkedId : readPersistedSessionId(scope);
    const restoredId = listedSessions.find((s) => s.sessionId === persisted)?.sessionId ?? listedSessions[0].sessionId;
    setSelectedSessionId(restoredId);
    persistSelectedSessionId(scope, restoredId);
    if (syncUrl) syncSessionLink(restoredId);
    setHasRestored(true);
  }, [enabled, hasRestored, sessionsQuery.status, listedSessions, syncUrl, hydrated, lookupIds.length, lookupQuery.isSuccess, scope]);

  useEffect(() => {
    if (!enabled || !syncUrl) return;
    const restoreFromHistory = () => {
      if (window.location.pathname !== "/") return;
      const linkedId = new URLSearchParams(window.location.search).get("session");
      const sessionId = linkedId ?? readPersistedSessionId(scope);
      setRestoreIds(sessionId ? [sessionId] : []);
      setHasRestored(false);
    };
    window.addEventListener("popstate", restoreFromHistory);
    return () => window.removeEventListener("popstate", restoreFromHistory);
  }, [enabled, syncUrl, scope]);

  // Surface query errors through the hook's `error` derived during render (no
  // effect/extra state). Polling errors stay hidden — only non-refetch failures
  // surface, matching the original UX. A mutation error takes precedence.
  const queryError =
    sessionsQuery.status === "error" && !sessionsQuery.isRefetching
      ? sessionsQuery.error instanceof Error
        ? sessionsQuery.error.message
        : "Failed to load sessions"
      : null;
  const listError = queryError ?? (lookupQuery.isError ? "Could not load saved sessions. Try again." : null)
    ?? (search.trim() && searchQuery.isError ? "Could not search sessions. Try again." : null);
  const error = mutationError ?? listError;

  const activeListKey = sessionsQuery.queryKey;

  const invalidateSessions = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions.list() }),
    [queryClient]
  );

  const createMutation = useMutation({
    mutationFn: ({ sessionName, projectId }: { sessionName: string; projectId: string | null }) =>
      projectId ? apiCreateProjectSession(projectId, sessionName) : apiCreateSession(sessionName),
    onSuccess: (session: Session) => {
      queryClient.setQueryData<InfiniteData<SessionList>>(activeListKey, (prev) => prev ? {
        ...prev, pages: prev.pages.map((page, index) => index === 0 ? { ...page, sessions: [session, ...page.sessions] } : page)
      } : { pages: [{ sessions: [session], trashRetentionDays: SESSION_TRASH_RETENTION_DAYS }], pageParams: [undefined] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
      setSelectedSessionId(session.sessionId);
      persistSelectedSessionId(scope, session.sessionId);
      if (syncUrl) syncSessionLink(session.sessionId, "push");
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : "Failed to create session")
  });

  const renameMutation = useMutation({
    mutationFn: ({ sessionId, nextName }: { sessionId: string; nextName: string }) =>
      apiRenameSession(sessionId, nextName),
    onSuccess: (updated, variables) => {
      updateSessionCaches(queryClient, (rows) => rows.map((s) => s.sessionId === variables.sessionId ? updated : s));
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : "Failed to rename session")
  });

  const deleteMutation = useMutation({
    mutationFn: apiDeleteSession,
    onSuccess: (_unused, sessionId) => {
      // Work out the fallback before the cache write, so the updater stays a
      // pure prev → next function with no selection side effects inside it.
      const remaining = listedSessions.filter((s) => s.sessionId !== sessionId);
      updateSessionCaches(queryClient, (rows) => rows.filter((s) => s.sessionId !== sessionId));
      setRestoreIds((ids) => ids.filter((id) => id !== sessionId));
      if (selectedSessionId === sessionId) {
        const fallbackId = remaining.length > 0 ? remaining[0].sessionId : null;
        setSelectedSessionId(fallbackId);
        persistSelectedSessionId(scope, fallbackId);
        if (syncUrl) syncSessionLink(fallbackId);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
      if (renameSessionId === sessionId) {
        setRenameSessionId(null);
        setRenameDraft("");
      }
      setPinnedSessionIds((current) => {
        if (!current.has(sessionId)) return current;
        const next = new Set(current);
        next.delete(sessionId);
        writePinnedSessionIds(scope, next);
        return next;
      });
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : "Failed to delete session")
  });

  const archiveMutation = useMutation({
    mutationFn: apiArchiveSession,
    onSuccess: (_session, sessionId) => {
      const remaining = listedSessions.filter((session) => session.sessionId !== sessionId);
      updateSessionCaches(queryClient, (rows) => rows.filter((s) => s.sessionId !== sessionId));
      setRestoreIds((ids) => ids.filter((id) => id !== sessionId));
      if (selectedSessionId === sessionId) {
        const fallbackId = remaining[0]?.sessionId ?? null;
        setSelectedSessionId(fallbackId);
        persistSelectedSessionId(scope, fallbackId);
        if (syncUrl) syncSessionLink(fallbackId);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : "Failed to archive session")
  });

  const selectedSession = useMemo(
    () => sessions.find((s) => s.sessionId === selectedSessionId) ?? null,
    [sessions, selectedSessionId]
  );

  const selectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    persistSelectedSessionId(scope, sessionId);
    if (syncUrl) syncSessionLink(sessionId, "push");
  }, [syncUrl, scope]);

  const createSession = useCallback(async (projectId: string | null = null) => {
    setMutationError(null);
    await createMutation.mutateAsync({
      sessionName: `Session ${sessions.length + 1}`,
      projectId
    });
  }, [createMutation, sessions.length]);

  const startRename = useCallback((session: Session) => {
    setRenameSessionId(session.sessionId);
    setRenameDraft(session.sessionName);
  }, []);

  const cancelRename = useCallback(() => {
    setRenameSessionId(null);
    setRenameDraft("");
  }, []);

  const renameSessionDirect = useCallback(
    async (sessionId: string, nextName: string) => {
      const trimmed = nextName.trim();
      if (!trimmed) {
        setMutationError("Session name cannot be empty.");
        return;
      }
      setMutationError(null);
      renameMutation.mutate({ sessionId, nextName: trimmed });
    },
    [renameMutation]
  );

  const confirmRename = useCallback(
    async (sessionId: string) => {
      await renameSessionDirect(sessionId, renameDraft);
      setRenameSessionId(null);
      setRenameDraft("");
    },
    [renameDraft, renameSessionDirect]
  );

  const deleteSessionHandler = useCallback((sessionId: string) => {
    setPendingDeleteSessionId(sessionId);
  }, []);

  const cancelDelete = useCallback(() => {
    setPendingDeleteSessionId(null);
  }, []);

  const confirmDelete = useCallback(async () => {
    const sessionId = pendingDeleteSessionId;
    if (!sessionId) return;
    setPendingDeleteSessionId(null);
    setMutationError(null);
    deleteMutation.mutate(sessionId);
  }, [deleteMutation, pendingDeleteSessionId]);

  const togglePinSession = useCallback(
    (sessionId: string) => {
      setPinnedSessionIds((current) => {
        const next = new Set(current);
        if (next.has(sessionId)) {
          next.delete(sessionId);
        } else {
          next.add(sessionId);
        }
        writePinnedSessionIds(scope, next);
        return next;
      });
    },
    [scope]
  );

  const busySessionId =
    (archiveMutation.isPending ? archiveMutation.variables : null) ??
    (renameMutation.isPending ? renameMutation.variables?.sessionId : null) ??
    (deleteMutation.isPending ? deleteMutation.variables : null) ??
    null;

  const visibleQuery = search.trim() ? searchQuery : sessionsQuery;
  return {
    sessions,
    sidebarSessions: search.trim() ? searchQuery.data?.sessions ?? [] : sessions,
    search,
    setSearch,
    hasMore: visibleQuery.hasNextPage,
    isLoadingMore: visibleQuery.isFetchingNextPage,
    loadMore: () => { if (!visibleQuery.isFetching) void visibleQuery.fetchNextPage(); },
    isSearching: Boolean(search.trim()) && searchQuery.isPending,
    retry: () => {
      if (visibleQuery.isFetchNextPageError) void visibleQuery.fetchNextPage();
      else void invalidateSessions();
    },
    trashRetentionDays: sessionsQuery.data?.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS,
    selectedSessionId,
    selectedSession,
    isLoadingSessions: sessionsQuery.isPending && enabled,
    error,
    listError,
    setError: setMutationError,
    selectSession,
    createSession,
    isCreatingSession: createMutation.isPending,
    renameSessionId,
    renameDraft,
    setRenameDraft,
    startRename,
    cancelRename,
    confirmRename,
    renameSessionDirect,
    busySessionId,
    archiveSession: (sessionId: string) => {
      setMutationError(null);
      archiveMutation.mutate(sessionId);
    },
    deleteSession: deleteSessionHandler,
    pendingDeleteSessionId,
    cancelDelete,
    confirmDelete,
    pinnedSessionIds,
    togglePinSession,
    reload: invalidateSessions
  };
}
