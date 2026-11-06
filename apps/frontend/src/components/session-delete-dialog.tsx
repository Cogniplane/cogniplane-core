"use client";

import { SESSION_TRASH_RETENTION_DAYS, type Session } from "@cogniplane/shared-types";
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

/**
 * Confirms a session delete. It stays outside the session sidebar, because the
 * phone drawer unmounts the sidebar while it is closed, and the header menu can
 * ask for a delete at that time.
 */
export function SessionDeleteDialog({ sessions, pendingId, busyId, trashRetentionDays = SESSION_TRASH_RETENTION_DAYS, onConfirm, onCancel }: {
  sessions: Session[];
  pendingId: string | null;
  busyId: string | null;
  trashRetentionDays?: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const session = pendingId ? sessions.find((s) => s.sessionId === pendingId) : null;
  const busy = pendingId != null && busyId === pendingId;
  const toTrash = trashRetentionDays > 0;
  return (
    <AlertDialog
      open={pendingId != null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{toTrash ? "Move this session to Trash?" : "Delete this session permanently?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {toTrash
              ? session
                ? `"${session.sessionName}" and its local files will move to Trash for ${trashRetentionDays} days.`
                : `The session will move to Trash for ${trashRetentionDays} days.`
              : "This session and its local files will be permanently deleted."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? (toTrash ? "Moving…" : "Deleting…") : toTrash ? "Move to Trash" : "Delete permanently"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
