"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "../lib/auth-context";
import {
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  listSessions,
  renameSession as apiRenameSession
} from "../lib/session-api";
import type { Session } from "@cogniplane/shared-types";
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

export function useSessionList(input?: { enabled?: boolean }) {
  const enabled = input?.enabled ?? true;
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
  const [error, setError] = useState<string | null>(null);

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
      // First-successful-load: restore persisted selection or pick the first
      // session. Guarded by hasRestored so it runs once per mount, not on poll ticks.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedSessionId(null);
      setHasRestored(false);
      return;
    }
    if (hasRestored) return;
    if (sessionsQuery.status !== "success") return;
    if (sessions.length === 0) {
      setHasRestored(true);
      return;
    }
    const persisted = readPersistedSessionId();
    const restoredId = sessions.find((s) => s.sessionId === persisted)?.sessionId ?? sessions[0].sessionId;
    setSelectedSessionId(restoredId);
    setHasRestored(true);
  }, [enabled, hasRestored, sessionsQuery.status, sessions]);

  // Surface query errors through the hook's `error` so consumers keep their
  // existing UX (the original silently ignored polling errors; we preserve
  // that by only surfacing errors from non-polling fetches).
  useEffect(() => {
    if (sessionsQuery.status === "error" && !sessionsQuery.isRefetching) {
      const err = sessionsQuery.error;
      // Mirror query error to the hook's error surface for consumers.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    }
  }, [sessionsQuery.status, sessionsQuery.isRefetching, sessionsQuery.error]);

  const activeListKey = queryKeys.sessions.list();

  const invalidateSessions = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all }),
    [queryClient]
  );

  const createMutation = useMutation({
    mutationFn: (sessionName: string) => apiCreateSession(sessionName),
    onSuccess: (session: Session) => {
      queryClient.setQueryData<Session[]>(activeListKey, (prev) =>
        prev ? [session, ...prev] : [session]
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
      setSelectedSessionId(session.sessionId);
      persistSelectedSessionId(session.sessionId);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to create session")
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
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to rename session")
  });

  const deleteMutation = useMutation({
    mutationFn: apiDeleteSession,
    onSuccess: (_unused, sessionId) => {
      queryClient.setQueryData<Session[]>(activeListKey, (prev) => {
        const next = (prev ?? []).filter((s) => s.sessionId !== sessionId);
        if (selectedSessionId === sessionId) {
          const fallbackId = next.length > 0 ? next[0].sessionId : null;
          setSelectedSessionId(fallbackId);
          persistSelectedSessionId(fallbackId);
        }
        return next;
      });
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
    onError: (err) => setError(err instanceof Error ? err.message : "Failed to delete session")
  });

  const selectedSession = useMemo(
    () => sessions.find((s) => s.sessionId === selectedSessionId) ?? null,
    [sessions, selectedSessionId]
  );

  const selectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    persistSelectedSessionId(sessionId);
  }, []);

  const createSession = useCallback(async () => {
    setError(null);
    createMutation.mutate(`Session ${sessions.length + 1}`);
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
        setError("Session name cannot be empty.");
        return;
      }
      setError(null);
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
    setError(null);
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
    (renameMutation.isPending && renameMutation.variables?.sessionId) ||
    (deleteMutation.isPending && typeof deleteMutation.variables === "string"
      ? deleteMutation.variables
      : null) ||
    null;

  return {
    sessions,
    selectedSessionId,
    selectedSession,
    isLoadingSessions: sessionsQuery.isPending && enabled,
    error,
    setError,
    selectSession,
    createSession,
    renameSessionId,
    renameDraft,
    setRenameDraft,
    startRename,
    cancelRename,
    confirmRename,
    renameSessionDirect,
    busySessionId,
    deleteSession: deleteSessionHandler,
    pendingDeleteSessionId,
    cancelDelete,
    confirmDelete,
    pinnedSessionIds,
    togglePinSession,
    reload: invalidateSessions
  };
}
