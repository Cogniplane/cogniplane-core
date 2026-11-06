"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AlertCircleIcon, ArchiveIcon, ChevronDownIcon, ChevronRightIcon, FolderIcon, PinIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";

import { useAuth } from "../lib/auth-context";
import { SHORTCUTS, ariaKeyShortcut, useApplePlatform } from "../lib/keyboard-shortcuts";
import type { Project, Session } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SessionActionMenu } from "./session-action-menu";
import { SessionStatusIndicator } from "./session-status";
import { resolveSessionStatus } from "./session-status.logic";
import { formatCompactTime, groupSessions, initialsOf, totalGroupedCount } from "./session-sidebar.logic";

export type SessionSidebarListModel = {
  sessions: Session[];
  selectedId: string | null;
  isLoading: boolean;
  streamingIds: Set<string>;
  errorId: string | null;
  attentionIds?: Set<string>;
  onSelect: (sessionId: string) => void;
  onCreate: (projectId: string | null) => Promise<void>;
  /** Opens the New session dialog, which the workspace owns. */
  onNewSession: () => void;
  isCreating?: boolean;
  search?: string;
  onSearch?: (value: string) => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  error?: string | null;
  onRetry?: () => void;
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
  onRequest: (sessionId: string) => void;
};

export type SessionSidebarPinningModel = {
  busyId: string | null;
  ids: Set<string>;
  onToggle: (sessionId: string) => void;
};

export function SessionSidebar({ list, rename, deletion, pinning, archive, projects = [], onAddToProject }: {
  archive?: { onArchive: (sessionId: string) => void; busyId: string | null };
  projects?: Project[];
  onAddToProject?: (sessionId: string, projectId: string) => void | Promise<void>;
  list: SessionSidebarListModel;
  rename: SessionSidebarRenameModel;
  deletion: SessionSidebarDeletionModel;
  pinning: SessionSidebarPinningModel;
}) {
  const { user } = useAuth();
  const [localQuery, setLocalQuery] = useState("");
  const query = list.search ?? localQuery;
  const setQuery = list.onSearch ?? setLocalQuery;
  const apple = useApplePlatform();
  const [addSessionId, setAddSessionId] = useState<string | null>(null);
  const [addProjectId, setAddProjectId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [isAddingSession, setIsAddingSession] = useState(false);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const normalizedQuery = query.trim().toLowerCase();
  const serverSearch = Boolean(list.onSearch);
  const activeProjects = useMemo(
    () => projects.filter((project) => !project.archivedAt),
    [projects]
  );

  const groups = useMemo(
    () => groupSessions(
      list.sessions.filter((session) => !session.projectId),
      pinning.ids,
      serverSearch ? "" : query,
      undefined,
      list.attentionIds
    ),
    [list.sessions, pinning.ids, query, list.attentionIds, serverSearch]
  );

  const projectGroups = useMemo(
    () => activeProjects
      .map((project) => {
        const projectNameMatches = normalizedQuery !== "" && project.name.toLowerCase().includes(normalizedQuery);
        const sessions = list.sessions.filter((session) => session.projectId === project.projectId &&
          (serverSearch || !normalizedQuery || projectNameMatches || session.sessionName.toLowerCase().includes(normalizedQuery)));
        return { project, sessions, projectNameMatches };
      })
      .filter(({ projectNameMatches, sessions }) => !normalizedQuery || projectNameMatches || sessions.length > 0),
    [list.sessions, activeProjects, normalizedQuery, serverSearch]
  );
  const hasResults = totalGroupedCount(groups) > 0 || projectGroups.length > 0;
  const addSession = addSessionId ? list.sessions.find((session) => session.sessionId === addSessionId) : null;
  const selectedAddProjectId = activeProjects.some((project) => project.projectId === addProjectId)
    ? addProjectId
    : activeProjects[0]?.projectId ?? "";

  const renderSessionRow = (session: Session) => {
    const isActive = session.sessionId === list.selectedId;
    const isPinned = pinning.ids.has(session.sessionId);
    const isStreaming = list.streamingIds.has(session.sessionId);
    const needsAttention = list.attentionIds?.has(session.sessionId) ?? false;
    const hasError = list.errorId === session.sessionId || (!isStreaming && session.hasTurnFailed === true);
    const status = resolveSessionStatus({ pendingApproval: needsAttention, failed: hasError, running: isStreaming });
    const canAddToProject = !session.projectId && session.status === "active" && session.purpose === "normal";
    const canEdit = session.canEdit !== false;
    const busy =
      archive?.busyId === session.sessionId ||
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
            className="h-10 min-w-0 flex-1 text-base md:h-7 md:text-sm"
          />
          <Button type="submit" size="xs" className="h-10 md:h-6" disabled={busy || !rename.renameDraft.trim()}>
            Save
          </Button>
          <Button type="button" size="xs" variant="ghost" className="h-10 md:h-6" disabled={busy} onClick={rename.onCancelRename}>
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
          className="flex min-h-8 min-w-0 flex-1 flex-col items-start gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-1"
        >
          <span
            className={`w-full min-w-0 truncate text-sm ${
              needsAttention ? "font-semibold text-warning" : isActive ? "font-medium text-on-surface" : "text-on-surface-variant"
            }`}
          >
            {session.sessionName}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-on-surface-faint">
            <SessionStatusIndicator
              status={status}
              startedAt={session.activeTurnStartedAt}
            />
            {isPinned ? <PinIcon role="img" aria-label="Pinned session" className="size-3 fill-current" /> : null}
            {status === "ready" ? <span>{formatCompactTime(session.updatedAt)}</span> : null}
          </span>
        </button>
        <SessionActionMenu
          triggerClassName="size-10 md:size-8"
          sessionId={session.sessionId}
          sessionName={session.sessionName}
          isPinned={isPinned}
          busy={busy}
          isRunning={isStreaming || Boolean(session.isRunning)}
          hasPendingApprovals={needsAttention}
          onRename={canEdit ? () => rename.onStartRename(session) : undefined}
          onTogglePin={() => pinning.onToggle(session.sessionId)}
          onAddToProject={canAddToProject && onAddToProject && activeProjects.length > 0
            ? () => {
              setAddSessionId(session.sessionId);
              setAddProjectId(activeProjects[0]?.projectId ?? "");
              setAddError(null);
            }
            : undefined}
          onArchive={canEdit && archive ? () => archive.onArchive(session.sessionId) : undefined}
          onDelete={canEdit ? () => deletion.onRequest(session.sessionId) : undefined}
        />
      </article>
    );
  };

  return (
    <aside data-session-sidebar className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-container-low">
      <div className="sticky top-0 z-10 flex shrink-0 items-center gap-3 bg-surface-container-low px-4 pt-4 pb-2 pr-14">
        <Image src="/brand/cogniplane.svg" alt="Cogniplane logo" width={40} height={40} priority />
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold text-on-surface">Cogniplane</h1>
        </div>
      </div>

      <div className="px-3 pt-1 pb-2">
        {/* `relative` wraps the input only, so the icon centres on the input, not on its padding. */}
        <div className="relative">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-on-surface-faint" />
        <Input
          aria-label="Search sessions"
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions"
          type="text"
          value={query}
          className="h-10 pl-8 text-base md:h-8 md:text-sm"
        />
        </div>
      </div>

      <div className="px-3 pb-2">
        <Button type="button" className="h-10 w-full md:h-9" aria-keyshortcuts={ariaKeyShortcut(SHORTCUTS.newSession, apple)} onClick={list.onNewSession}>
          New session
        </Button>
      </div>

      <div data-session-sidebar-list className="flex-1 overflow-y-auto pb-2">
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
        {projectGroups.length > 0 ? (
          <div className="pt-2">
            <div className="flex items-center justify-between px-4 pb-1 text-xs font-semibold text-on-surface-variant">
              <span>Projects</span>
              <span>{activeProjects.length}</span>
            </div>
            {projectGroups.map(({ project, sessions }) => {
              const expanded = expandedProjectIds.has(project.projectId) || Boolean(normalizedQuery);
              const visibleSessions = expanded ? sessions : [];
              const attentionCount = sessions.filter((session) => list.attentionIds?.has(session.sessionId)).length;
              const pinnedCount = sessions.filter((session) => pinning.ids.has(session.sessionId)).length;
              const toggleExpanded = () => setExpandedProjectIds((current) => {
                const next = new Set(current);
                if (next.has(project.projectId)) next.delete(project.projectId);
                else next.add(project.projectId);
                return next;
              });
              return (
                <div key={project.projectId} className="px-2">
                  <div className="group flex min-h-10 items-center gap-1 rounded-md px-2 py-1 hover:bg-surface-container">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-10 md:size-6"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
                      onClick={toggleExpanded}
                    >
                      {expanded ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
                    </Button>
                    <Link
                      href={`/projects?project=${encodeURIComponent(project.projectId)}`}
                      aria-label={`Open ${project.name}`}
                      className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-sm py-1 text-left text-sm font-medium text-on-surface hover:text-brand-strong focus-visible:ring-2 focus-visible:ring-brand/60 md:min-h-0"
                    >
                      <FolderIcon className="size-4 shrink-0 text-brand-strong" />
                      <span className="truncate">{project.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-on-surface-faint" title="Loaded sessions">{sessions.length}</span>
                      {attentionCount > 0 ? (
                        <span
                          aria-label={`${attentionCount} session${attentionCount === 1 ? "" : "s"} needing attention`}
                          className="flex shrink-0 items-center gap-0.5 text-warning"
                          title="Sessions needing attention"
                        >
                          <AlertCircleIcon className="size-3.5" />
                          <span>{attentionCount}</span>
                        </span>
                      ) : null}
                      {pinnedCount > 0 ? (
                        <span
                          aria-label={`${pinnedCount} pinned session${pinnedCount === 1 ? "" : "s"}`}
                          className="flex shrink-0 items-center gap-0.5 text-on-surface-faint"
                          title="Pinned sessions"
                        >
                          <PinIcon className="size-3 fill-current" />
                          <span>{pinnedCount}</span>
                        </span>
                      ) : null}
                    </Link>
                    <Button asChild variant="ghost" size="icon-xs" className="size-10 md:size-6">
                      <Link
                        href={`/projects?project=${encodeURIComponent(project.projectId)}&view=settings`}
                        aria-label={`Project settings for ${project.name}`}
                      >
                        <SettingsIcon />
                      </Link>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`New session in ${project.name}`}
                      className="size-10 md:size-6"
                      disabled={list.isCreating}
                      // createSession records failures in session-list state;
                      // ChatShell renders that state in the main error banner.
                      onClick={() => void Promise.resolve(list.onCreate(project.projectId)).catch(() => {})}
                    >
                      <PlusIcon />
                    </Button>
                  </div>
                  {visibleSessions.length > 0 ? (
                    <div className="ml-5 border-l border-outline-variant pl-1">
                      {visibleSessions.map(renderSessionRow)}
                    </div>
                  ) : null}
                  {expanded && sessions.length === 0 && !list.isLoading ? (
                    <p className="ml-11 px-2 py-2 text-xs text-on-surface-faint">{list.hasMore ? "Load more or search to find sessions" : "No sessions yet"}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {groups.attention.length > 0 ? (
          <SessionGroupSection title="Needs attention" count={groups.attention.length}>
            {groups.attention.map(renderSessionRow)}
          </SessionGroupSection>
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

        {list.error ? <div role="alert" className="px-4 py-2 text-sm text-danger">
          <p>{list.error}</p>
          <Button variant="ghost" onClick={list.onRetry}>Try again</Button>
        </div> : null}
        {list.hasMore ? <div className="px-3 py-2">
          <Button variant="outline" className="h-10 w-full md:h-9" disabled={list.isLoadingMore} onClick={list.onLoadMore}>
            {list.isLoadingMore ? "Loading..." : "Load more sessions"}
          </Button>
        </div> : null}
        {!hasResults && !list.isLoading && !list.error ? (
          <div className="mx-3 my-4 rounded-md bg-surface-container-lowest p-4 text-sm text-on-surface-variant">
            {query.trim() ? (
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

      <div className="px-3 py-2">
        <Button asChild variant="ghost" className="h-10 w-full justify-start md:h-9">
          <Link href="/projects"><FolderIcon />Projects</Link>
        </Button>
        <Button asChild variant="ghost" className="h-10 w-full justify-start md:h-9">
          <Link href="/sessions/archived"><ArchiveIcon />Archived sessions</Link>
        </Button>
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
        <Button asChild variant="ghost" size="icon-sm" className="size-10 md:size-8" aria-label="Settings">
          <Link href="/settings">
            <SettingsIcon />
          </Link>
        </Button>
      </div>


      <Dialog open={addSessionId !== null} onOpenChange={(open) => { if (!open) setAddSessionId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add session to a project</DialogTitle>
            <DialogDescription>
              {addSession ? `Add "${addSession.sessionName}" to a project.` : "Choose a project for this session."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!addSessionId || !selectedAddProjectId || !onAddToProject) return;
              if (!activeProjects.some((project) => project.projectId === selectedAddProjectId)) {
                setAddError("That project is no longer available. Choose an active project.");
                return;
              }
              setAddError(null);
              setIsAddingSession(true);
              try {
                await onAddToProject(addSessionId, selectedAddProjectId);
                setAddSessionId(null);
              } catch (error) {
                setAddError(error instanceof Error ? error.message : "Could not add the session to the project.");
              } finally {
                setIsAddingSession(false);
              }
            }}
          >
            <label htmlFor="add-session-project" className="block text-sm font-medium text-on-surface">Project</label>
            <select
              id="add-session-project"
              className="h-10 w-full rounded-md border border-input bg-surface-container-lowest px-3 text-sm text-on-surface focus-visible:outline-2 focus-visible:outline-brand"
              value={selectedAddProjectId}
              onChange={(event) => setAddProjectId(event.target.value)}
              disabled={isAddingSession}
            >
              {activeProjects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
            </select>
            <p className="text-sm text-on-surface-variant">The conversation history and attachments will become visible to everyone with access to this project. This cannot be undone in the current release.</p>
            {addError ? <p role="alert" className="text-sm text-danger">{addError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setAddSessionId(null)} disabled={isAddingSession}>Cancel</Button>
              <Button type="submit" disabled={isAddingSession || !addSessionId || !selectedAddProjectId}>
                {isAddingSession ? "Adding..." : "Add to project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function SessionGroupSection(props: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between px-4 pt-3 pb-1 text-xs font-semibold text-on-surface-variant">
        <span>{props.title}</span>
        <span>{props.count}</span>
      </div>
      {props.children}
    </div>
  );
}
