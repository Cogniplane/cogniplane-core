"use client";

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
import { REMOVAL_EFFECTS, REMOVAL_LIMITS } from "./person-access.logic";

export function RemoveMemberDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  name: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={(open) => { if (!props.pending) props.onOpenChange(open); }}>
      <AlertDialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onCloseAutoFocus={props.onCloseAutoFocus}
        onEscapeKeyDown={(event) => { if (props.pending) event.preventDefault(); }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">Remove {props.name} from the organization?</AlertDialogTitle>
          <AlertDialogDescription>When you remove this person:</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-on-surface">
          {REMOVAL_EFFECTS.map((effect) => <li key={effect}>{effect}</li>)}
        </ul>
        <p className="text-sm font-medium text-on-surface">{REMOVAL_LIMITS}</p>
        {props.error ? <p role="alert" className="text-sm text-danger">{props.error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.pending} className="h-auto min-h-9 py-2">
            {/* Button text does not wrap by default. A long name must wrap, not widen the dialog. */}
            <span className="min-w-0 whitespace-normal wrap-anywhere">Keep {props.name}</span>
          </AlertDialogCancel>
          <Button variant="destructive" onClick={props.onConfirm} disabled={props.pending} aria-busy={props.pending}>
            {props.pending ? "Removing…" : props.error ? "Try again" : "Remove from organization"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
