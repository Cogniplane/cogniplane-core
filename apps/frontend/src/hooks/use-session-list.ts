"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "../lib/auth-context";
import {
  createSession as apiCreateSession,
  archiveSession as apiArchiveSession,
  deleteSession as apiDeleteSession,
  listSessions,
  renameSession as apiRenameSession
} from "../lib/session-api";
import { createProjectSession as apiCreateProjectSession } from "../lib/project-api";
import { SESSION_TRASH_RETENTION_DAYS, type Session } from "@cogniplane/shared-types";
import { queryKeys } from "../lib/query-keys";

const SELECTED_SESSION_KEY = "cogniplane:selected-session-id:v1";
const PINNED_SESSIONS_KEY_PREFIX = "cogniplane:pinned-sessions:v1:";

function readPersistedSessionId(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_SESSION_KEY);
  } catch {
    return null;
  }
}

function persistSelectedSessionId(sessionId: string | null): void {
  try {
    if (sessionId === null) {
      window.localStorage.removeItem(SELECTED_SESSION_KEY);
    } else {
      window.localStorage.setItem(SELECTED_SESSION_KEY, sessionId);
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

function readPinnedSessionIds(userId: string | undefined): Set<string> {
  if (!userId) return new Set();
  try {
    const raw = window.localStorage.getItem(PINNED_SESSIONS_KEY_PREFIX + userId);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writePinnedSessionIds(userId: string | undefined, ids: Set<string>): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(PINNED_SESSIONS_KEY_PREFIX + userId, JSON.stringify([...ids]));
  } catch {
    // Ignore storage errors
  }
}

export function useSessionList(input?: { enabled?: boolean; syncUrl?: boolean }) {
  const enabled = input?.enabled ?? true;
  const syncUrl = input?.syncUrl ?? false;
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions.list(),
    queryFn: () => listSessions(),
    enabled,
    refetchInterval: enabled ? 10_000 : false,
    refetchOnWindowFocus: true,
    structuralSharing: true
  });

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(() => new Set());
  const [mutationError, setMutationError] = useState<string | null>(null);

  useEffect(() => {
    // SSR-safe localStorage hydration: lazy init would cause hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPinnedSessionIds(readPinnedSessionIds(user?.userId));
  }, [user?.userId]);

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
    if (sessionsQuery.status !== "success") return;
    if (sessions.length === 0) {
      if (syncUrl) syncSessionLink(null);
      setHasRestored(true);
      return;
    }
    const linkedId = syncUrl && window.location.pathname === "/"
      ? new URLSearchParams(window.location.search).get("session") : null;
    const persisted = sessions.some((session) => session.sessionId === linkedId)
      ? linkedId : readPersistedSessionId();
    const restoredId = sessions.find((s) => s.sessionId === persisted)?.sessionId ?? sessions[0].sessionId;
    setSelectedSessionId(restoredId);
    persistSelectedSessionId(restoredId);
    if (syncUrl) syncSessionLink(restoredId);
    setHasRestored(true);
  }, [enabled, hasRestored, sessionsQuery.status, sessions, syncUrl]);

  useEffect(() => {
    if (!enabled || !hasRestored || !syncUrl) return;
    const restoreFromHistory = () => {
      if (window.location.pathname !== "/") return;
      const linkedId = new URLSearchParams(window.location.search).get("session");
      const sessionId = sessions.find((session) => session.sessionId === linkedId)?.sessionId
        ?? sessions.find((session) => session.sessionId === readPersistedSessionId())?.sessionId
        ?? sessions[0]?.sessionId ?? null;
      setSelectedSessionId(sessionId);
      persistSelectedSessionId(sessionId);
      syncSessionLink(sessionId);
    };
    window.addEventListener("popstate", restoreFromHistory);
    return () => window.removeEventListener("popstate", restoreFromHistory);
  }, [enabled, hasRestored, sessions, syncUrl]);

  // Surface query errors through the hook's `error` derived during render (no
  // effect/extra state). Polling errors stay hidden — only non-refetch failures
  // surface, matching the original UX. A mutation error takes precedence.
  const queryError =
    sessionsQuery.status === "error" && !sessionsQuery.isRefetching
      ? sessionsQuery.error instanceof Error
        ? sessionsQuery.error.message
        : "Failed to load sessions"
      : null;
  const error = mutationError ?? queryError;

  const activeListKey = queryKeys.sessions.list();

  const invalidateSessions = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions.list() }),
    [queryClient]
  );

  const createMutation = useMutation({
    mutationFn: ({ sessionName, projectId }: { sessionName: string; projectId: string | null }) =>
      projectId ? apiCreateProjectSession(projectId, sessionName) : apiCreateSession(sessionName),
    onSuccess: (session: Session) => {
      queryClient.setQueryData<Session[]>(activeListKey, (prev) =>
        prev ? [session, ...prev] : [session]
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
      setSelectedSessionId(session.sessionId);
      persistSelectedSessionId(session.sessionId);
      if (syncUrl) syncSessionLink(session.sessionId, "push");
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : "Failed to create session")
  });

  const renameMutation = useMutation({
    mutationFn: ({ sessionId, nextName }: { sessionId: string; nextName: string }) =>
      apiRenameSession(sessionId, nextName),
    onSuccess: (updated, variables) => {
      queryClient.setQueryData<Session[]>(activeListKey, (prev) =>
        prev ? prev.map((s) => (s.sessionId === variables.sessionId ? updated : s)) : prev
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : "Failed to rename session")
  });

  const deleteMutation = useMutation({
    mutationFn: apiDeleteSession,
    onSuccess: (_unused, sessionId) => {
      // Work out the fallback before the cache write, so the updater stays a
      // pure prev → next function with no selection side effects inside it.
      const remaining = (
        queryClient.getQueryData<Session[]>(activeListKey) ?? []
      ).filter((s) => s.sessionId !== sessionId);
      queryClient.setQueryData<Session[]>(activeListKey, remaining);
      if (selectedSessionId === sessionId) {
        const fallbackId = remaining.length > 0 ? remaining[0].sessionId : null;
        setSelectedSessionId(fallbackId);
        persistSelectedSessionId(fallbackId);
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
        writePinnedSessionIds(user?.userId, next);
        return next;
      });
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : "Failed to delete session")
  });

  const archiveMutation = useMutation({
    mutationFn: apiArchiveSession,
    onSuccess: (_session, sessionId) => {
      const remaining = (queryClient.getQueryData<Session[]>(activeListKey) ?? [])
        .filter((session) => session.sessionId !== sessionId);
      queryClient.setQueryData(activeListKey, remaining);
      if (selectedSessionId === sessionId) {
        const fallbackId = remaining[0]?.sessionId ?? null;
        setSelectedSessionId(fallbackId);
        persistSelectedSessionId(fallbackId);
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
    persistSelectedSessionId(sessionId);
    if (syncUrl) syncSessionLink(sessionId, "push");
  }, [syncUrl]);

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
        writePinnedSessionIds(user?.userId, next);
        return next;
      });
    },
    [user?.userId]
  );

  const busySessionId =
    (archiveMutation.isPending ? archiveMutation.variables : null) ??
    (renameMutation.isPending ? renameMutation.variables?.sessionId : null) ??
    (deleteMutation.isPending ? deleteMutation.variables : null) ??
    null;

  return {
    sessions,
    trashRetentionDays: sessionsQuery.data?.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS,
    selectedSessionId,
    selectedSession,
    isLoadingSessions: sessionsQuery.isPending && enabled,
    error,
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
