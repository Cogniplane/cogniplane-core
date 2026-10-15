"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  MEMORY_CONTENT_MAX_LENGTH,
  showNonPrintingCharacters,
  type MemoriesResponse,
  type Memory,
  type MemoryProvenance,
  type MemoryScope
} from "@cogniplane/shared-types";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { memoriesKey, MemoriesScopeError, useMemories } from "@/hooks/use-memories";
import { ApiError } from "@/lib/api-client";
import { deleteMemory, updateMemory } from "@/lib/memories-api";
import { formatMediumDateTime } from "@/lib/time-format";
import { PILL_AMBER, PILL_GRAY, PILL_GREEN } from "@/lib/ui-tokens";

const PROVENANCE: Record<MemoryProvenance, { label: string; pill: string; detail: (memory: Memory) => string }> = {
  agent_approved: {
    label: "Approved by you",
    pill: PILL_GREEN,
    detail: (memory) => `The agent proposed this text and you approved it on ${formatMediumDateTime(memory.approvedAt, "an earlier date")}.`
  },
  user_authored: {
    label: "Written by you",
    pill: PILL_GRAY,
    detail: (memory) => `You wrote or edited this text on ${formatMediumDateTime(memory.approvedAt, "an earlier date")}.`
  },
  unverified: {
    label: "Not verified",
    pill: PILL_AMBER,
    detail: () => "Saved before approvals were recorded, so nothing shows that you saw this text. Check it, then edit or delete it."
  }
};

const isScopeProblem = (error: unknown) =>
  error instanceof MemoriesScopeError ||
  (error instanceof ApiError && (error.status === 401 || error.code === "memory_scope_changed"));

const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/**
 * What the editor holds. `baseVersion` and `baseContent` are the memory as it was
 * when the user started to edit it. A save sends that version, not whatever the
 * list holds by then, so a refresh of the list cannot make a save overwrite text
 * that the user never saw. `conflict` is set when the server refused the save
 * because the memory changed after that version.
 */
type EditState = { id: string; draft: string; baseVersion: number; baseContent: string; conflict: boolean };

/**
 * The signed-in user's saved memories. The agent only proposes a memory, and
 * the user approves its exact text in the chat. Here they read, edit and delete
 * what is saved. Every write sends the account and the version that the editor
 * started from, so a stale tab cannot change another account's memory or newer
 * text. When a save is refused because the text changed, the editor stays open
 * with what the user typed, beside the latest saved text.
 */
export function MemoriesSection({ scope }: { scope: MemoryScope }) {
  const queryClient = useQueryClient();
  const list = useMemories(scope);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed delete is shown inside the dialog, because the dialog covers the page.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const key = memoriesKey(scope);

  const lock = () => {
    queryClient.removeQueries({ queryKey: key, exact: true });
    setEditing(null);
    setDeleting(null);
    setLocked(true);
  };

  const update = useMutation({
    mutationFn: ({ memory, content, version }: { memory: Memory; content: string; version: number }) =>
      updateMemory(memory.id, { scope, content, version }),
    onSuccess: (result) => {
      if (result.scope.tenantId !== scope.tenantId || result.scope.userId !== scope.userId) { lock(); return; }
      queryClient.setQueryData<MemoriesResponse>(key, (current) => current
        ? { ...current, memories: current.memories.map((item) => item.id === result.memory.id ? result.memory : item) }
        : current);
      setEditing(null);
      setError(null);
      toast.success(`Memory "${result.memory.name}" was updated.`);
    },
    onError: (cause, variables) => {
      if (isScopeProblem(cause)) { lock(); return; }
      if (cause instanceof ApiError && cause.code === "memory_conflict") {
        // Someone, usually the agent in another chat, changed it after the editor opened.
        // The editor stays open with the text that the user typed. The list is read again,
        // so the card can show the latest saved text beside it.
        setEditing((current) => current?.id === variables.memory.id ? { ...current, conflict: true } : current);
        setError(null);
        void queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      if (cause instanceof ApiError && cause.status === 404) {
        setEditing(null);
        setError("This memory no longer exists.");
        void queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      setError(messageOf(cause, "The memory could not be saved. Try again."));
    }
  });

  const remove = useMutation({
    mutationFn: (memory: Memory) => deleteMemory(memory.id, scope),
    onSuccess: (_void, memory) => {
      queryClient.setQueryData<MemoriesResponse>(key, (current) => current
        ? { ...current, total: Math.max(0, current.total - 1), memories: current.memories.filter((item) => item.id !== memory.id) }
        : current);
      setDeleting(null);
      setDeleteError(null);
      setError(null);
      toast.success(`Memory "${memory.name}" was deleted.`);
    },
    onError: (cause) => {
      if (isScopeProblem(cause)) { lock(); return; }
      if (cause instanceof ApiError && cause.status === 404) {
        setDeleting(null);
        void queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      setDeleteError(messageOf(cause, "The memory could not be deleted. Try again."));
    }
  });

  const busy = update.isPending || remove.isPending;
  const loadFailure = list.isError ? list.error : null;
  const mustLock = locked || isScopeProblem(loadFailure);
  const memories = list.data?.memories ?? [];

  return (
    <section className="space-y-4 pt-5" aria-labelledby="memories-title">
      <div>
        <h2 id="memories-title" className="text-lg font-semibold">What the agent remembers about you</h2>
        <p className="mt-1 text-sm text-on-surface-variant">
          The agent reads your most recent memories at the start of every turn. It can only propose a new one:
          nothing is saved until you approve the exact text in the chat. Edit or delete anything here.
        </p>
      </div>

      {error ? <p role="alert" className="rounded-md bg-danger-surface p-3 text-sm text-danger">{error}</p> : null}

      {mustLock ? (
        <p role="alert" className="rounded-lg border border-outline-variant p-5 text-sm">
          Your account or organization changed. Reload this page before you view or change memories.
        </p>
      ) : list.isError && !list.data ? (
        <div role="alert" className="rounded-lg border border-outline-variant p-5 text-sm">
          <p>Could not load your memories.</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => void list.refetch()}>Retry</Button>
        </div>
      ) : list.isPending ? (
        <div aria-label="Loading memories" className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
      ) : memories.length === 0 ? (
        <p className="rounded-lg border border-dashed border-outline-variant p-6 text-sm text-on-surface-variant">
          No saved memories yet. When the agent proposes one, you approve its exact text in the chat, and it appears here.
        </p>
      ) : (
        <>
          <ul className="space-y-3">
            {memories.map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                edit={editing?.id === memory.id ? editing : null}
                busy={busy}
                saving={update.isPending && editing?.id === memory.id}
                loadingLatest={list.isFetching}
                onEdit={() => {
                  setError(null);
                  setEditing({ id: memory.id, draft: memory.content, baseVersion: memory.version, baseContent: memory.content, conflict: false });
                }}
                onDraft={(draft) => setEditing((current) => current?.id === memory.id ? { ...current, draft } : current)}
                onCancel={() => { setEditing(null); setError(null); }}
                onSave={() => {
                  if (editing?.id === memory.id) update.mutate({ memory, content: editing.draft, version: editing.baseVersion });
                }}
                // The user has read the latest text in the conflict panel. Their text now builds on that version.
                onReapply={() => setEditing((current) => current?.id === memory.id
                  ? { ...current, baseVersion: memory.version, baseContent: memory.content, conflict: false }
                  : current)}
                onReload={() => void list.refetch()}
                onDelete={() => { setError(null); setDeleteError(null); setDeleting(memory); }}
              />
            ))}
          </ul>
          {list.data && list.data.total > memories.length ? (
            <p className="text-xs text-on-surface-variant">
              Showing your {memories.length} most recently updated memories of {list.data.total}.
            </p>
          ) : null}
        </>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(next) => { if (!next && !remove.isPending) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="wrap-anywhere">Delete memory &ldquo;{deleting?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent will no longer see it in your chats. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? <p role="alert" className="text-sm text-danger">{deleteError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              aria-busy={remove.isPending}
              onClick={() => { if (deleting) remove.mutate(deleting); }}
            >
              {remove.isPending ? "Deleting…" : "Delete memory"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function MemoryCard({ memory, edit, busy, saving, loadingLatest, onEdit, onDraft, onCancel, onSave, onReapply, onReload, onDelete }: {
  /** The memory as the list holds it now, which is the latest saved text. */
  memory: Memory;
  /** The editor, or null when the memory is not being edited. */
  edit: EditState | null;
  busy: boolean;
  saving: boolean;
  /** The list is being read again. */
  loadingLatest: boolean;
  onEdit: () => void;
  onDraft: (draft: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onReapply: () => void;
  onReload: () => void;
  onDelete: () => void;
}) {
  const provenance = PROVENANCE[memory.provenance];
  const shown = showNonPrintingCharacters(memory.content);
  const hasHidden = shown !== memory.content;
  const extra = Object.keys(memory.metadata).length > 0 ? JSON.stringify(memory.metadata) : null;
  // Judged against the text that the editor started from, not against a later refresh of the list.
  const unchanged = edit !== null && edit.draft === edit.baseContent;
  const empty = edit !== null && edit.draft.trim().length === 0;
  const conflict = edit?.conflict === true;
  // The list holds a newer version than the one that the editor started from.
  const latestLoaded = edit !== null && memory.version !== edit.baseVersion;

  return (
    <li className="rounded-lg border border-outline-variant bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <code className="text-sm font-medium text-on-surface [overflow-wrap:anywhere]">{memory.name}</code>
          <span className={provenance.pill}>{provenance.label}</span>
        </span>
        <span className="text-xs text-on-surface-variant">Updated {formatMediumDateTime(memory.updatedAt, "recently")}</span>
      </div>
      <p className="mt-1 text-xs text-on-surface-variant">{provenance.detail(memory)}</p>

      {edit !== null ? (
        <div className="mt-3 space-y-2">
          {conflict ? (
            <div className="space-y-2 rounded-md border border-warning/40 bg-warning-surface p-3 text-sm">
              <p role="alert" className="font-medium text-on-surface">
                This memory changed after you opened it, so your edit was not saved. Your text is still in the editor.
              </p>
              {latestLoaded ? (
                <div>
                  <p className="text-xs text-on-surface-variant">
                    Latest saved text, {provenance.label.toLowerCase()}, updated {formatMediumDateTime(memory.updatedAt, "recently")}:
                  </p>
                  <p aria-label="Latest saved text" className="mt-1 whitespace-pre-wrap text-on-surface [overflow-wrap:anywhere]">{shown}</p>
                </div>
              ) : loadingLatest ? (
                <p className="text-xs text-on-surface-variant">Loading the latest saved text…</p>
              ) : (
                <p className="text-xs text-on-surface-variant">
                  The latest saved text could not be loaded.{" "}
                  <Button type="button" size="xs" variant="outline" onClick={onReload}>Reload it</Button>
                </p>
              )}
            </div>
          ) : null}
          <Textarea
            aria-label={`Text of memory ${memory.name}`}
            value={edit.draft}
            maxLength={MEMORY_CONTENT_MAX_LENGTH}
            disabled={saving}
            onChange={(event) => onDraft(event.target.value)}
            className="min-h-24"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-on-surface-variant">{edit.draft.length} / {MEMORY_CONTENT_MAX_LENGTH}</span>
            {conflict ? (
              <span className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={onCancel}>Discard my edit</Button>
                <Button type="button" size="sm" disabled={!latestLoaded || loadingLatest} onClick={onReapply}>
                  Reapply my text to the latest version
                </Button>
              </span>
            ) : (
              <span className="flex gap-2">
                <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button>
                <Button type="button" size="sm" disabled={saving || unchanged || empty} aria-busy={saving} onClick={onSave}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </span>
            )}
          </div>
        </div>
      ) : (
        <>
          <p className="mt-3 whitespace-pre-wrap text-sm text-on-surface [overflow-wrap:anywhere]">{shown}</p>
          {hasHidden ? (
            <p className="mt-1 text-xs text-warning">
              This text contains characters that do not display. They are shown as ⟦U+XXXX⟧. Edit the text to replace them.
            </p>
          ) : null}
          {extra ? (
            <p className="mt-2 text-xs text-on-surface-variant [overflow-wrap:anywhere]">
              Extra data from the agent: <code>{extra}</code>
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy} aria-label={`Edit memory ${memory.name}`} onClick={onEdit}>
              Edit
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} aria-label={`Delete memory ${memory.name}`} onClick={onDelete}>
              Delete
            </Button>
          </div>
        </>
      )}
    </li>
  );
}
