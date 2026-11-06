"use client";

import { useId, useRef } from "react";
import { ArchiveIcon, ClipboardIcon, FolderPlusIcon, LinkIcon, MoreHorizontalIcon, PencilIcon, PinIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type SessionActionMenuProps = {
  sessionId: string;
  sessionName: string;
  isPinned: boolean;
  busy: boolean;
  isRunning: boolean;
  hasPendingApprovals: boolean;
  onRename?: () => void;
  onTogglePin: () => void;
  onAddToProject?: () => void;
  /** Copies the session transcript. Set by a header that has no room for its own copy button. */
  onCopyConversation?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  triggerClassName?: string;
};

export function SessionActionMenu(props: SessionActionMenuProps) {
  // Rename must run after Radix restores focus, or the menu steals focus back
  // from the title editor immediately after the action selects it.
  const renameAfterClose = useRef(false);
  const actionAfterClose = useRef<(() => void) | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const archiveReasonId = useId();
  const archiveDisabledReason = props.hasPendingApprovals
    ? "Resolve pending approvals before archiving"
    : props.isRunning ? "Wait for the current turn to finish before archiving"
      : props.busy ? "Wait for the current session change to finish" : null;

  const copyLink = async () => {
    try {
      const url = new URL("/", window.location.origin);
      url.searchParams.set("session", props.sessionId);
      await navigator.clipboard.writeText(url.toString());
      toast.success("Session link copied");
    } catch {
      toast.error("Could not copy session link");
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} type="button" variant="ghost" size="icon-sm" className={props.triggerClassName} aria-label={`Session actions for ${props.sessionName}`}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" onCloseAutoFocus={(event) => {
        if (renameAfterClose.current) {
          event.preventDefault();
          renameAfterClose.current = false;
          props.onRename?.();
        } else if (actionAfterClose.current) {
          // A confirmation must open after the menu releases focus. Its
          // return target is this persistent trigger, not a removed item.
          event.preventDefault();
          triggerRef.current?.focus();
          const action = actionAfterClose.current;
          actionAfterClose.current = null;
          action();
        }
      }}>
        {props.onRename ? <DropdownMenuItem disabled={props.busy} onSelect={() => { renameAfterClose.current = true; }}><PencilIcon />Rename session</DropdownMenuItem> : null}
        <DropdownMenuItem disabled={props.busy} onSelect={props.onTogglePin}><PinIcon className={props.isPinned ? "fill-current" : ""} />{props.isPinned ? "Unpin session" : "Pin session"}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { void copyLink(); }}><LinkIcon />Copy session link</DropdownMenuItem>
        {props.onCopyConversation ? <DropdownMenuItem onSelect={props.onCopyConversation}><ClipboardIcon />Copy session to clipboard</DropdownMenuItem> : null}
        {props.onAddToProject ? <DropdownMenuItem disabled={props.busy} onSelect={() => { actionAfterClose.current = props.onAddToProject ?? null; }}><FolderPlusIcon />Add to project</DropdownMenuItem> : null}
        <DropdownMenuSeparator />
        {props.onArchive ? <>
          <DropdownMenuItem disabled={archiveDisabledReason !== null} aria-describedby={archiveDisabledReason ? archiveReasonId : undefined} onSelect={() => { actionAfterClose.current = props.onArchive ?? null; }}><ArchiveIcon />Archive session</DropdownMenuItem>
          {archiveDisabledReason ? <p id={archiveReasonId} className="px-2 pb-2 text-xs text-muted-foreground">{archiveDisabledReason}</p> : null}
        </> : null}
        {props.onDelete ? <DropdownMenuItem variant="destructive" disabled={props.busy} onSelect={() => { actionAfterClose.current = props.onDelete ?? null; }}><Trash2Icon />Delete session</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
