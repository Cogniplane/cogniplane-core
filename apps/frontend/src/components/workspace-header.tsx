"use client";

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon, ClipboardIcon, PanelLeftIcon, PanelRightIcon } from "lucide-react";

import { toast } from "sonner";

import { useElementWidth } from "../hooks/use-element-width";
import { SHORTCUTS, ariaKeyShortcut, useApplePlatform } from "../lib/keyboard-shortcuts";
import { SessionActionMenu, type SessionActionMenuProps } from "./session-action-menu";
import { SessionStatusIndicator } from "./session-status";
import { ProjectInstructionsIndicator } from "./project-instructions-indicator";
import { SessionCapabilitiesButton } from "./session-capabilities";
import type { CompletedTurn, SessionStatus } from "./session-status.logic";
import { QuickJump } from "./quick-jump/quick-jump";
import { ThemeToggle } from "./theme-toggle";
import { AccountMenu, type AccountMenuDestination } from "./account-menu";
import { Button } from "@/components/ui/button";

/** Below this header width, the header uses two rows and moves low-use controls into menus. */
const COMPACT_HEADER_WIDTH = 720;
/** Below this width, Ready is icon-only. Approval, error, and running text remain visible. */
const TIGHT_HEADER_WIDTH = 360;

export function WorkspaceHeader({ artifactToggleRef, ...props }: {
  title: string;
  projectId?: string | null;
  sessionActions?: SessionActionMenuProps;
  subtitle?: string;
  sessionStatus?: SessionStatus;
  activeTurnStartedAt?: string;
  completedTurn?: CompletedTurn;
  destinations: readonly AccountMenuDestination[];
  isArtifactPaneOpen?: boolean;
  onToggleArtifactPane?: () => void;
  artifactToggleRef?: Ref<HTMLButtonElement>;
  isSidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onCopySession?: () => string | undefined;
  onRenameSession?: (nextTitle: string) => Promise<void> | void;
  hasPendingApprovals?: boolean;
}) {
  const { title, onRenameSession, onCopySession } = props;
  const headerRef = useRef<HTMLElement | null>(null);
  const headerWidth = useElementWidth(headerRef);
  const compact = headerWidth !== null && headerWidth < COMPACT_HEADER_WIDTH;
  const tight = headerWidth !== null && headerWidth < TIGHT_HEADER_WIDTH;
  const [sessionCopied, setSessionCopied] = useState(false);
  const [titleText, setTitleText] = useState(title);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const titleEdit = useRef<{ text: string; sessionId: string | undefined } | null>(null);

  // The narrow layout moves the title. Keep an active edit when that move
  // replaces the editable element, such as when the sidebar is opened.
  useLayoutEffect(() => {
    const draft = titleEdit.current;
    const node = titleRef.current;
    if (!draft || draft.sessionId !== props.sessionActions?.sessionId || !node) return;
    node.textContent = draft.text;
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }, [compact, props.sessionActions?.sessionId]);

  useEffect(() => {
    // A poll may rename the session while the user is editing. Keep their text
    // until they commit or cancel; the editable DOM owns the in-progress value.
    if (titleRef.current && document.activeElement !== titleRef.current) {
      setTitleText(title);
      titleRef.current.textContent = title;
    }
  }, [title, props.sessionActions?.sessionId]);

  const commitTitle = useCallback(() => {
    titleEdit.current = null;
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

  // The copy button is in the session menu on a narrow header, so the result
  // is a toast instead of the button's check mark.
  const copySessionFromMenu = useCallback(() => {
    const text = onCopySession?.();
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => toast.success("Session copied"),
      () => toast.error("Could not copy the session")
    );
  }, [onCopySession]);

  const isTitleEditable = Boolean(onRenameSession);
  const apple = useApplePlatform();
  // Comfortable touch targets on the narrow header, compact ones on desktop.
  const iconSize = compact ? "size-10" : undefined;

  const sidebarToggle = props.onToggleSidebar ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={iconSize}
      aria-label={props.isSidebarOpen ? "Hide sidebar" : "Show sidebar"}
      data-workspace-sidebar-trigger
      aria-keyshortcuts={ariaKeyShortcut(SHORTCUTS.toggleSidebar, apple)}
      onClick={props.onToggleSidebar}
    >
      <PanelLeftIcon />
    </Button>
  ) : null;

  const titleBlock = (
    <div className="min-w-0 flex-1">
      <h2
        key={props.sessionActions?.sessionId}
        ref={titleRef}
        className={`truncate text-base font-semibold text-on-surface outline-none ${
          isTitleEditable
            ? "-mx-1 cursor-text rounded px-1 hover:bg-surface-container-low focus:bg-surface-container-low focus-visible:ring-[3px] focus-visible:ring-ring/50"
            : ""
        }`}
        contentEditable={isTitleEditable}
        onFocus={isTitleEditable ? (event) => {
          titleEdit.current = { text: event.currentTarget.textContent ?? "", sessionId: props.sessionActions?.sessionId };
        } : undefined}
        onInput={isTitleEditable ? (event) => {
          titleEdit.current = { text: event.currentTarget.textContent ?? "", sessionId: props.sessionActions?.sessionId };
        } : undefined}
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
  );

  const status = props.sessionStatus ? (
    <SessionStatusIndicator
      status={props.sessionStatus}
      startedAt={props.activeTurnStartedAt}
      completedTurn={props.completedTurn}
      showLabel
      labelClassName={tight && props.sessionStatus === "ready" ? "sr-only" : ""}
    />
  ) : null;

  const sessionTools: ReactNode[] = [
    props.projectId ? <ProjectInstructionsIndicator key={`project-${props.projectId}`} projectId={props.projectId} compact={compact} className={iconSize} /> : null,
    props.sessionActions ? <SessionCapabilitiesButton key={`capabilities-${props.sessionActions.sessionId}`}
      sessionId={props.sessionActions.sessionId}
      className={iconSize}
      busy={Boolean(props.sessionActions.isRunning || props.sessionActions.hasPendingApprovals)} /> : null,
    props.sessionActions ? <SessionActionMenu
      key="session-actions"
      {...props.sessionActions}
      triggerClassName={iconSize}
      onCopyConversation={compact && onCopySession ? copySessionFromMenu : undefined}
      onRename={props.sessionActions.onRename ?? (onRenameSession ? focusTitleForRename : undefined)}
    /> : null
  ];

  const copyButton = onCopySession && !compact ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={sessionCopied ? "Session copied" : "Copy session to clipboard"}
      title={sessionCopied ? "Copied" : "Copy session to clipboard"}
      onClick={handleCopySession}
    >
      {sessionCopied ? <CheckIcon className="text-success" /> : <ClipboardIcon />}
    </Button>
  ) : null;

  const artifactToggle = props.onToggleArtifactPane ? (
    <div className="relative shrink-0">
      <Button
        ref={artifactToggleRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        className={iconSize}
        aria-label={`${props.isArtifactPaneOpen ? "Hide artifacts panel" : "Show artifacts panel"}${props.hasPendingApprovals ? ", approval waiting" : ""}`}
        aria-keyshortcuts={ariaKeyShortcut(SHORTCUTS.toggleArtifacts, apple)}
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
  ) : null;

  // One header element in both layouts, so the width observer keeps watching it.
  return (
    <header
      ref={headerRef}
      className={`border-b border-outline-variant bg-surface-container-lowest ${
        compact ? "flex flex-col gap-0.5 px-2 py-1" : "flex min-h-14 items-center gap-3 px-4 py-2"
      }`}
    >
      {compact ? (
        // Two rows: what the session is (title, account), then what you can do
        // with it. Every control stays on screen; theme and copy move into menus.
        <>
          <div className="flex min-h-11 items-center gap-1">
            {sidebarToggle}
            {titleBlock}
            <AccountMenu destinations={props.destinations} includeTheme triggerClassName="size-10" />
          </div>
          <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 pl-2">
            {status}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
              {sessionTools}
              <QuickJump compact className="size-10" />
              {artifactToggle}
            </div>
          </div>
        </>
      ) : (
        <>
          {sidebarToggle}
          {titleBlock}
          {status}
          <div className="flex shrink-0 items-center gap-1">
            {sessionTools}
            <QuickJump />
            <ThemeToggle />
            {copyButton}
            {artifactToggle}
            <AccountMenu destinations={props.destinations} />
          </div>
        </>
      )}
    </header>
  );
}
