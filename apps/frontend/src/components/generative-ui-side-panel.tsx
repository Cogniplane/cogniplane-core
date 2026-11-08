"use client";
// The side panel: the one place outside the transcript where the agent can
// show generated UI. It is CopilotKit's GenerativeUISurface for the target
// GENERATIVE_UI_PANEL_TARGET, inside the chat host's provider.
//
// How a surface gets here. A render_ui call with that target makes an activity
// message, as a chat call does. The transcript does not render it: the host
// drops panel activities from the rendered rows (transcriptRows). Instead
// useSidePanelState reads every panel activity of the agent's messages into
// the surface manager, in transcript order, on each message change. So the
// manager sees the panel views in reply order, whichever rows CopilotChat
// mounts. GenerativeUISurface then shows the newest surface of the target.
// Saved activities follow the same path when the history loads, so a reload
// restores the panel. The host remounts per session, so the panel of one
// session never shows in another.
//
// Earlier views. The panel names the view that it shows (its root title, or
// "Generated view") and the reply that holds it, and a picker lists the other
// views, newest first. The latest view is the default. CopilotKit has no
// renderer that takes a surface id: GenerativeUISurface shows the newest
// surface of its target. So the host gives every view but the chosen one the
// parked target (lib/agui/generative-ui-targets.ts), with the same content as
// before. Only the selected view keeps the panel target. The manager keeps each
// surface, its operations and the values of the user, so a switch re-runs no
// tool, applies no operation again and sends nothing. Which view shows is the
// pin of the user, checked against the transcript and the manager on each read:
// a chosen view that is gone, or that is now the latest, ends the pin.
//
// The panel is closed by default and stays mounted when closed. So the target
// stays registered, the guide of every message offers it, and a close keeps
// the transcript, the message box and what the user typed in the panel.
//
// Telling the user about a view. A view that arrives live (an ACTIVITY_SNAPSHOT
// event of a surface that this tab has not seen) is new. A view that the
// history load brings, on the first load or on a later connection, is not:
// it never opens the panel and never shows a notice.
//   - Wide host: the first new view opens the panel, unless the user closed
//     it earlier in this session. The open moves no focus and scrolls nothing.
//   - Narrow host, or after a close by the user: the panel stays closed. A
//     notice with a "View side panel" button appears, the toggle shows a "New"
//     label, and a status region announces the view.
// An open that the user asks for moves focus to the Close button, and a close
// moves it back to the toggle.
//
// Wide or narrow is the width of the chat host row, not of the viewport. The
// shell's sidebar and artifacts panel can leave the host little room on a
// wide screen. The panel goes beside the chat only when the chat keeps its
// minimum width next to it (artifact-pane-geometry.ts). On a narrow host an
// open panel covers the chat, so it is a modal: the page behind it is inert,
// Tab stays inside it, and Escape closes it. A wide host keeps the panel beside
// the chat and nonmodal, where Escape still means Stop. When the host gets
// narrow while the panel is open beside the chat, the panel closes instead of
// covering the chat and taking the focus.

import type { AbstractAgent, Message } from "@ag-ui/client";
import { GENERATIVE_UI_PANEL_TARGET } from "@cogniplane/shared-types";
import { GenerativeUISurface, useGenerativeUIRuntime } from "@copilotkit/react-core/v2/generative-ui";
import { GENERATIVE_UI_ACTIVITY_TYPE, GENERATIVE_UI_ROOT_ID, type GenerativeUISurfaceContent } from "@copilotkit/shared";
import { PanelRightIcon } from "lucide-react";
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type RefObject
} from "react";

import { useElementWidth } from "../hooks/use-element-width";

import { PARKED_PANEL_TARGET, REMOVED_PANEL_TARGET } from "../lib/agui/generative-ui-targets";
import { keepTabInside, makeBackgroundInert } from "../lib/inert-background";
import { generatedViewFitsBeside } from "./artifact-pane-geometry";
import { WORKSPACE_DRAWER_BACKDROP, WORKSPACE_DRAWER_SURFACE, WorkspaceDrawerHeader } from "./workspace-drawer";
import { COGNIPLANE_GENERATIVE_UI } from "./generative-ui-catalog";
import {
  DEFAULT_VIEW_TITLE, effectivePin, panelActivities, panelContent, viewLabels, viewTitle,
  type ViewEntry
} from "./generative-ui-views.logic";

/** What the model reads about the panel, in the Targets list of its guide. */
export const SIDE_PANEL_DESCRIPTION =
  "The side panel next to the chat. Use it for one view that the user keeps beside the conversation, such as "
  + "a summary, a table, a checklist or ArtifactCards. The panel shows the newest surface, and the user can pick "
  + "an earlier surface from a list. The list names a view by the title of its root component, so give a "
  + "Checklist, ComparisonTable or StatusSummary root a short title. It opens by "
  + "itself on a wide screen unless the user closed it, and a narrow screen shows a View side panel button "
  + "instead, so the user may not see the view at once. Say in your reply that the view is in the side panel.";

const NEW_VIEW_NOTICE = "The agent added a view to the side panel.";
const OPENED_NOTICE = "The agent opened a view in the side panel.";

// The backend withdraws a preview mid-stream with no operations. A delete
// would burn the surface id in the SDK, and a retry in the same turn reuses
// it. This target, which nothing mounts, takes the preview out of the panel.
const WITHDRAWN_PREVIEW_TARGET = `${GENERATIVE_UI_PANEL_TARGET}:withdrawn`;

const noSubscription = () => () => undefined;
const noVersion = () => 0;

// Before the host row has a layout box (the first render, or a browser without
// ResizeObserver), the md breakpoint (768px) decides.
const NARROW_QUERY = "(max-width: 767px)";
const hasMatchMedia = () => typeof window !== "undefined" && typeof window.matchMedia === "function";
const isNarrow = () => hasMatchMedia() && window.matchMedia(NARROW_QUERY).matches;
function subscribeNarrow(notify: () => void) {
  if (!hasMatchMedia()) return () => undefined;
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}

/** A chat preview that the backend withdrew mid-stream: no operations and no
 *  rejections. The SDK renders it as an empty card. */
function isWithdrawnPreview(message: Message): boolean {
  if (message.role !== "activity" || message.activityType !== GENERATIVE_UI_ACTIVITY_TYPE) return false;
  const content = message.content as Partial<GenerativeUISurfaceContent> | undefined;
  return Array.isArray(content?.operations) && content.operations.length === 0 && !content.rejected?.length;
}

/** For CopilotChatMessageView's transformMessages: a panel activity takes no
 *  transcript row, so a mounted row can never feed the panel. A withdrawn
 *  chat preview takes no row either. A retry in the same turn, or the delete
 *  at the end of the turn, has operations, so its row shows it again. */
export function transcriptRows(messages: Message[]): Message[] {
  const hidden = (message: Message) => panelContent(message) !== undefined || isWithdrawnPreview(message);
  return messages.some(hidden) ? messages.filter((message) => !hidden(message)) : messages;
}

export type SidePanelState = {
  /** The panel has a view, a refused one included. */
  hasView: boolean;
  /** The shown view is still being written. */
  streaming: boolean;
  /** Some operations of the shown view were refused. */
  incomplete: boolean;
  /** The browser rejected the createSurface of the shown view. */
  failed: boolean;
  /** The SDK target resolves to the view named by the header. */
  renderable: boolean;
  /** The views that the transcript holds and the manager did not delete,
   *  oldest first. */
  views: ViewEntry[];
  /** The view that the panel shows: the one that the user chose, else the latest. */
  selected: ViewEntry | undefined;
  /** The user chose an earlier view, and a newer one exists. */
  browsing: boolean;
};

export type SidePanelNavigation = {
  /** Shows an earlier view. Choosing the latest view, or a view that is gone,
   *  shows the latest. */
  select: (surfaceId: string) => void;
  /** Goes back to the latest view, which is the default. */
  showLatest: () => void;
};

/** What the browser built for the root component of a view. */
function rootOf(model: {
  componentsModel: { get(id: string): { type: string; properties: Record<string, unknown> } | undefined };
}) {
  const root = model.componentsModel.get(GENERATIVE_UI_ROOT_ID);
  return root ? { type: root.type, properties: root.properties } : undefined;
}

/** Feeds the panel from the agent's messages and reports what it shows.
 *  `onLiveView` gets the surface id of each new view that arrives live. */
export function useSidePanelState(
  agent: AbstractAgent,
  agentId: string,
  onLiveView?: (surfaceId: string) => void
): { state: SidePanelState } & SidePanelNavigation {
  const manager = useGenerativeUIRuntime()?.manager;
  const threadId = agent.threadId;
  // The panel views of the transcript, oldest first, and the view that the
  // user chose. The ref is what a read uses, the state is what a render uses.
  const [listed, setListed] = useState<ReadonlyArray<{ surfaceId: string; reply: number }>>([]);
  const [pinned, setPinned] = useState<string | undefined>(undefined);
  const pinRef = useRef<string | undefined>(undefined);
  const readRef = useRef<(() => void) | null>(null);
  const liveViewRef = useRef(onLiveView);
  useEffect(() => {
    liveViewRef.current = onLiveView;
  });
  useLayoutEffect(() => {
    if (!manager || !threadId) return;
    // The manager shows the surfaces of the active thread. This provider has
    // one thread, so the panel does not wait for a run start.
    manager.setActiveThread(threadId);
    // The views that this host has read, and those that a live snapshot event
    // announced. A history load sends messages, never snapshot events, so a
    // view that first appears without an event is not new.
    const seen = new Set<string>();
    const announced = new Set<string>();
    // The content that the manager got for each view. A view that the
    // transcript no longer holds (a reconnect replaced the history) is not a
    // view of the panel, so it needs this content to leave the panel.
    const given = new Map<string, GenerativeUISurfaceContent>();
    let listedKey = "";

    // Gives the manager every panel activity of the messages, in transcript
    // order. With a `showing` view, every other view is parked: the surface,
    // its operations and its values stay, and only its target changes. Returns
    // the surface ids of all panel activities.
    const ingestAll = (messages: readonly Message[], showing: string | undefined, notice: boolean) => {
      const present = new Set<string>();
      for (const message of messages) {
        const content = panelContent(message);
        if (!content) continue;
        present.add(content.surfaceId);
        if (content.operations.length === 0) {
          given.delete(content.surfaceId);
          manager.ingest(threadId, agentId, { ...content, target: WITHDRAWN_PREVIEW_TARGET });
          continue;
        }
        given.set(content.surfaceId, content);
        // The manager applies only new operations, so a repeat read is free.
        manager.ingest(threadId, agentId, showing !== undefined && content.surfaceId !== showing
          ? { ...content, target: PARKED_PANEL_TARGET }
          : content);
        if (notice && !seen.has(content.surfaceId)) {
          seen.add(content.surfaceId);
          if (announced.has(content.surfaceId)) liveViewRef.current?.(content.surfaceId);
        }
      }
      return present;
    };

    const read = (messages: readonly Message[]) => {
      const views = panelActivities(messages);
      const chosen = pinRef.current;
      const first = views.some((view) => view.surfaceId === chosen) ? chosen : views[views.length - 1]?.surfaceId;
      const present = ingestAll(messages, first, true);
      // What the user can look at: the manager holds the surface, or the
      // browser refused it and the panel says so.
      const available = views
        .filter((view) => manager.getSurface(threadId, view.surfaceId) || manager.getFailedSurface(threadId, view.surfaceId))
        .map((view) => view.surfaceId);
      // A chosen view that the agent deleted, that the history no longer
      // holds, or that is now the latest ends the choice.
      const pin = effectivePin(available, chosen);
      // Transcript order decides what shows. The SDK's creation order can
      // differ after a withdrawn preview is retried, so always park the rest.
      const latest = available[available.length - 1];
      const showing = pin ?? latest;
      if (showing !== first) ingestAll(messages, showing, false);
      for (const [surfaceId, content] of given) {
        if (present.has(surfaceId)) continue;
        given.delete(surfaceId);
        manager.ingest(threadId, agentId, { ...content, target: REMOVED_PANEL_TARGET });
      }
      pinRef.current = pin;
      setPinned(pin);
      const key = views.map((view) => `${view.reply}:${view.surfaceId}`).join("\n");
      if (key !== listedKey) {
        listedKey = key;
        setListed(views.map(({ surfaceId, reply }) => ({ surfaceId, reply })));
      }
    };
    readRef.current = () => read(agent.messages);
    read(agent.messages);
    const subscription = agent.subscribe({
      // The event comes before the messages change, so the read that follows
      // knows that this view is live.
      onActivitySnapshotEvent: ({ event }) => {
        const content = event.content as Partial<GenerativeUISurfaceContent> | undefined;
        if (event.activityType === GENERATIVE_UI_ACTIVITY_TYPE && content?.target === GENERATIVE_UI_PANEL_TARGET
          && typeof content.surfaceId === "string" && Array.isArray(content.operations) && content.operations.length > 0) {
          announced.add(content.surfaceId);
        }
      },
      onMessagesChanged: ({ messages }) => read(messages)
    });
    return () => {
      readRef.current = null;
      subscription.unsubscribe();
    };
  }, [agent, agentId, manager, threadId]);

  const select = useCallback((surfaceId: string) => {
    pinRef.current = surfaceId;
    readRef.current?.();
  }, []);
  const showLatest = useCallback(() => {
    pinRef.current = undefined;
    readRef.current?.();
  }, []);

  useSyncExternalStore(manager?.subscribe ?? noSubscription, manager?.getVersion ?? noVersion, noVersion);
  // The SDK skips a surface whose createSurface failed and shows an older
  // one, so each view carries its own state, and the panel never takes the
  // state of an older view for the state of the shown one.
  const views: ViewEntry[] = [];
  if (manager && threadId) {
    for (const { surfaceId, reply } of listed) {
      const surface = manager.getSurface(threadId, surfaceId);
      if (surface) {
        views.push({ surfaceId, reply, title: viewTitle(rootOf(surface.model)), status: surface.status === "streaming" ? "streaming" : "ready" });
      } else if (manager.getFailedSurface(threadId, surfaceId)) {
        views.push({ surfaceId, reply, title: DEFAULT_VIEW_TITLE, status: "failed" });
      }
    }
  }
  const pin = effectivePin(views.map((view) => view.surfaceId), pinned);
  const selected = pin === undefined ? views[views.length - 1] : views.find((view) => view.surfaceId === pin);
  const shown = manager && threadId && selected ? manager.getSurface(threadId, selected.surfaceId) : undefined;
  return {
    state: {
      hasView: views.length > 0,
      streaming: selected?.status === "streaming",
      incomplete: shown !== undefined && shown.serverRejected.length + shown.clientRejected.length > 0,
      failed: selected?.status === "failed",
      renderable: selected !== undefined && manager?.getSurfaceForTarget(GENERATIVE_UI_PANEL_TARGET, threadId)?.surfaceId === selected.surfaceId,
      views,
      selected,
      browsing: pin !== undefined
    },
    select,
    showLatest
  };
}

export type SidePanel = SidePanelNavigation & {
  state: SidePanelState;
  open: boolean;
  /** A new view arrived while the panel was closed, and the user has not opened it. */
  waiting: boolean;
  /** For a status region: what just happened, until the user opens or closes the panel. */
  announcement: string;
  /** Narrow host row: an open panel covers the chat. */
  narrow: boolean;
  /** The callback ref for the host row that holds the chat and the panel. The
   *  panel measures that row. A callback, so the returned object holds no ref
   *  that the host would read during render. */
  rowRef: (row: HTMLDivElement | null) => void;
  /** Counts the opens that the user asked for. The panel moves focus on each. */
  focusRequest: number;
  toggle: () => void;
  show: () => void;
  close: () => void;
};

/** The state of the panel: what it shows, whether it is open, and what the
 *  user still has to be told. */
export function useSidePanel(agent: AbstractAgent, agentId: string): SidePanel {
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const [row, rowRef] = useState<HTMLDivElement | null>(null);
  const rowHolder = useMemo(() => ({ current: row }), [row]);
  const rowWidth = useElementWidth(rowHolder);
  const viewportNarrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  // A width of 0 is a row without a layout box, which tells nothing.
  const narrow = rowWidth ? !generatedViewFitsBeside(rowWidth) : viewportNarrow;
  // The callbacks of the agent read these, so they are refs.
  const openRef = useRef(false);
  const narrowRef = useRef(narrow);
  const userClosed = useRef(false);

  // The host got narrow while the panel was open beside the chat. Close it in
  // this render, before a modal can take the focus. This is not a close by the
  // user, so the next new view still opens a wide panel.
  const [wasNarrow, setWasNarrow] = useState(narrow);
  if (narrow !== wasNarrow) {
    setWasNarrow(narrow);
    if (narrow && open) setOpen(false);
  }
  useLayoutEffect(() => {
    openRef.current = open;
    narrowRef.current = narrow;
  }, [open, narrow]);

  const show = useCallback(() => {
    openRef.current = true;
    setOpen(true);
    setWaiting(false);
    setAnnouncement("");
    setFocusRequest((count) => count + 1);
  }, []);
  const close = useCallback(() => {
    userClosed.current = true;
    openRef.current = false;
    setOpen(false);
    setAnnouncement("");
  }, []);
  const toggle = useCallback(() => (openRef.current ? close() : show()), [close, show]);

  const onLiveView = useCallback(() => {
    if (openRef.current) return;
    if (userClosed.current || narrowRef.current) {
      setWaiting(true);
      setAnnouncement(NEW_VIEW_NOTICE);
      return;
    }
    // Wide host, and the user has not closed the panel: show the view. No
    // focus moves, so a user who types in the message box keeps typing.
    openRef.current = true;
    setOpen(true);
    setWaiting(false);
    setAnnouncement(OPENED_NOTICE);
  }, []);

  const { state, select, showLatest } = useSidePanelState(agent, agentId, onLiveView);
  return { state, select, showLatest, open, waiting, announcement, narrow, rowRef, focusRequest, toggle, show, close };
}

export function SidePanelToggle({ ref, panelId, open, hasView, waiting, onToggle }: {
  ref: RefObject<HTMLButtonElement | null>;
  panelId: string;
  open: boolean;
  hasView: boolean;
  waiting: boolean;
  onToggle: () => void;
}) {
  const closedWithNewView = waiting && !open;
  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={onToggle}
      className={`relative mr-auto inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-3 py-1 text-sm font-medium text-on-surface hover:bg-surface-container focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${closedWithNewView ? "border-brand bg-brand-surface" : "border-input bg-control"}`}
    >
      <PanelRightIcon aria-hidden="true" className="size-4" />
      Side panel
      {closedWithNewView ? (
        <>
          <span aria-hidden="true" className="rounded-full bg-brand px-2 text-xs font-semibold text-on-brand">New</span>
          <span className="sr-only">(new view)</span>
        </>
      ) : hasView && !open ? (
        <>
          <span aria-hidden="true" className="size-2 rounded-full bg-brand" />
          <span className="sr-only">(has a view)</span>
        </>
      ) : null}
    </button>
  );
}

/** What tells the user about a view that arrived while the panel was closed:
 *  a status region for screen readers that always stays mounted, and a visible
 *  notice with the action. */
export function SidePanelNotice({ panelId, announcement, visible, onShow }: {
  panelId: string;
  announcement: string;
  visible: boolean;
  onShow: () => void;
}) {
  return (
    <>
      <p aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>
      {visible ? (
        <div className="flex items-center gap-3 border-b border-brand-border bg-brand-surface px-4 py-2 text-sm text-on-surface">
          <PanelRightIcon aria-hidden="true" className="size-4 shrink-0 text-brand-strong" />
          <p className="min-w-0 flex-1">{NEW_VIEW_NOTICE}</p>
          <button
            type="button"
            aria-controls={panelId}
            onClick={onShow}
            className="shrink-0 rounded-md bg-primary px-3 py-1 text-sm font-medium text-on-primary hover:bg-primary/90"
          >
            View side panel
          </button>
        </div>
      ) : null}
    </>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col gap-1 px-1 py-6 text-center text-sm text-on-surface-variant">
      <p className="font-medium text-on-surface">Nothing here yet</p>
      <p>When the agent shows a view in the side panel, it appears here. Ask for one in the chat.</p>
    </div>
  );
}

/** The name of the shown view, the reply that holds it, and the way to another
 *  view. One view needs no picker. While the user looks at an earlier view, a
 *  note says so and gives the way back; nothing moves focus or the selection
 *  when a newer view arrives. */
function ViewBar({ state, replyNumbers, onSelect, onShowLatest }: {
  state: SidePanelState;
  /** The loaded history starts at the first message, so reply numbers are true. */
  replyNumbers: boolean;
  onSelect: (surfaceId: string) => void;
  onShowLatest: () => void;
}) {
  const pickerId = useId();
  const pickerRef = useRef<HTMLSelectElement | null>(null);
  const { views, selected, browsing } = state;
  if (!selected) return null;
  const labels = viewLabels(views, replyNumbers);
  const newer = views.length - 1 - views.findIndex((view) => view.surfaceId === selected.surfaceId);
  return (
    <div className="mb-3 flex flex-col gap-2 border-b border-outline-variant pb-3">
      <div className="min-w-0">
        <h3 className="m-0 text-sm font-semibold text-on-surface [overflow-wrap:anywhere]">{selected.title}</h3>
        {replyNumbers ? <p className="m-0 text-xs text-on-surface-variant">From reply {selected.reply}</p> : null}
      </div>
      {views.length > 1 ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={pickerId} className="text-xs font-medium text-on-surface-variant">Switch view</label>
          <select
            id={pickerId}
            ref={pickerRef}
            value={selected.surfaceId}
            onChange={(event) => onSelect(event.target.value)}
            className="min-h-11 w-full min-w-0 truncate rounded-md border border-input bg-surface-container-lowest px-2 text-on-surface outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-9"
          >
            {[...views].reverse().map((view) => (
              <option key={view.surfaceId} value={view.surfaceId}>{labels.get(view.surfaceId)}</option>
            ))}
          </select>
        </div>
      ) : null}
      {browsing ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-brand-border bg-brand-surface px-3 py-2 text-sm text-on-surface">
          <p role="status" className="m-0 min-w-0 flex-1">
            You are looking at an earlier view. {newer} newer {newer === 1 ? "view is" : "views are"} available.
          </p>
          <button
            type="button"
            onClick={() => {
              onShowLatest();
              // The note and this button leave, so focus goes to the picker.
              pickerRef.current?.focus();
            }}
            className="min-h-11 shrink-0 rounded-md bg-primary px-3 py-1 text-sm font-medium text-on-primary hover:bg-primary/90 md:min-h-9"
          >
            Show latest view
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function GenerativeUiSidePanel({
  panelId, open, narrow, state, replyNumbers, focusRequest, toggleRef, onClose, onSelect, onShowLatest
}: {
  panelId: string;
  open: boolean;
  narrow: boolean;
  state: SidePanelState;
  /** The loaded history is complete, so a reply number is true. */
  replyNumbers: boolean;
  /** Shows an earlier view. */
  onSelect: (surfaceId: string) => void;
  /** Goes back to the latest view. */
  onShowLatest: () => void;
  /** Counts the opens that the user asked for. */
  focusRequest: number;
  /** Gets the focus back when the user closes the panel. */
  toggleRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const manager = useGenerativeUIRuntime()?.manager;
  // Keep the target in the guide even when a mismatch prevents rendering.
  useLayoutEffect(() => manager?.registerTarget(GENERATIVE_UI_PANEL_TARGET, {
    description: SIDE_PANEL_DESCRIPTION
  }), [manager]);
  const asideRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const modal = open && narrow;

  // An open that the user asked for puts the focus on Close, so a keyboard
  // user lands in the panel. An automatic open never moves the focus.
  const handledRequest = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === handledRequest.current) return;
    handledRequest.current = focusRequest;
    closeRef.current?.focus();
  }, [focusRequest]);

  // A close puts the focus back on the toggle, unless the user has moved it
  // somewhere else, such as the message box.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (!open && wasOpen.current) {
      const active = document.activeElement;
      if (active === null || active === document.body || asideRef.current?.contains(active)) toggleRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, toggleRef]);

  // A modal panel leaves nothing behind it reachable by Tab, click or screen
  // reader. The panel stays mounted when it closes, so the page is inert
  // only while the modal is open.
  useEffect(() => {
    if (!modal) return;
    const undo = makeBackgroundInert([asideRef.current, backdropRef.current]);
    if (!asideRef.current?.contains(document.activeElement)) closeRef.current?.focus();
    return undo;
  }, [modal]);

  // A Modal of generated UI draws in a portal and closes itself on Escape.
  // Its keys bubble here through the React tree, but their target is outside
  // the panel, so they are not the panel's.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!modal || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    if (event.key === "Escape") {
      // Prevented, so the host's Stop shortcut leaves this key alone.
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      keepTabInside(event, event.currentTarget);
    }
  };

  return (
    <>
      {/* On a narrow host the panel covers the chat, as the artifacts panel
          does. A tap outside it closes it. */}
      {modal ? (
        <button
          ref={backdropRef}
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          className={WORKSPACE_DRAWER_BACKDROP}
          onClick={onClose}
        />
      ) : null}
      <aside
        ref={asideRef}
        id={panelId}
        role={modal ? "dialog" : undefined}
        aria-modal={modal ? true : undefined}
        data-state={modal ? "open" : undefined}
        aria-labelledby={`${panelId}-title`}
        tabIndex={modal ? -1 : undefined}
        // The closed panel stays laid out so that open and close animate, as
        // the shell's panels do. inert and visibility remove it from the tab
        // order and the accessibility tree. The visibility change waits for
        // the end of the close transition.
        inert={!open}
        onKeyDown={onKeyDown}
        className={`flex min-w-0 flex-col overflow-hidden ${narrow ? WORKSPACE_DRAWER_SURFACE : "bg-surface-container-low"} outline-none duration-200 ease-[var(--ease-standard)] motion-reduce:transition-none ${open ? "visible" : "invisible"} ${narrow
          ? `fixed inset-y-0 right-0 z-[var(--z-modal)] w-[min(92vw,420px)] shadow-lg transition-[transform,visibility] ${open ? "translate-x-0" : "translate-x-full"}`
          : `shrink-0 border-outline-variant transition-[width,border-width,visibility] ${open ? "w-[min(45%,420px)] border-l" : "w-0 border-l-0"}`}`}
      >
        <WorkspaceDrawerHeader title="Side panel" titleId={`${panelId}-title`} closeLabel="Close side panel"
          closeRef={closeRef} onClose={onClose} modal={narrow} />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-busy={state.streaming}>
          <ViewBar state={state} replyNumbers={replyNumbers} onSelect={onSelect} onShowLatest={onShowLatest} />
          <div className="chat-markdown">
            {state.streaming ? (
              <p role="status" className="mb-2 text-xs text-on-surface-variant">The agent is writing this view.</p>
            ) : null}
            {state.incomplete && !state.streaming ? (
              <p role="status" className="mb-2 text-xs text-danger">Some parts of this view could not be shown.</p>
            ) : null}
            {state.failed ? (
              <p role="status" className="px-1 py-6 text-center text-sm text-danger">
                {state.browsing ? "This view could not be shown." : "The newest view could not be shown. Ask the agent to try again."}
              </p>
            ) : null}
            {state.selected && !state.failed && !state.renderable ? (
              <p role="status" className="px-1 py-6 text-center text-sm text-on-surface-variant">
                This view is unavailable. Ask the agent to create it again.
              </p>
            ) : null}
            {!state.selected ? <EmptyState /> : null}
            {/* Render only the view named by the header. A markdown fence can
                add another surface to this target without a panel activity. */}
            {state.renderable && !state.failed ? <div key={state.selected?.surfaceId}>
              <GenerativeUISurface
                id={GENERATIVE_UI_PANEL_TARGET}
                ui={COGNIPLANE_GENERATIVE_UI}
                description={SIDE_PANEL_DESCRIPTION}
                fallback={<EmptyState />}
                autoScroll={false}
              />
            </div> : null}
          </div>
        </div>
      </aside>
    </>
  );
}
