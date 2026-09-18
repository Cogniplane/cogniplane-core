"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertCircleIcon, ArchiveIcon, ChevronDownIcon, ChevronRightIcon, FolderIcon, PinIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";

import { useAuth } from "../lib/auth-context";
import { API_URL } from "../lib/api-client";
import { SESSION_TRASH_RETENTION_DAYS, type Project, type Session } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  isCreating?: boolean;
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
  trashRetentionDays?: number;
  onRequest: (sessionId: string) => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
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
  const [query, setQuery] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("personal");
  const [createError, setCreateError] = useState<string | null>(null);
  const [addSessionId, setAddSessionId] = useState<string | null>(null);
  const [addProjectId, setAddProjectId] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [isAddingSession, setIsAddingSession] = useState(false);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const [backendVersion, setBackendVersion] = useState<{ sha: string; buildDate: string } | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const activeProjects = useMemo(
    () => projects.filter((project) => !project.archivedAt),
    [projects]
  );

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
    () => groupSessions(
      list.sessions.filter((session) => !session.projectId),
      pinning.ids,
      query,
      undefined,
      list.attentionIds
    ),
    [list.sessions, pinning.ids, query, list.attentionIds]
  );

  const projectGroups = useMemo(
    () => activeProjects
      .map((project) => {
        const projectNameMatches = normalizedQuery !== "" && project.name.toLowerCase().includes(normalizedQuery);
        const sessions = list.sessions.filter((session) => session.projectId === project.projectId &&
          (!normalizedQuery || projectNameMatches || session.sessionName.toLowerCase().includes(normalizedQuery)));
        return { project, sessions, projectNameMatches };
      })
      .filter(({ projectNameMatches, sessions }) => !normalizedQuery || projectNameMatches || sessions.length > 0),
    [list.sessions, activeProjects, normalizedQuery]
  );
  const hasResults = totalGroupedCount(groups) > 0 || projectGroups.length > 0;
  const addSession = addSessionId ? list.sessions.find((session) => session.sessionId === addSessionId) : null;
  const selectedCreateProjectId = createProjectId === "personal" || activeProjects.some((project) => project.projectId === createProjectId)
    ? createProjectId
    : "personal";
  const selectedAddProjectId = activeProjects.some((project) => project.projectId === addProjectId)
    ? addProjectId
    : activeProjects[0]?.projectId ?? "";
  const pendingDeleteSession = deletion.pendingId
    ? list.sessions.find((s) => s.sessionId === deletion.pendingId)
    : null;
  const trashRetentionDays = deletion.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS;

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
          sessionId={session.sessionId}
          sessionName={session.sessionName}
          isPinned={isPinned}
          busy={busy}
          isRunning={isStreaming || Boolean(session.isRunning)}
          hasPendingApprovals={needsAttention || Boolean(session.hasPendingApprovals)}
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
        <Button type="button" className="w-full" onClick={() => { setCreateError(null); setCreateProjectId("personal"); setCreateDialogOpen(true); }}>
          New session
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
        {projectGroups.length > 0 ? (
          <div className="pt-2">
            <div className="flex items-center justify-between px-4 pb-1 text-[0.62rem] font-bold uppercase tracking-[0.12em] text-on-surface-faint">
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
                    <span className="flex size-7 shrink-0 items-center justify-center text-on-surface-faint">
                      {expanded ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
                    </span>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
                      onClick={toggleExpanded}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1 text-left text-sm font-medium text-on-surface hover:text-brand-strong focus-visible:ring-2 focus-visible:ring-brand/60"
                    >
                      <FolderIcon className="size-4 shrink-0 text-brand-strong" />
                      <span className="truncate">{project.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-on-surface-faint">{sessions.length}</span>
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
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`New session in ${project.name}`}
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
                  {expanded && sessions.length === 0 ? (
                    <p className="ml-11 px-2 py-2 text-xs text-on-surface-faint">No sessions yet</p>
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

      <div className="px-3 py-2">
        <Button asChild variant="ghost" className="w-full justify-start">
          <Link href="/projects"><FolderIcon />Projects</Link>
        </Button>
        <Button asChild variant="ghost" className="w-full justify-start">
          <Link href="/sessions/archived"><ArchiveIcon />Archived sessions</Link>
        </Button>
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
            <AlertDialogTitle>{trashRetentionDays > 0 ? "Move this session to Trash?" : "Delete this session permanently?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {trashRetentionDays > 0
                ? pendingDeleteSession
                  ? `"${pendingDeleteSession.sessionName}" and its local files will move to Trash for ${trashRetentionDays} days.`
                  : `The session will move to Trash for ${trashRetentionDays} days.`
                : "This session and its local files will be permanently deleted."}
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
              {deletion.busyId === deletion.pendingId ? (trashRetentionDays > 0 ? "Moving…" : "Deleting…") : trashRetentionDays > 0 ? "Move to Trash" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New session</DialogTitle>
            <DialogDescription>Choose where this conversation should live. Personal sessions stay private.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                setCreateError(null);
                await list.onCreate(selectedCreateProjectId === "personal" ? null : selectedCreateProjectId);
                setCreateDialogOpen(false);
              } catch (error) {
                setCreateError(error instanceof Error ? error.message : "Could not create the session.");
              }
            }}
          >
            <label htmlFor="new-session-project" className="block text-sm font-medium text-on-surface">Project</label>
            <select
              id="new-session-project"
              className="h-10 w-full rounded-md border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface focus-visible:outline-2 focus-visible:outline-brand"
              value={selectedCreateProjectId}
              onChange={(event) => setCreateProjectId(event.target.value)}
              disabled={list.isCreating}
            >
              <option value="personal">Personal session</option>
              {activeProjects.map((project) => (
                <option key={project.projectId} value={project.projectId}>{project.name}</option>
              ))}
            </select>
            {selectedCreateProjectId !== "personal" ? (
              <p className="text-xs text-on-surface-variant">This session will follow the project&apos;s access and sharing settings.</p>
            ) : null}
            {createError ? <p role="alert" className="text-sm text-danger">{createError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreateDialogOpen(false)} disabled={list.isCreating}>Cancel</Button>
              <Button type="submit" disabled={list.isCreating || (selectedCreateProjectId !== "personal" && !activeProjects.some((project) => project.projectId === selectedCreateProjectId))}>
                {list.isCreating ? "Creating..." : "Create session"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
              className="h-10 w-full rounded-md border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface focus-visible:outline-2 focus-visible:outline-brand"
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
      <div className="flex items-center justify-between px-4 pt-3 pb-1 text-[0.62rem] font-bold uppercase tracking-[0.12em] text-on-surface-faint">
        <span>{props.title}</span>
        <span>{props.count}</span>
      </div>
      {props.children}
    </div>
  );
}
