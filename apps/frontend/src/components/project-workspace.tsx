"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SESSION_TRASH_RETENTION_DAYS, type Project } from "@cogniplane/shared-types";
import {
  getProject,
  renameProject,
  setProjectSession,
  createProjectSession,
  archiveProject,
  updateProjectApprovalMode,
  updateProjectAgentFileMode
} from "@/lib/project-api";
import { archiveSession, deleteSession, interruptSession, listSessions, restoreSession } from "@/lib/session-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProjectFiles } from "./project-files";
import { ProjectInstructionsEditor } from "./project-instructions-editor";
import { ProjectSharing } from "./project-sharing";
import { Skeleton } from "@/components/ui/skeleton";
import { PROJECT_SELECT } from "@/lib/project-ui";
const APPROVAL_MODE_HELP: Record<Project["approvalMode"], string> = {
  organization_default: "Uses your organization's approval behavior. Denials and mandatory approvals still apply.",
  manual: "Ask for approval before approval-governed actions. Organization denials still apply.",
  automatic: "Uses the organization's approval policy and cannot bypass it. In the current runtime, this has the same effective behavior as Organization default. Required approvals and denials still apply."
};
const AGENT_FILE_MODE_HELP = {
  "read-only": "The agent can read published files but cannot save project drafts.",
  "create-only": "The agent can create drafts, but cannot propose updates to existing files.",
  "read-write": "The agent can create drafts and propose updates. A person must still promote every draft."
} as const;
export function ProjectWorkspace({ project }: { project: Project }) {
  const client = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState(project.name);
  const [renaming, setRenaming] = useState(false);
  const [sessionToAdd, setSessionToAdd] = useState("");
  const [confirmingSession, setConfirmingSession] = useState(false);
  const [sessionView, setSessionView] = useState<"active" | "archived">("active");
  const detail = useQuery({
    queryKey: ["projects", project.projectId],
    queryFn: () => getProject(project.projectId),
    refetchInterval: (query) =>
      query.state.data?.files.some(
        (file) =>
          ["pending", "processing"].includes(file.status) ||
          ["pending", "scanning"].includes(file.detail?.pii?.status ?? "")
      )
        ? 10000
        : false
  });
  const canManageProject = detail.data?.canManage === true;
  const canEditProject = detail.data?.canEdit === true || canManageProject;
  const allSessions = useQuery({
    queryKey: queryKeys.sessions.list(),
    queryFn: listSessions
  });
  const currentProject = detail.data?.project ?? project;
  const sessions = detail.data?.sessions ?? [];
  const activeSessions = sessions.filter((session) => session.status === "active");
  const archivedSessions = sessions.filter((session) => session.status === "archived");
  const visibleSessions = sessionView === "active" ? activeSessions : archivedSessions;
  const availableSessions = (allSessions.data ?? []).filter(
    (session) => !session.projectId && session.status === "active" &&
      (!session.purpose || session.purpose === "normal")
  );
  const selectedSession = availableSessions.find((session) => session.sessionId === sessionToAdd);
  const mutate = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["projects"] }),
        client.invalidateQueries({ queryKey: queryKeys.sessions.all })
      ]);
    }
  });
  return (
    <section aria-label={project.name} className="min-w-0 space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-outline-variant pb-5">
        {renaming ? (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              mutate.mutate(async () => {
                await renameProject(project.projectId, name.trim());
                setRenaming(false);
              });
            }}
          >
            <Input
              aria-label="Rename project"
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Button size="sm" disabled={!name.trim() || mutate.isPending}>
              Save name
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div>
            <h2 className="break-words text-xl font-semibold">{project.name}</h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              {currentProject.archivedAt
                ? "Archived project. Restore it to return its sessions to the main screen."
                : "Private project"}
            </p>
          </div>
        )}
        {!renaming && canManageProject ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setName(project.name);
              setRenaming(true);
            }}
          >
            Rename
          </Button>
        ) : null}
        {canManageProject ? (
          <Button
            size="sm"
            variant="outline"
            disabled={mutate.isPending}
            onClick={() =>
              mutate.mutate(async () => {
                await archiveProject(project.projectId, !currentProject.archivedAt);
                toast.success(currentProject.archivedAt
                  ? "Project restored to Active."
                  : "Project moved to Archived. Restore it to return its sessions to the main screen.");
              })
            }
          >
            {currentProject.archivedAt ? "Restore project" : "Archive project"}
          </Button>
        ) : null}
      </header>
      {detail.isPending ? (
        <div aria-label="Loading project" className="space-y-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-32" />
        </div>
      ) : null}
      {detail.isError ? (
        <div role="alert" className="text-sm text-danger">
          <p>Could not load this project.</p>
          <Button variant="outline" onClick={() => void detail.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      {mutate.isError ? (
        <p role="alert" className="text-sm text-danger">
          {mutate.error?.message}
        </p>
      ) : null}
      {detail.data ? (
        <>
          <ProjectInstructionsEditor key={project.projectId} project={currentProject} canManage={canManageProject} />
          <ProjectSharing project={currentProject} canManage={canManageProject} />
          <section aria-labelledby="project-approval-title" className="rounded-lg border border-outline-variant bg-surface-container-low p-5">
            <h3 id="project-approval-title" className="font-semibold">Agent approvals</h3>
            <p id="project-approval-help" className="mt-1 text-sm text-on-surface-variant">
              Choose how this project's agent actions are approved. Only project owners can change this setting.
            </p>
            <label htmlFor="project-approval-mode" className="mt-4 block text-sm font-medium">
              Approval mode
            </label>
            <select
              id="project-approval-mode"
              aria-describedby="project-approval-help project-approval-mode-help"
              className={`${PROJECT_SELECT} mt-1 max-w-md`}
              value={currentProject.approvalMode}
              disabled={Boolean(currentProject.archivedAt) || mutate.isPending}
              onChange={(event) => {
                const approvalMode = event.target.value as Project["approvalMode"];
                mutate.mutate(async () => {
                  try {
                    await updateProjectApprovalMode(project.projectId, approvalMode);
                    toast.success("Approval mode updated for new turns.");
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "Could not update approval mode.");
                    throw error;
                  }
                });
              }}
            >
              <option value="organization_default">Organization default</option>
              <option value="manual">Manual approval</option>
              <option value="automatic">Automatic approval</option>
            </select>
            <p id="project-approval-mode-help" className="mt-2 max-w-2xl text-sm text-on-surface-variant">
              {APPROVAL_MODE_HELP[currentProject.approvalMode]} Changes apply to new turns.
            </p>
          </section>
          <section aria-labelledby="project-agent-files-title" className="rounded-lg border border-outline-variant bg-surface-container-low p-5">
            <h3 id="project-agent-files-title" className="font-semibold">Agent project files</h3>
            <p id="project-agent-files-help" className="mt-1 text-sm text-on-surface-variant">
              Choose whether the agent can propose shared project files. Drafts always need human promotion.
            </p>
            <label htmlFor="project-agent-file-mode" className="mt-4 block text-sm font-medium">File mode</label>
            <select
              id="project-agent-file-mode"
              aria-describedby="project-agent-files-help project-agent-file-mode-help"
              className={`${PROJECT_SELECT} mt-1 max-w-md`}
              value={currentProject.agentFileMode}
              disabled={Boolean(currentProject.archivedAt) || mutate.isPending}
              onChange={(event) => {
                const agentFileMode = event.target.value as Project["agentFileMode"];
                mutate.mutate(async () => {
                  await updateProjectAgentFileMode(project.projectId, agentFileMode);
                  toast.success("Agent file mode updated for new turns.");
                });
              }}
            >
              <option value="read-only">Read-only</option>
              <option value="create-only">Create-only</option>
              <option value="read-write">Read-write</option>
            </select>
            <p id="project-agent-file-mode-help" className="mt-2 max-w-2xl text-sm text-on-surface-variant">
              {AGENT_FILE_MODE_HELP[currentProject.agentFileMode]} New turns use this mode.
            </p>
          </section>
          <section aria-labelledby="project-sessions-title">
            <div className="flex items-center justify-between gap-3">
              <h3 id="project-sessions-title" className="font-semibold">
                Sessions
              </h3>
              <Button
                size="sm"
                disabled={mutate.isPending || !canEditProject}
                onClick={() =>
                  mutate.mutate(async () => {
                    const session = await createProjectSession(project.projectId);
                    router.push(`/?session=${encodeURIComponent(session.sessionId)}`);
                  })
                }
              >
                New session
              </Button>
            </div>
            <div className="mt-3 flex gap-1" role="tablist" aria-label="Project sessions">
              <Button
                size="xs"
                variant={sessionView === "active" ? "secondary" : "ghost"}
                role="tab"
                aria-selected={sessionView === "active"}
                onClick={() => setSessionView("active")}
              >
                Active ({activeSessions.length})
              </Button>
              <Button
                size="xs"
                variant={sessionView === "archived" ? "secondary" : "ghost"}
                role="tab"
                aria-selected={sessionView === "archived"}
                onClick={() => setSessionView("archived")}
              >
                Archived ({archivedSessions.length})
              </Button>
            </div>
            <form
              className="mt-4 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (selectedSession) {
                  mutate.reset();
                  setConfirmingSession(true);
                }
              }}
            >
              <select
                className={PROJECT_SELECT}
                aria-label="Existing session"
                value={selectedSession?.sessionId ?? ""}
                disabled={confirmingSession || mutate.isPending || !canEditProject || Boolean(currentProject.archivedAt)}
                onChange={(event) => setSessionToAdd(event.target.value)}
              >
                <option value="">Add an existing session...</option>
                {availableSessions.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>
                    {session.sessionName}
                  </option>
                ))}
              </select>
              <Button variant="outline" disabled={!selectedSession || confirmingSession || mutate.isPending || !canEditProject || Boolean(currentProject.archivedAt)}>
                Add
              </Button>
            </form>
            {confirmingSession ? (
              <div role="group" aria-label="Confirm session assignment" className="mt-3 flex flex-col gap-3">
                <p className="text-sm text-on-surface">
                  Add {selectedSession?.sessionName ?? "this session"} to {currentProject.name}?
                  Its conversation history and attachments will be visible to everyone who has
                  access to this project, including anyone it is shared with later. The session
                  cannot be moved to another project or removed from this project.
                </p>
                {!selectedSession ? (
                  <p role="alert" className="text-sm text-danger">
                    This session is no longer available. Cancel and choose another session.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={!selectedSession || mutate.isPending || !canEditProject || Boolean(currentProject.archivedAt)}
                    onClick={() => {
                      if (!selectedSession) return;
                      mutate.mutate(async () => {
                        await setProjectSession(project.projectId, selectedSession.sessionId);
                        setSessionToAdd("");
                        setConfirmingSession(false);
                        toast.success("Session added to the project.");
                      });
                    }}
                  >
                    {mutate.isPending ? "Adding session..." : "Confirm addition"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={mutate.isPending}
                    onClick={() => { setConfirmingSession(false); mutate.reset(); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {allSessions.isError ? (
              <p role="alert" className="mt-2 text-sm text-danger">
                Could not load existing sessions.{" "}
                <button className="underline" onClick={() => void allSessions.refetch()}>
                  Try again
                </button>
              </p>
            ) : null}
            {visibleSessions.length ? (
              <ul className="mt-3 divide-y divide-outline-variant">
                {visibleSessions.map((session) => (
                  <li
                    key={session.sessionId}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0 break-words text-sm">
                      <Link
                        href={`/?session=${encodeURIComponent(session.sessionId)}`}
                        className="font-medium text-brand-strong hover:underline"
                      >
                        {session.sessionName}
                      </Link>
                      {session.status === "archived" ? <span className="block text-xs font-normal text-on-surface-variant">Archived</span> : null}
                    </div>
                    {canEditProject ? (
                      <div className="flex shrink-0 gap-1">
                        {session.isRunning || session.hasPendingApprovals ? (
                          <Button size="xs" variant="outline" onClick={() => mutate.mutate(async () => {
                            await interruptSession(session.sessionId);
                            toast.success("Turn cancellation requested.");
                          })}>
                            Stop turn
                          </Button>
                        ) : null}
                        {session.status === "archived" ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={mutate.isPending || Boolean(currentProject.archivedAt)}
                            onClick={() => mutate.mutate(async () => {
                              await restoreSession(session.sessionId);
                              toast.success("Session restored.");
                            })}
                          >
                            Restore
                          </Button>
                        ) : (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={mutate.isPending || Boolean(session.isRunning) || Boolean(session.hasPendingApprovals) || Boolean(currentProject.archivedAt)}
                            onClick={() => mutate.mutate(async () => {
                              await archiveSession(session.sessionId);
                              toast.success("Session archived.");
                            })}
                          >
                            Archive
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={mutate.isPending || Boolean(session.isRunning) || Boolean(session.hasPendingApprovals) || Boolean(currentProject.archivedAt)}
                          onClick={() => mutate.mutate(async () => {
                            await deleteSession(session.sessionId);
                            toast.success("Session moved to Trash.");
                          })}
                        >
                          {(detail.data.trash?.retentionDays ?? SESSION_TRASH_RETENTION_DAYS) > 0 ? "Move to Trash" : "Delete permanently"}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-on-surface-variant">
                {sessionView === "active" ? "Start a session here or add an existing conversation." : "No archived sessions in this project."}
              </p>
            )}
            {detail.data.trash && detail.data.trash.retentionDays !== 0 && detail.data.trash.sessions.length ? (
              <section aria-labelledby="project-session-trash-title" className="mt-6 rounded-lg border border-outline-variant bg-surface-container-low p-4">
                <h4 id="project-session-trash-title" className="font-medium">Session Trash</h4>
                <p className="mt-1 text-sm text-on-surface-variant">Deleted sessions can be restored for {detail.data.trash.retentionDays ?? SESSION_TRASH_RETENTION_DAYS} days. Restoring a session keeps its conversation and local files.</p>
                <ul className="mt-3 divide-y divide-outline-variant">
                  {detail.data.trash.sessions.map((deletedSession) => (
                    <li key={deletedSession.sessionId} className="flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0 text-sm">
                        <span className="block truncate font-medium">{deletedSession.sessionName}</span>
                        {deletedSession.deletedAt ? <span className="text-xs text-on-surface-variant">Removed {new Date(deletedSession.deletedAt).toLocaleDateString()}</span> : null}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={Boolean(currentProject.archivedAt) || mutate.isPending}
                        onClick={() => mutate.mutate(async () => {
                          await restoreSession(deletedSession.sessionId);
                          toast.success("Session restored.");
                        })}
                      >
                        Restore session
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </section>
          {detail.data.activity?.length ? (
            <details className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
              <summary className="cursor-pointer font-medium">Recent activity</summary>
              <ul className="mt-3 divide-y divide-outline-variant text-sm">
                {detail.data.activity.map((event) => (
                  <li key={event.eventId} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>{event.type.replaceAll("_", " ").replaceAll(".", " ")}</span>
                    <time dateTime={event.createdAt} className="text-on-surface-variant">
                      {new Date(event.createdAt).toLocaleString()}
                    </time>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <ProjectFiles project={currentProject} sources={detail.data.files} canEdit={detail.data.canEdit ?? canManageProject} />
        </>
      ) : null}
    </section>
  );
}
