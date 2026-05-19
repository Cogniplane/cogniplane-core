"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PencilIcon, PinIcon, SearchIcon, SettingsIcon, Trash2Icon } from "lucide-react";

import { useAuth } from "../lib/auth-context";
import { API_URL } from "../lib/api-client";
import type { Session } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { formatCompactTime, groupSessions, initialsOf, totalGroupedCount } from "./session-sidebar.logic";

export function SessionSidebar(props: {
  sessions: Session[];
  selectedSessionId: string | null;
  isLoadingSessions: boolean;
  busySessionId: string | null;
  streamingSessionIds: Set<string>;
  errorSessionId: string | null;
  renameSessionId: string | null;
  renameDraft: string;
  pinnedSessionIds: Set<string>;
  attentionSessionIds?: Set<string>;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onStartRename: (session: Session) => void;
  onCancelRename: () => void;
  onConfirmRename: (sessionId: string) => void;
  onRenameDraftChange: (draft: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string) => void;
  pendingDeleteSessionId: string | null;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [backendVersion, setBackendVersion] = useState<{ sha: string; buildDate: string } | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/health`)
      .then((r) => r.json())
      .then((data: { version?: { sha: string; buildDate: string } }) => {
        if (data.version) setBackendVersion(data.version);
      })
      .catch(() => {});
  }, []);

  const feSha = (process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev").slice(0, 7);
  const feDate = (process.env.NEXT_PUBLIC_BUILD_DATE ?? "").slice(0, 10);
  const beSha = backendVersion?.sha.slice(0, 7);
  const beDate = backendVersion?.buildDate.slice(0, 10);

  const groups = useMemo(
    () => groupSessions(props.sessions, props.pinnedSessionIds, query),
    [props.sessions, props.pinnedSessionIds, query]
  );

  const hasResults = totalGroupedCount(groups) > 0;
  const pendingDeleteSession = props.pendingDeleteSessionId
    ? props.sessions.find((s) => s.sessionId === props.pendingDeleteSessionId)
    : null;

  const renderSessionRow = (session: Session) => {
    const isActive = session.sessionId === props.selectedSessionId;
    const isPinned = props.pinnedSessionIds.has(session.sessionId);
    const isStreaming = props.streamingSessionIds.has(session.sessionId);
    const needsAttention = props.attentionSessionIds?.has(session.sessionId) ?? false;
    const hasError = props.errorSessionId === session.sessionId;
    const busy = props.busySessionId === session.sessionId;

    if (props.renameSessionId === session.sessionId) {
      return (
        <form
          key={session.sessionId}
          className="flex items-center gap-2 px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            props.onConfirmRename(session.sessionId);
          }}
        >
          <Input
            autoFocus
            disabled={busy}
            onChange={(event) => props.onRenameDraftChange(event.target.value)}
            value={props.renameDraft}
            className="h-7 flex-1 text-sm"
          />
          <Button type="submit" size="xs" disabled={busy || !props.renameDraft.trim()}>
            Save
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={props.onCancelRename}>
            Cancel
          </Button>
        </form>
      );
    }

    return (
      <article
        key={session.sessionId}
        className={`group relative flex items-center gap-1 px-3 py-2 transition-colors ${
          isActive ? "bg-surface-container" : "hover:bg-surface-container-low"
        }`}
      >
        <button
          type="button"
          onClick={() => props.onSelectSession(session.sessionId)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
        >
          <span
            className={`min-w-0 flex-1 truncate text-sm ${
              needsAttention ? "font-semibold text-warning" : isActive ? "font-medium text-on-surface" : "text-on-surface-variant"
            }`}
          >
            {session.sessionName}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-on-surface-faint">
            {needsAttention ? (
              <span aria-label="Needs attention" className="size-1.5 rounded-full bg-warning" />
            ) : isStreaming ? (
              <span aria-label="Streaming" className="size-1.5 animate-pulse rounded-full bg-accent" />
            ) : hasError ? (
              <span aria-label="Error" className="size-1.5 rounded-full bg-danger" />
            ) : (
              <span>{formatCompactTime(session.updatedAt)}</span>
            )}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[active=true]:opacity-100" data-active={isActive}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={isPinned ? "Unpin session" : "Pin session"}
            aria-pressed={isPinned}
            disabled={busy}
            onClick={() => props.onTogglePinSession(session.sessionId)}
          >
            <PinIcon className={isPinned ? "fill-current" : ""} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Rename session"
            disabled={busy}
            onClick={() => props.onStartRename(session)}
          >
            <PencilIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Delete session"
            disabled={busy}
            onClick={() => props.onDeleteSession(session.sessionId)}
          >
            <Trash2Icon className="text-danger" />
          </Button>
        </div>
      </article>
    );
  };

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden bg-surface-container-low">
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <Image src="/brand/cogniplane.svg" alt="Cogniplane logo" width={40} height={40} priority />
        <div className="min-w-0">
          <p className="text-[0.62rem] font-bold uppercase tracking-[0.12em] text-on-surface-faint">
            Control Room
          </p>
          <h1 className="truncate text-sm font-semibold text-on-surface">Cogniplane</h1>
        </div>
      </div>

      <div className="relative px-3 pb-2">
        <SearchIcon className="pointer-events-none absolute left-5 top-1/2 size-4 -translate-y-1/2 text-on-surface-faint" />
        <Input
          aria-label="Search sessions"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions"
          type="text"
          value={query}
          className="h-8 pl-8 text-sm"
        />
      </div>

      <div className="px-3 pb-2">
        <Button type="button" variant="outline" className="w-full" onClick={props.onCreateSession}>
          New chat
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto pb-2">
        {groups.pinned.length > 0 ? (
          <SessionGroupSection title="Pinned" count={groups.pinned.length}>
            {groups.pinned.map(renderSessionRow)}
          </SessionGroupSection>
        ) : null}
        {groups.today.length > 0 ? (
          <SessionGroupSection title="Today" count={groups.today.length}>
            {groups.today.map(renderSessionRow)}
          </SessionGroupSection>
        ) : null}
        {groups.earlier.length > 0 ? (
          <SessionGroupSection title="Earlier" count={groups.earlier.length}>
            {groups.earlier.map(renderSessionRow)}
          </SessionGroupSection>
        ) : null}
        {groups.improvement.length > 0 ? (
          <SessionGroupSection title="Skill improvement" count={groups.improvement.length}>
            {groups.improvement.map(renderSessionRow)}
          </SessionGroupSection>
        ) : null}

        {!hasResults && !props.isLoadingSessions ? (
          <div className="mx-3 my-4 rounded-md bg-surface-container-lowest p-4 text-sm text-on-surface-variant">
            {props.sessions.length ? (
              <>
                <p className="font-medium text-on-surface">No matches</p>
                <p>Try a different search.</p>
              </>
            ) : (
              <>
                <p className="font-medium text-on-surface">No sessions yet</p>
                <p>Create a session to start a conversation.</p>
              </>
            )}
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between border-t border-outline-variant px-4 py-1.5 text-[0.65rem] font-mono text-on-surface-faint">
        <span title={`Frontend: ${process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev"} · ${process.env.NEXT_PUBLIC_BUILD_DATE ?? ""}`}>
          fe · {feSha}{feDate ? ` · ${feDate}` : ""}
        </span>
        {beSha ? (
          <span title={`Backend: ${backendVersion?.sha} · ${backendVersion?.buildDate}`}>
            be · {beSha}{beDate ? ` · ${beDate}` : ""}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2 border-t border-outline-variant px-3 py-2">
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {initialsOf(user?.displayName, user?.email)}
        </span>
        <div className="min-w-0 flex-1 text-xs">
          <div className="truncate font-medium text-on-surface">
            {user?.displayName ?? user?.email ?? "Signed out"}
          </div>
          {user?.email && user.displayName ? (
            <div className="truncate text-on-surface-faint">{user.email}</div>
          ) : null}
        </div>
        <Button asChild variant="ghost" size="icon-sm" aria-label="Settings">
          <Link href="/settings">
            <SettingsIcon />
          </Link>
        </Button>
      </div>

      <AlertDialog
        open={props.pendingDeleteSessionId != null}
        onOpenChange={(open) => {
          if (!open) props.onCancelDelete();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this session?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteSession
                ? `"${pendingDeleteSession.sessionName}" and all its messages will be permanently deleted.`
                : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={props.busySessionId === props.pendingDeleteSessionId}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={props.onConfirmDelete}
              disabled={props.busySessionId === props.pendingDeleteSessionId}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {props.busySessionId === props.pendingDeleteSessionId ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

function SessionGroupSection(props: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between px-4 pt-3 pb-1 text-[0.62rem] font-bold uppercase tracking-[0.12em] text-on-surface-faint">
        <span>{props.title}</span>
        <span>{props.count}</span>
      </div>
      {props.children}
    </div>
  );
}
