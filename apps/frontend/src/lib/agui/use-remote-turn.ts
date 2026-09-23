"use client";
// Remote-running mode. The chat's turn runs on the server, but this tab does
// not stream it. This happens when another tab started the turn, when the user
// comes back to a chat, when the backend refuses a send as busy, or when this
// tab's stream drops. The host
// polls the saved state until the server reports the turn done. While a
// reconnect stream shows the turn live, polling waits. When that stream ends,
// one poll confirms the end of the turn.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Approval, Message } from "@cogniplane/shared-types";

import { listMessages } from "../message-api";
import { listApprovals, listSessions } from "../session-api";

export const REMOTE_TURN_POLL_MS = 3_000;

export type RemoteTurnSnapshot = { messages: Message[]; approvals: Approval[] };

export function useRemoteTurn(input: {
  sessionId: string;
  /** Saved running state from the session list. */
  serverRunning: boolean;
  /** True while this tab streams its own turn. */
  localRunning: boolean;
  /** True while a live stream shows the turn, or is about to. Polling waits. */
  liveStream?: boolean;
  onSnapshot: (snapshot: RemoteTurnSnapshot) => void;
  onSettled?: () => void;
}): { isRemoteRunning: boolean; enterRemoteRunning: () => void; refreshRemoteTurn: () => void } {
  const { sessionId, serverRunning, localRunning, liveStream = false } = input;
  const [isRemoteRunning, setIsRemoteRunning] = useState(serverRunning && !localRunning);
  // Enter on mount and when the saved state changes to running. Do not enter
  // on a steady `true`. After this tab's own turn ends, the list can still show
  // the turn as running until its next reload.
  const [previousServerRunning, setPreviousServerRunning] = useState(serverRunning);
  // When the saved state changes to done, poll at once instead of at the next
  // interval, so the chat does not show a finished turn as running.
  const [pollRequest, setPollRequest] = useState(0);
  if (serverRunning !== previousServerRunning) {
    setPreviousServerRunning(serverRunning);
    if (serverRunning && !localRunning) setIsRemoteRunning(true);
    if (!serverRunning && isRemoteRunning) setPollRequest((count) => count + 1);
  }

  const onSnapshotRef = useRef(input.onSnapshot);
  const onSettledRef = useRef(input.onSettled);
  useEffect(() => {
    onSnapshotRef.current = input.onSnapshot;
    onSettledRef.current = input.onSettled;
  });

  useEffect(() => {
    if (!isRemoteRunning || liveStream) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        // Read the running state first. If the turn is done, the messages read
        // after it hold the final row.
        const { sessions } = await listSessions({ ids: [sessionId], signal: controller.signal });
        const running = sessions.some((session) => session.sessionId === sessionId && session.isRunning === true);
        const [page, approvals] = await Promise.all([
          listMessages(sessionId, controller.signal),
          listApprovals(sessionId, controller.signal)
        ]);
        if (controller.signal.aborted) return;
        onSnapshotRef.current({ messages: page.messages, approvals });
        if (!running) {
          setIsRemoteRunning(false);
          onSettledRef.current?.();
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
        // A failed poll keeps the mode. The next poll tries again.
      }
      timer = setTimeout(() => void poll(), REMOTE_TURN_POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [isRemoteRunning, liveStream, pollRequest, sessionId]);

  // Poll at once, also when the mode is already on, so the chat shows the
  // saved state as soon as this tab loses its stream.
  const enterRemoteRunning = useCallback(() => {
    setIsRemoteRunning(true);
    setPollRequest((count) => count + 1);
  }, []);
  // Poll at once only when the mode is on. A poll that reports no running
  // turn ends the mode. A poll that reports a running turn keeps it.
  const refreshRemoteTurn = useCallback(() => setPollRequest((count) => count + 1), []);
  return { isRemoteRunning, enterRemoteRunning, refreshRemoteTurn };
}
