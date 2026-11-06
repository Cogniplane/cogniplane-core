"use client";
// Keeps what a user typed into generated UI through a reload of the tab.
//
// The values come from the SDK surface manager, which owns them: a setter on a
// bound prop writes the value and marks its path user-owned, and
// `describeSurfaces` lists those paths. A value that nobody edited is not user-
// owned, so it is never saved. The DOM only tells this code when to look. It
// is never read for a value.
//
// A reload gives the surfaces back from the saved operations, and the values
// reset. The manager has no event for a user edit, so edits are read on a
// short delay after an input event inside generated UI, and again when the page
// hides, so the last edit before a reload is not lost.
//
// A saved draft is a pending entry until its surface is in the manager. Only
// then is it checked and applied, and the entry leaves the pending set:
//   - the surface was deleted, withdrawn or never rendered: dropped
//   - the target or the first operations differ from the saved ones: dropped
//   - the surface still streams: kept, until its content is final
//   - otherwise each value goes back through `setOwnedValue`; one that no
//     longer fits its path is skipped, and a path that the user has edited
//     since the load keeps the new value
// Chat surfaces enter the manager only when CopilotChat mounts their row, so a
// long thread can hold a pending entry until the user scrolls to it. Panel
// surfaces enter at once. An entry whose surface has no activity message in
// the loaded history is dropped, as the history is the proof that it exists.
// Each write is the live values plus the entries that are still pending, so a
// flush before the history arrives never erases a draft.
//
// Nothing here creates, changes or recreates a surface. A draft for a surface
// that the history no longer holds has nothing to apply to.

import type { AbstractAgent, Message } from "@ag-ui/client";
import { GENERATIVE_UI_PANEL_TARGET } from "@cogniplane/shared-types";
import { useGenerativeUIRuntime } from "@copilotkit/react-core/v2/generative-ui";
import { GENERATIVE_UI_ACTIVITY_TYPE, type GenerativeUISurfaceContent } from "@copilotkit/shared";
import { useEffect, useRef, useState } from "react";

import { canonicalTarget } from "../lib/agui/generative-ui-targets";
import {
  cleanValues,
  currentClearEpoch,
  digestOperations,
  getDraftStorage,
  loadSessionDrafts,
  saveSessionDrafts,
  type DraftPersistence,
  type DraftScope,
  type SurfaceDraft
} from "./generative-ui-drafts.logic";

type Manager = NonNullable<ReturnType<typeof useGenerativeUIRuntime>>["manager"];

/** Milliseconds between an input event and the write of what it changed. */
const WRITE_DELAY_MS = 300;

export type DraftSync = {
  /** Applies the pending drafts that can be applied, then schedules a write. */
  update(): void;
  /** Writes now. */
  flush(): void;
  /** Cancels the timer. It writes nothing more. */
  dispose(): void;
};

type DraftSyncOptions = {
  manager: Manager;
  threadId: string;
  scope: DraftScope;
  storage: Storage | null;
  /** The activity messages that the loaded history holds, by surface id. */
  messages: () => readonly Message[];
  /** The latest connection delivered the saved history. */
  historyReady: () => boolean;
  onPersistence: (state: DraftPersistence) => void;
  /** Values went back into a surface. The manager has no event for it. */
  onRestored?: () => void;
};

function surfaceContent(message: Message): GenerativeUISurfaceContent | undefined {
  if (message.role !== "activity" || message.activityType !== GENERATIVE_UI_ACTIVITY_TYPE) return undefined;
  const content = message.content as Partial<GenerativeUISurfaceContent> | undefined;
  return typeof content?.surfaceId === "string" && Array.isArray(content.operations) && content.operations.length > 0
    ? content as GenerativeUISurfaceContent : undefined;
}

export function createDraftSync(options: DraftSyncOptions): DraftSync {
  const { manager, threadId, scope, storage, onPersistence } = options;
  const epoch = currentClearEpoch();
  const pending = new Map<string, SurfaceDraft>(Object.entries(loadSessionDrafts(storage, scope, threadId)));
  let lastWritten: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  // A sign-out or a change of person clears the drafts while this loop lives.
  const live = () => !ended && epoch === currentClearEpoch();

  const hasActivity = (surfaceId: string) =>
    options.messages().some((message) => surfaceContent(message)?.surfaceId === surfaceId);

  function resolvePending(): void {
    if (pending.size === 0) return;
    const described = manager.describeSurfaces(threadId);
    let restored = false;
    const historyHasMessages = options.messages().length > 0;
    for (const [surfaceId, draft] of [...pending]) {
      const surface = manager.getSurface(threadId, surfaceId);
      if (!surface) {
        // The manager knows the id and holds no live surface: it was deleted
        // or the browser refused it. Otherwise it is not in the manager yet.
        const gone = Object.hasOwn(described, surfaceId)
          || (options.historyReady() && historyHasMessages && !hasActivity(surfaceId));
        if (gone) pending.delete(surfaceId);
        continue;
      }
      if (surface.status === "streaming") continue;
      const operations = surface.operations ?? [];
      const sameView = canonicalTarget(surface.target) === draft.target && operations.length >= draft.count
        && digestOperations(operations, draft.count) === draft.digest;
      pending.delete(surfaceId);
      if (!sameView) continue;
      const edited = described[surfaceId]?.dataModel ?? {};
      for (const [path, value] of Object.entries(draft.values)) {
        if (Object.hasOwn(edited, path)) continue;
        try {
          manager.setOwnedValue(surface.key, path, value);
          restored = true;
        } catch {
          // The path no longer fits the data of the surface. Leave it out.
        }
      }
    }
    if (restored) options.onRestored?.();
  }

  /** The user-owned values of the surfaces that the manager holds now. */
  function liveDrafts(): { drafts: Record<string, SurfaceDraft>; dropped: boolean } {
    const drafts: Record<string, SurfaceDraft> = {};
    let dropped = false;
    for (const [surfaceId, info] of Object.entries(manager.describeSurfaces(threadId))) {
      // A panel view that the panel does not show now keeps its panel target.
      const target = canonicalTarget(info.target);
      if (info.status || !info.dataModel || (target !== "chat" && target !== GENERATIVE_UI_PANEL_TARGET)) continue;
      const surface = manager.getSurface(threadId, surfaceId);
      const operations = surface?.operations ?? [];
      if (!surface || operations.length === 0 || !hasActivity(surfaceId)) continue;
      const cleaned = cleanValues(info.dataModel);
      dropped ||= cleaned.dropped;
      if (Object.keys(cleaned.values).length === 0) continue;
      drafts[surfaceId] = {
        target,
        count: operations.length,
        digest: digestOperations(operations, operations.length),
        values: cleaned.values
      };
    }
    return { drafts, dropped };
  }

  function write(): void {
    if (!live()) return;
    const { drafts, dropped } = liveDrafts();
    const all = { ...Object.fromEntries(pending), ...drafts };
    const key = JSON.stringify(all);
    if (key === lastWritten && !dropped) return;
    lastWritten = key;
    const state = saveSessionDrafts(storage, scope, threadId, all, Date.now());
    onPersistence(state === "ok" && dropped ? "full" : state);
  }

  return {
    update() {
      if (!live()) return;
      resolvePending();
      clearTimeout(timer);
      timer = setTimeout(write, WRITE_DELAY_MS);
    },
    flush() {
      if (!live()) return;
      clearTimeout(timer);
      resolvePending();
      write();
    },
    dispose() {
      ended = true;
      clearTimeout(timer);
    }
  };
}

// SDK controls can write from button clicks or arrow keys without emitting
// input or change. Capture these interactions and read after their handlers.
export const GENERATED_UI_EDIT_EVENTS = ["input", "change", "click", "keydown"] as const;

/** Whether an interaction came from generated UI, a modal of it included. */
export function fromGeneratedUi(event: Event): boolean {
  return event.target instanceof Element && event.target.closest(".a2ui-surface, [data-generative-ui-root]") !== null;
}

/**
 * Restores and saves the drafts of one session. Without a scope (nobody is
 * signed in, or the host has no identity) it keeps nothing. The returned state
 * says whether the tab could keep the edits.
 */
export function useGenerativeUiDrafts(
  agent: AbstractAgent,
  scope: DraftScope | undefined,
  historyReady: boolean
): { persistence: DraftPersistence; restored: number } {
  const manager = useGenerativeUIRuntime()?.manager;
  const threadId = agent.threadId;
  const userId = scope?.userId;
  const tenantId = scope?.tenantId;
  const [persistence, setPersistence] = useState<DraftPersistence>("ok");
  // Counts the restores, so the list of values that the next message sends reads again.
  const [restored, setRestored] = useState(0);
  const syncRef = useRef<DraftSync | null>(null);
  const historyReadyRef = useRef(historyReady);

  useEffect(() => {
    if (!manager || !threadId || !userId || !tenantId) return;
    const sync = createDraftSync({
      manager,
      threadId,
      scope: { userId, tenantId },
      storage: getDraftStorage(),
      messages: () => agent.messages,
      historyReady: () => historyReadyRef.current,
      onPersistence: setPersistence,
      onRestored: () => setRestored((count) => count + 1)
    });
    syncRef.current = sync;
    const unsubscribeManager = manager.subscribe(sync.update);
    const subscription = agent.subscribe({ onMessagesChanged: sync.update });
    const onEdit = (event: Event) => { if (fromGeneratedUi(event)) sync.update(); };
    const onHide = () => { if (document.visibilityState !== "visible") sync.flush(); };
    for (const name of GENERATED_UI_EDIT_EVENTS) document.addEventListener(name, onEdit, true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", sync.flush);
    sync.update();
    return () => {
      for (const name of GENERATED_UI_EDIT_EVENTS) document.removeEventListener(name, onEdit, true);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", sync.flush);
      subscription.unsubscribe();
      unsubscribeManager();
      // The host is leaving: a session switch or an unmount. A sign-out has
      // ended the sync already, and a flush after it writes nothing.
      sync.flush();
      sync.dispose();
      syncRef.current = null;
    };
  }, [agent, manager, threadId, userId, tenantId]);

  useEffect(() => {
    historyReadyRef.current = historyReady;
    syncRef.current?.update();
  }, [historyReady]);

  return { persistence, restored };
}
