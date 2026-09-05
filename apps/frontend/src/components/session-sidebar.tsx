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
import { Skeleton } from "@/components/ui/skeleton";
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

export type SessionSidebarListModel = {
  sessions: Session[];
  selectedId: string | null;
  isLoading: boolean;
  streamingIds: Set<string>;
  errorId: string | null;
  attentionIds?: Set<string>;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
};

export type SessionSidebarRenameModel = {
  busyId: string | null;
  sessionId: string | null;
  renameDraft: string;
  onStartRename: (session: Session) => void;
  onCancelRename: () => void;
  onConfirmRename: (sessionId: string) => void;
  onRenameDraftChange: (draft: string) => void;
};

export type SessionSidebarDeletionModel = {
  busyId: string | null;
  pendingId: string | null;
  onRequest: (sessionId: string) => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
};

export type SessionSidebarPinningModel = {
  busyId: string | null;
  ids: Set<string>;
  onToggle: (sessionId: string) => void;
};

export function SessionSidebar({ list, rename, deletion, pinning }: {
  list: SessionSidebarListModel;
  rename: SessionSidebarRenameModel;
  deletion: SessionSidebarDeletionModel;
  pinning: SessionSidebarPinningModel;
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
    () => groupSessions(list.sessions, pinning.ids, query),
    [list.sessions, pinning.ids, query]
  );

  const hasResults = totalGroupedCount(groups) > 0;
  const pendingDeleteSession = deletion.pendingId
    ? list.sessions.find((s) => s.sessionId === deletion.pendingId)
    : null;

  const renderSessionRow = (session: Session) => {
    const isActive = session.sessionId === list.selectedId;
    const isPinned = pinning.ids.has(session.sessionId);
    const isStreaming = list.streamingIds.has(session.sessionId);
    const needsAttention = list.attentionIds?.has(session.sessionId) ?? false;
    const hasError = list.errorId === session.sessionId;
    const busy =
      rename.busyId === session.sessionId ||
      deletion.busyId === session.sessionId ||
      pinning.busyId === session.sessionId;

    if (rename.sessionId === session.sessionId) {
      return (
        <form
          key={session.sessionId}
          className="flex items-center gap-2 px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            rename.onConfirmRename(session.sessionId);
          }}
        >
          <Input
            autoFocus
            disabled={busy}
            onChange={(event) => rename.onRenameDraftChange(event.target.value)}
            value={rename.renameDraft}
            className="h-7 flex-1 text-sm"
          />
          <Button type="submit" size="xs" disabled={busy || !rename.renameDraft.trim()}>
            Save
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={rename.onCancelRename}>
            Cancel
          </Button>
        </form>
      );
    }

    return (
      <article
        key={session.sessionId}
        className={`group relative mx-2 flex min-h-10 items-center gap-1 rounded-md px-2 py-2 transition-colors ${
          isActive
            ? "bg-brand-surface ring-1 ring-inset ring-brand-border"
            : "hover:bg-surface-container"
        }`}
      >
        <button
          type="button"
          onClick={() => list.onSelect(session.sessionId)}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-1"
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
              <span aria-label="Streaming" className="size-1.5 animate-pulse rounded-full bg-brand" />
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
            onClick={() => pinning.onToggle(session.sessionId)}
          >
            <PinIcon className={isPinned ? "fill-current" : ""} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Rename session"
            disabled={busy}
            onClick={() => rename.onStartRename(session)}
          >
            <PencilIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Delete session"
            disabled={busy}
            onClick={() => deletion.onRequest(session.sessionId)}
          >
            <Trash2Icon className="text-danger" />
          </Button>
        </div>
      </article>
    );
  };

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-container-low">
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
        <Button type="button" className="w-full" onClick={list.onCreate}>
          New chat
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto pb-2">
        {list.isLoading && list.sessions.length === 0 ? (
          <div className="flex flex-col gap-2 px-4 pt-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-2" style={{ opacity: 1 - i * 0.14 }}>
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-3 w-6" />
              </div>
            ))}
          </div>
        ) : null}
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

        {!hasResults && !list.isLoading ? (
          <div className="mx-3 my-4 rounded-md bg-surface-container-lowest p-4 text-sm text-on-surface-variant">
            {list.sessions.length ? (
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
        open={deletion.pendingId != null}
        onOpenChange={(open) => {
          if (!open) deletion.onCancelDelete();
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
            <AlertDialogCancel disabled={deletion.busyId === deletion.pendingId}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={deletion.onConfirmDelete}
              disabled={deletion.busyId === deletion.pendingId}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletion.busyId === deletion.pendingId ? "Deleting…" : "Delete"}
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
