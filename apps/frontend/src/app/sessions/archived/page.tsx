"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, ArchiveRestoreIcon, ArrowLeftIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { SESSION_TRASH_RETENTION_DAYS, type Session } from "@cogniplane/shared-types";

import { AuthGuard } from "@/lib/auth-guard";
import { useAuth } from "@/lib/auth-context";
import { queryKeys } from "@/lib/query-keys";
import { deleteSession, listArchivedSessions, restoreSession } from "@/lib/session-api";
import { ConsolePageHeader } from "@/components/console-page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from "@/components/ui/alert-dialog";

export default function ArchivedSessionsPage() {
  return <AuthGuard><ArchivedSessions /></AuthGuard>;
}

function ArchivedSessions() {
  const { user } = useAuth();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const sessions = useQuery({
    queryKey: queryKeys.sessions.archived(),
    queryFn: listArchivedSessions,
    enabled: Boolean(user),
    refetchOnWindowFocus: true
  });
  const mutation = useMutation({
    mutationFn: async ({ session, action }: { session: Session; action: "restore" | "delete" }) => {
      if (action === "restore") await restoreSession(session.sessionId);
      else await deleteSession(session.sessionId);
    },
    onSuccess: (_result, { session, action }) => {
      client.setQueryData<Session[]>(queryKeys.sessions.archived(), (previous) =>
        previous?.filter((row) => row.sessionId !== session.sessionId));
      void client.invalidateQueries({ queryKey: queryKeys.sessions.all });
      setPendingDelete(null);
      toast.success(action === "restore" ? "Session restored. Find it in Chat." : "Session deleted.");
    }
  });
  const filtered = (sessions.data ?? []).filter((session) =>
    session.sessionName.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <main className="min-h-screen bg-background">
      <ConsolePageHeader
        eyebrow="Workspace"
        title="Archived sessions"
        subtitle="Keep past conversations here. Restore a session to read its messages or continue chatting."
        menuLinks={[{ href: "/", label: "Chat", description: "Return to the active workspace" }]}
      />
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button asChild variant="ghost"><Link href="/"><ArrowLeftIcon />Back to chat</Link></Button>
          <Input className="w-full sm:w-72" aria-label="Search archived sessions" placeholder="Search archived sessions" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        {sessions.isPending ? <p role="status" className="text-sm text-on-surface-variant">Loading archived sessions...</p> : null}
        {sessions.isError ? (
          <div role="alert" className="space-y-2 text-sm text-danger">
            <p>Could not load archived sessions.</p>
            <Button variant="outline" disabled={sessions.isFetching} onClick={() => void sessions.refetch()}>Try again</Button>
          </div>
        ) : null}
        {mutation.isError ? <p role="alert" className="text-sm text-danger">{mutation.error instanceof Error ? mutation.error.message : "Could not update session. Try again."}</p> : null}
        {sessions.isSuccess && filtered.length === 0 ? (
          <div className="rounded-xl border border-outline-variant bg-surface-container-low px-6 py-14 text-center">
            <ArchiveIcon className="mx-auto mb-4 size-8 text-on-surface-faint" />
            <h2 className="font-semibold text-on-surface">{search.trim() ? "No matching sessions" : "No archived sessions"}</h2>
            <p className="mt-2 text-sm text-on-surface-variant">{search.trim() ? "Try a different search." : "Archive a session from the chat sidebar to keep it here."}</p>
          </div>
        ) : null}
        {filtered.length > 0 ? (
          <ul className="divide-y divide-outline-variant overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
            {filtered.map((session) => (
              <li key={session.sessionId} className="flex flex-wrap items-center gap-4 p-4 sm:p-5">
                <div className="min-w-0 flex-1">
                  <h2 className="break-words font-medium text-on-surface">{session.sessionName}</h2>
                  {session.archivedAt ? <p className="mt-1 text-xs text-on-surface-faint">Archived <time dateTime={session.archivedAt}>{new Date(session.archivedAt).toLocaleDateString()}</time></p> : null}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate({ session, action: "restore" })}><ArchiveRestoreIcon />Restore</Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${session.sessionName} to Trash`} disabled={mutation.isPending} onClick={() => { mutation.reset(); setPendingDelete(session); }}><Trash2Icon className="text-danger" /></Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !mutation.isPending) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{(sessions.data?.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS) > 0 ? "Move this session to Trash?" : "Delete this session permanently?"}</AlertDialogTitle>
            <AlertDialogDescription>{(sessions.data?.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS) > 0
              ? `"${pendingDelete?.sessionName ?? "This session"}" and its local files will be recoverable for ${sessions.data?.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS} days.`
              : "This session and its local files will be permanently deleted."}</AlertDialogDescription>
          </AlertDialogHeader>
          {mutation.isError ? <p role="alert" className="text-sm text-danger">{(sessions.data?.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS) > 0 ? "Move to Trash failed. Try again." : "Delete failed. Try again."}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={mutation.isPending} onClick={(event) => {
              event.preventDefault();
              if (pendingDelete) mutation.mutate({ session: pendingDelete, action: "delete" });
            }}>{mutation.isPending ? ((sessions.data?.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS) > 0 ? "Moving..." : "Deleting...") : (sessions.data?.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS) > 0 ? "Move to Trash" : "Delete permanently"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
