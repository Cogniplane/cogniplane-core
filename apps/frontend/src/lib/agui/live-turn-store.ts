"use client";
// The live turn state of the chat that this tab shows. The chat connection
// owns it: the chat host writes one record for its session, and removes the
// record when it unmounts. The shell reads the record of the selected session
// for the header and the sidebar. It keeps no copy, so a record never
// describes a session other than the one that wrote it.

import { useCallback, useSyncExternalStore } from "react";

import type { LiveTurnActivity } from "../../components/session-status.logic";

export type LiveTurn = {
  /** A turn runs: this tab streams it, or it runs on the server without a
   *  stream in this tab. */
  running: boolean;
  activity: LiveTurnActivity | null;
  /** The pending approvals that the chat shows. Null until the chat has its
   *  first approval state: the saved count applies until then. */
  pendingApprovals: number | null;
  /** A turn ended, and the refresh of the saved state did not end yet. */
  settling: boolean;
};

function sameTurn(a: LiveTurn, b: LiveTurn): boolean {
  return a.running === b.running && a.activity === b.activity &&
    a.pendingApprovals === b.pendingApprovals && a.settling === b.settling;
}

export class LiveTurnStore {
  private record: { sessionId: string; turn: LiveTurn } | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The record of this session, or null when no mounted chat wrote one. */
  read(sessionId: string | null): LiveTurn | null {
    return sessionId !== null && this.record?.sessionId === sessionId ? this.record.turn : null;
  }

  publish(sessionId: string, turn: LiveTurn): void {
    if (this.record?.sessionId === sessionId && sameTurn(this.record.turn, turn)) return;
    this.record = { sessionId, turn };
    this.notify();
  }

  /** Removes the record of this session. The record of another session stays:
   *  the chat of the next session can write before the old chat unmounts. */
  clear(sessionId: string): void {
    if (this.record?.sessionId !== sessionId) return;
    this.record = null;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function useLiveTurn(store: LiveTurnStore, sessionId: string | null): LiveTurn | null {
  const read = useCallback(() => store.read(sessionId), [store, sessionId]);
  return useSyncExternalStore(store.subscribe, read, () => null);
}
