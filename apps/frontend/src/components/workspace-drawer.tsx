import type { Ref } from "react";
import { XIcon } from "lucide-react";

import { Button } from "./ui/button";

export const WORKSPACE_DRAWER_BACKDROP = "fixed inset-0 z-[var(--z-modal-backdrop)] bg-black/50 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200";
export const WORKSPACE_DRAWER_SURFACE = "bg-popover text-popover-foreground shadow-lg";

export function WorkspaceDrawerHeader({ title, titleId, closeLabel, closeRef, onClose, modal = true }: {
  title: string;
  titleId: string;
  closeLabel: string;
  closeRef: Ref<HTMLButtonElement>;
  onClose: () => void;
  modal?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant py-2 pl-4 pr-2">
      <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold text-on-surface">{title}</h2>
      <Button ref={closeRef} type="button" variant="ghost" size={modal ? "icon-lg" : "icon-sm"}
        aria-label={closeLabel} title={closeLabel} onClick={onClose}>
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  );
}
