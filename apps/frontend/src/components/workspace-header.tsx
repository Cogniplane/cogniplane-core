"use client";

import Link from "next/link";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, ClipboardIcon, PanelLeftIcon, PanelRightIcon } from "lucide-react";

import { useAuth } from "../lib/auth-context";
import { useOrganizations } from "../hooks/use-organizations";
import { SessionActionMenu, type SessionActionMenuProps } from "./session-action-menu";
import { SessionStatusIndicator } from "./session-status";
import { ProjectInstructionsIndicator } from "./project-instructions-indicator";
import { SessionCapabilitiesButton } from "./session-capabilities";
import type { CompletedTurn, SessionStatus } from "./session-status.logic";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

type MenuLink = {
  href: string;
  label: string;
  description: string;
};

function avatarInitials(name: string | undefined, email: string | undefined): string {
  const source = (name ?? email ?? "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function WorkspaceHeader(props: {
  title: string;
  projectId?: string | null;
  sessionActions?: SessionActionMenuProps;
  subtitle?: string;
  sessionStatus?: SessionStatus;
  activeTurnStartedAt?: string;
  completedTurn?: CompletedTurn;
  menuLinks: MenuLink[];
  isArtifactPaneOpen?: boolean;
  onToggleArtifactPane?: () => void;
  isSidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onCopySession?: () => string | undefined;
  onRenameSession?: (nextTitle: string) => Promise<void> | void;
  hasPendingApprovals?: boolean;
}) {
  const { title, onRenameSession, onCopySession } = props;
  const { user, login, logout } = useAuth();
  const organizations = useOrganizations(Boolean(user));
  const currentSlug = user?.tenantSlug?.toLowerCase();
  const otherOrganizations = organizations.filter((org) => org.id.toLowerCase() !== currentSlug);
  const [sessionCopied, setSessionCopied] = useState(false);
  const [titleText, setTitleText] = useState(title);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    // A poll may rename the session while the user is editing. Keep their text
    // until they commit or cancel; the editable DOM owns the in-progress value.
    if (titleRef.current && document.activeElement !== titleRef.current) {
      setTitleText(title);
      titleRef.current.textContent = title;
    }
  }, [title, props.sessionActions?.sessionId]);

  const commitTitle = useCallback(() => {
    if (!onRenameSession) return;
    const next = (titleRef.current?.textContent ?? "").trim();
    if (!next || next === title) {
      setTitleText(title);
      if (titleRef.current) titleRef.current.textContent = title;
      return;
    }
    void onRenameSession(next);
  }, [onRenameSession, title]);

  const focusTitleForRename = useCallback(() => {
    titleRef.current?.focus();
    const selection = window.getSelection();
    if (selection && titleRef.current) {
      const range = document.createRange();
      range.selectNodeContents(titleRef.current);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, []);

  const handleTitleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLHeadingElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (titleRef.current) titleRef.current.textContent = title;
        setTitleText(title);
        event.currentTarget.blur();
      }
    },
    [title]
  );

  const handleCopySession = useCallback(() => {
    const text = onCopySession?.();
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setSessionCopied(true);
      setTimeout(() => setSessionCopied(false), 2000);
    });
  }, [onCopySession]);

  const isTitleEditable = Boolean(onRenameSession);
  const initials = avatarInitials(user?.displayName, user?.email);

  return (
    <header className="flex min-h-14 items-center gap-2 border-b border-outline-variant bg-surface-container-lowest px-2 py-2 sm:gap-4 sm:px-4">
      <div className="flex items-center gap-2">
        {props.onToggleSidebar ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={props.isSidebarOpen ? "Hide sidebar" : "Show sidebar"}
            onClick={props.onToggleSidebar}
          >
            <PanelLeftIcon />
          </Button>
        ) : null}
        {props.sessionStatus ? (
          <SessionStatusIndicator status={props.sessionStatus} startedAt={props.activeTurnStartedAt} completedTurn={props.completedTurn} showLabel />
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <h2
          key={props.sessionActions?.sessionId}
          ref={titleRef}
          className={`truncate text-base font-semibold text-on-surface outline-none ${
            isTitleEditable
              ? "cursor-text rounded px-1 -mx-1 hover:bg-surface-container-low focus:bg-surface-container-low"
              : ""
          }`}
          contentEditable={isTitleEditable}
          onBlur={isTitleEditable ? commitTitle : undefined}
          onKeyDown={isTitleEditable ? handleTitleKeyDown : undefined}
          spellCheck={false}
          suppressContentEditableWarning
          role={isTitleEditable ? "textbox" : undefined}
          aria-label={isTitleEditable ? "Session title" : undefined}
          title={isTitleEditable ? "Click to rename session" : undefined}
        >
          {titleText}
        </h2>
        {props.subtitle ? (
          <p className="truncate text-xs text-on-surface-variant">{props.subtitle}</p>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        {props.projectId ? <ProjectInstructionsIndicator key={props.projectId} projectId={props.projectId} /> : null}
        {props.sessionActions ? <SessionCapabilitiesButton key={props.sessionActions.sessionId}
          sessionId={props.sessionActions.sessionId}
          busy={Boolean(props.sessionActions.isRunning || props.sessionActions.hasPendingApprovals)} /> : null}
        {props.sessionActions ? <SessionActionMenu
          {...props.sessionActions}
          onRename={props.sessionActions.onRename ?? (onRenameSession ? focusTitleForRename : undefined)}
        /> : null}
        <ThemeToggle />

        {onCopySession ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={sessionCopied ? "Session copied!" : "Copy session to clipboard"}
            title={sessionCopied ? "Copied!" : "Copy session to clipboard"}
            onClick={handleCopySession}
          >
            {sessionCopied ? <CheckIcon className="text-success" /> : <ClipboardIcon />}
          </Button>
        ) : null}

        {props.onToggleArtifactPane ? (
          <div className="relative">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={props.isArtifactPaneOpen ? "Hide artifacts panel" : "Show artifacts panel"}
              onClick={props.onToggleArtifactPane}
            >
              <PanelRightIcon />
            </Button>
            {props.hasPendingApprovals ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute right-1 top-1 size-2 rounded-full bg-warning ring-2 ring-surface-container-lowest"
              />
            ) : null}
          </div>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open workspace menu"
              className="rounded-full"
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {initials}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {props.menuLinks.map((link) => (
              <DropdownMenuItem key={link.href} asChild>
                <Link href={link.href} className="flex flex-col items-start gap-0.5">
                  <span className="font-medium">{link.label}</span>
                  <span className="text-xs text-muted-foreground">{link.description}</span>
                </Link>
              </DropdownMenuItem>
            ))}
            {otherOrganizations.length > 0 ? <DropdownMenuSeparator /> : null}
            {otherOrganizations.map((org) => (
              <DropdownMenuItem
                key={org.id}
                onSelect={() => void login({ organization: org.id })}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="font-medium">Switch to {org.name}</span>
                <span className="text-xs text-muted-foreground">Sign in to this organization</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void logout()}
              className="flex flex-col items-start gap-0.5"
            >
              <span className="font-medium">Log out</span>
              <span className="text-xs text-muted-foreground">End this session and return to login</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
