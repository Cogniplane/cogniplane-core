"use client";

import { useQuery } from "@tanstack/react-query";
import { Compass, CornerDownLeft, FolderIcon, MessageSquare, MessagesSquare, Plug, Puzzle, Search, User, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { listAdminMcpServers, listAdminSessions, listAdminSkills, listAdminUsers } from "../../lib/admin-api";
import { useAuth } from "../../lib/auth-context";
import { SHORTCUTS, ariaKeyShortcut, isApplePlatform, matchesShortcut, otherOverlayOpen, shortcutKeys, useApplePlatform } from "../../lib/keyboard-shortcuts";
import { listProjects } from "../../lib/project-api";
import { queryKeys } from "../../lib/query-keys";
import { listSessions } from "../../lib/session-api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import {
  CATEGORY_LABELS,
  MAX_RESULTS_PER_CATEGORY,
  RECENT_SESSION_LIMIT,
  connectionItems,
  highlightParts,
  matchItems,
  mySessionItems,
  personItems,
  projectItems,
  quickJumpPages,
  searchTerms,
  sessionItems,
  skillItems,
  type QuickJumpCategory,
  type QuickJumpItem
} from "./quick-jump-model";

const CATEGORY_ICONS: Record<QuickJumpCategory, typeof Compass> = {
  pages: Compass,
  mySessions: MessageSquare,
  projects: FolderIcon,
  people: User,
  skills: Puzzle,
  connections: Plug,
  sessions: MessagesSquare
};

const KBD = "rounded border border-outline-variant bg-surface-container-low px-1.5 py-px font-mono text-[0.68rem] text-on-surface-variant";


/** Quick jump: a header button and Ctrl+K (Cmd+K on Apple devices). Each page header mounts one. */
export function QuickJump() {
  const [open, setOpen] = useState(false);
  const apple = useApplePlatform();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesShortcut(event, SHORTCUTS.quickJump, isApplePlatform())) return;
      if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
      if (contentRef.current) {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (otherOverlayOpen()) return;
      event.preventDefault();
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-keyshortcuts={ariaKeyShortcut(SHORTCUTS.quickJump, apple)}
        onClick={() => { returnFocusRef.current = triggerRef.current; setOpen(true); }}
        className="inline-flex size-8 cursor-pointer items-center justify-center gap-2 rounded-md bg-surface-container-lowest text-sm text-on-surface-variant shadow-[inset_0_0_0_1px_var(--color-outline-variant)] transition-colors hover:bg-surface-container hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary sm:w-auto sm:px-2.5"
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">Jump to…</span>
        <kbd className={`${KBD} hidden sm:inline`} aria-hidden="true">{shortcutKeys(SHORTCUTS.quickJump, apple).join(apple ? "" : " ")}</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          ref={contentRef}
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocusRef.current;
            (target && target.isConnected && target !== document.body ? target : triggerRef.current)?.focus();
          }}
          className="top-[max(1rem,10vh)] max-h-[min(36rem,calc(100dvh-2rem))] translate-y-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-xl"
        >
          <QuickJumpPanel
            onClose={() => setOpen(false)}
            onNavigate={() => { returnFocusRef.current = triggerRef.current; setOpen(false); }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

type SearchedCategory = Exclude<QuickJumpCategory, "pages">;
const MEMBER_CATEGORIES: readonly SearchedCategory[] = ["mySessions", "projects"];
const ADMIN_CATEGORIES: readonly SearchedCategory[] = ["mySessions", "projects", "people", "skills", "connections", "sessions"];

type CategoryState = { status: "loading" | "error" | "ready"; items: QuickJumpItem[]; retry?: () => void };

function categoryState<T>(query: { data: T | undefined; isError: boolean; refetch: () => unknown }, toItems: (data: T) => QuickJumpItem[]): CategoryState {
  if (query.data !== undefined) return { status: "ready", items: toItems(query.data) };
  return { status: query.isError ? "error" : "loading", items: [], retry: () => void query.refetch() };
}

function QuickJumpPanel({ onClose, onNavigate }: { onClose: () => void; onNavigate: () => void }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const ids = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState({ query: "", index: 0 });

  // These reads run only while the dialog is open. Admin lists share cache keys with the admin pages
  // and are read only for admins.
  const mySessions = useQuery({
    queryKey: [...queryKeys.sessions.list(), "quick-jump"],
    queryFn: () => listSessions()
  });
  const projects = useQuery({ queryKey: queryKeys.projects.list(), queryFn: () => listProjects() });
  const people = useQuery({ queryKey: queryKeys.admin.users(), queryFn: listAdminUsers, enabled: isAdmin });
  const skills = useQuery({ queryKey: queryKeys.admin.skills(), queryFn: listAdminSkills, enabled: isAdmin });
  const connections = useQuery({ queryKey: queryKeys.admin.mcpServers(), queryFn: listAdminMcpServers, enabled: isAdmin });
  const sessions = useQuery({
    queryKey: [...queryKeys.admin.sessions({ limit: RECENT_SESSION_LIMIT }), "quick-jump"],
    queryFn: () => listAdminSessions({ limit: RECENT_SESSION_LIMIT }),
    enabled: isAdmin
  });

  const categories = useMemo(() => isAdmin ? ADMIN_CATEGORIES : MEMBER_CATEGORIES, [isAdmin]);
  const states = useMemo<Record<SearchedCategory, CategoryState>>(() => ({
    mySessions: categoryState(mySessions, (data) => mySessionItems(data.sessions, projects.data)),
    projects: categoryState(projects, projectItems),
    people: categoryState(people, personItems),
    skills: categoryState(skills, skillItems),
    connections: categoryState(connections, connectionItems),
    sessions: categoryState(sessions, (data) => sessionItems(data.items, people.data))
  }), [mySessions, projects, people, skills, connections, sessions]);

  const pages = useMemo(() => quickJumpPages({ isAdmin, pathname }), [isAdmin, pathname]);
  const searching = searchTerms(query).length > 0;
  const groups = useMemo(() => {
    const matchedPages = matchItems(pages, query);
    const result: { category: QuickJumpCategory; items: QuickJumpItem[]; hidden: number }[] = [
      { category: "pages", items: searching ? matchedPages.slice(0, MAX_RESULTS_PER_CATEGORY) : matchedPages, hidden: searching ? Math.max(0, matchedPages.length - MAX_RESULTS_PER_CATEGORY) : 0 }
    ];
    if (searching) {
      for (const category of categories) {
        const matches = matchItems(states[category].items, query);
        result.push({ category, items: matches.slice(0, MAX_RESULTS_PER_CATEGORY), hidden: Math.max(0, matches.length - MAX_RESULTS_PER_CATEGORY) });
      }
    }
    return result.filter((group) => group.items.length > 0);
  }, [pages, query, searching, states, categories]);

  const options = groups.flatMap((group) => group.items);
  const activeIndex = options.length === 0 ? -1 : active.query === query ? Math.min(active.index, options.length - 1) : 0;
  const activeItem = activeIndex >= 0 ? options[activeIndex] : undefined;
  const optionId = (item: QuickJumpItem) => `${ids}-option-${options.indexOf(item)}`;
  const activeId = activeItem ? optionId(activeItem) : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const go = (href: string) => {
    onNavigate();
    router.push(href);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive({ query, index: (activeIndex + step + options.length) % options.length });
    } else if (event.key === "Enter" && activeItem && !event.nativeEvent.isComposing) {
      event.preventDefault();
      go(activeItem.href);
    }
  };

  const unavailable = categories.filter((category) => states[category].status !== "ready");
  const searched = ["pages", ...categories.filter((category) => states[category].status === "ready")]
    .map((category) => CATEGORY_LABELS[category as QuickJumpCategory].toLowerCase());
  const terms = searchTerms(query);
  const listboxId = `${ids}-listbox`;

  return (
    <>
      <DialogTitle className="sr-only">Jump to</DialogTitle>
      <DialogDescription className="sr-only">
        Search pages, {joinList(categories.map((category) => CATEGORY_LABELS[category].toLowerCase()))}. Only the {RECENT_SESSION_LIMIT} most recent sessions are searched. Use the arrow keys to choose a result and Enter to open it.
      </DialogDescription>
      <div className="flex min-w-0 items-center gap-3 border-b border-outline-variant px-4">
        <Search className="size-4 shrink-0 text-on-surface-variant" aria-hidden="true" />
        <input
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label="Jump to"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isAdmin ? "Search pages, sessions, projects, people, skills, connections" : "Search pages, sessions, and projects"}
          className="h-14 min-w-0 flex-1 bg-transparent text-base text-on-surface outline-none placeholder:text-on-surface-faint"
        />
        <button type="button" onClick={onClose} className="inline-flex shrink-0 items-center rounded-md p-1 text-on-surface-variant hover:bg-surface-container hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary">
          <kbd className={`${KBD} hidden sm:inline`} aria-hidden="true">Esc</kbd>
          <X className="size-4 sm:hidden" aria-hidden="true" />
          <span className="sr-only">Close</span>
        </button>
      </div>

      <div className="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-2 pb-2">
        <div role="listbox" id={listboxId} aria-label="Results">
          {groups.map((group) => (
            <div key={group.category} role="group" aria-labelledby={`${ids}-${group.category}`}>
              <div className="flex items-baseline justify-between gap-3 px-2 pb-1 pt-3">
                <p id={`${ids}-${group.category}`} className="text-xs font-semibold text-on-surface-variant">{CATEGORY_LABELS[group.category]}</p>
                {group.category === "sessions" || group.category === "mySessions" ? <p className="text-xs text-on-surface-faint" aria-hidden="true">Latest {RECENT_SESSION_LIMIT} only</p> : null}
              </div>
              {group.items.map((item) => (
                <ResultOption
                  key={item.id}
                  id={optionId(item)}
                  item={item}
                  terms={terms}
                  active={item === activeItem}
                  onHover={() => setActive({ query, index: options.indexOf(item) })}
                  onSelect={() => go(item.href)}
                />
              ))}
              {group.hidden > 0 ? <p className="px-2 pb-1 pt-0.5 text-xs text-on-surface-faint" aria-hidden="true">{group.hidden} more. Add words to narrow the results.</p> : null}
            </div>
          ))}
        </div>

        {searching && options.length === 0 ? (
          <p className="px-2 pt-6 pb-2 text-sm text-on-surface-variant">No matches in {joinList(searched)}.</p>
        ) : null}

        {searching && unavailable.length > 0 ? (
          <ul aria-label="Categories not searched" className="mt-3 space-y-1 border-t border-outline-variant px-2 pt-3">
            {unavailable.map((category) => (
              <li key={category} className="flex items-center justify-between gap-3 text-sm">
                {states[category].status === "loading" ? (
                  <p role="status" className="text-on-surface-variant">Loading {CATEGORY_LABELS[category].toLowerCase()}…</p>
                ) : (
                  <>
                    <p className="min-w-0 text-danger">Could not load {CATEGORY_LABELS[category].toLowerCase()}. They were not searched.</p>
                    <button type="button" onClick={states[category].retry} aria-label={`Retry ${CATEGORY_LABELS[category].toLowerCase()}`} className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-primary">
                      Retry
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {searching && states.sessions.status === "ready" ? (
          <p className="px-2 pt-3 text-xs text-on-surface-faint">
            Sessions: only the {RECENT_SESSION_LIMIT} most recently active are searched here.{" "}
            <button type="button" onClick={() => go("/admin/sessions")} className="font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-primary">
              Filter all sessions
            </button>
          </p>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center justify-between gap-3 border-t border-outline-variant px-4 py-2 text-xs text-on-surface-faint">
        <p className="min-w-0">Searches names, emails, and IDs. Never message content.</p>
        <p className="hidden shrink-0 items-center gap-1.5 sm:flex" aria-hidden="true">
          <kbd className={KBD}>↑</kbd><kbd className={KBD}>↓</kbd> move <kbd className={`${KBD} ml-1`}>↵</kbd> open
        </p>
      </div>
      <p className="sr-only" aria-live="polite">{searching ? `${options.length} result${options.length === 1 ? "" : "s"}` : ""}</p>
    </>
  );
}

function ResultOption(props: { id: string; item: QuickJumpItem; terms: readonly string[]; active: boolean; onHover: () => void; onSelect: () => void }) {
  const Icon = CATEGORY_ICONS[props.item.category];
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.active}
      onMouseMove={props.active ? undefined : props.onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onSelect}
      className={`flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 ${props.active ? "bg-brand-surface" : ""}`}
    >
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-md ${props.active ? "bg-surface-container-lowest text-brand-strong" : "bg-surface-container text-on-surface-variant"}`}>
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-sm font-medium ${props.active ? "text-brand-strong" : "text-on-surface"}`}>
          <Highlighted text={props.item.title} terms={props.terms} />
        </span>
        {props.item.detail ? <span className="block truncate text-xs text-on-surface-variant">{props.item.detail}</span> : null}
      </span>
      {props.active ? <CornerDownLeft className="size-4 shrink-0 text-brand-strong" aria-hidden="true" /> : null}
    </div>
  );
}

function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
  return <>{highlightParts(text, terms).map((part, index) => part.match
    ? <mark key={index} className="rounded-sm bg-transparent font-semibold text-inherit underline decoration-2 underline-offset-2">{part.text}</mark>
    : <Fragment key={index}>{part.text}</Fragment>)}</>;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
