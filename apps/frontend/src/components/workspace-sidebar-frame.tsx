"use client";

import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

/** Session shortcuts still work while this drawer is the only open overlay. */
export const SESSION_DRAWER = "[data-session-drawer]";

/** Desktop rail and phone drawer share the same session navigation. */
export function WorkspaceSidebarFrame({ mobile, open, onOpenChange, children }: {
  mobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  if (!mobile) {
    return (
      <div className="hidden min-h-0 overflow-hidden md:block" inert={!open} aria-hidden={!open || undefined}>
        {children}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        scrollBody={false}
        data-session-drawer=""
        className="left-0 top-0 h-dvh max-h-dvh w-[min(86vw,280px)] max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-y-0 border-l-0 p-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-none [&>[data-slot=dialog-close]]:size-10"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLButtonElement>("[data-workspace-sidebar-trigger]")?.focus();
        }}
      >
        <DialogTitle className="sr-only">Sessions</DialogTitle>
        <DialogDescription className="sr-only">Choose a session or start a new one.</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}
