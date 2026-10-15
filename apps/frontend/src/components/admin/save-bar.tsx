"use client";

import type { ReactNode, Ref } from "react";

import { Button } from "@/components/ui/button";

/**
 * The save bar for an admin settings draft. It sticks to the bottom of the screen only while
 * there are changes, and its buttons show only then. The status region is always mounted, so
 * callers focus it after Save or Cancel, when the focused button goes away.
 */
export function SaveBar({ dirty, busy, status, error, cancelLabel = "Cancel", submitLabel, busyLabel, onCancel, onSubmit, statusRef, submitRef }: {
  dirty: boolean;
  busy: boolean;
  /** What the status region says: unsaved changes, or the result of the last save. */
  status: ReactNode;
  /**
   * The error of this form's last save attempt. The bar cannot tell a stale error from a new one,
   * so the caller clears it when the draft changes or is cancelled. Shown only while dirty.
   */
  error?: string | null;
  cancelLabel?: string;
  submitLabel: string;
  busyLabel?: string;
  onCancel: () => void;
  /** Without it, the submit button submits the form around the bar. */
  onSubmit?: () => void;
  statusRef: Ref<HTMLDivElement>;
  submitRef?: Ref<HTMLButtonElement>;
}) {
  return (
    // With nothing to say, only the empty status region stays, so a clean form shows no strip.
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${dirty || status ? "border-t border-outline-variant py-3" : ""} ${dirty ? "sticky bottom-0 z-10 bg-background" : ""}`}>
      <div
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className="mr-auto flex min-w-0 flex-wrap items-center gap-2 rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {status}
      </div>
      {dirty && error && !busy ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      {dirty ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button ref={submitRef} type={onSubmit ? "button" : "submit"} disabled={busy} onClick={onSubmit}>
            {busy && busyLabel ? busyLabel : submitLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
