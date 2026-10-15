"use client";
// Polls a turn that runs on the server while no stream in this tab shows it:
// the session connection could not replay it, this tab's stream dropped, or
// the backend refused a send as busy. useSessionConnection decides when the
// poll is active. A poll updates only the side state (approvals, tool
// failures, notices, apps). It never changes the transcript: after the end of
// the turn, the connection loads the session again through CopilotKit.

import { useEffect } from "react";
import type { Approval, Message } from "@cogniplane/shared-types";

import { listMessages } from "../message-api";
import { listApprovals, listSessions } from "../session-api";

export const REMOTE_TURN_POLL_MS = 3_000;

export type RemoteTurnSnapshot = { messages: Message[]; approvals: Approval[] };

/** True when the session list reports a turn that runs on the session. */
export async function readServerRunning(sessionId: string, signal?: AbortSignal): Promise<boolean> {
  const { sessions } = await listSessions({ ids: [sessionId], signal });
  return sessions.some((session) => session.sessionId === sessionId && session.isRunning === true);
}

/** The callbacks must be stable: a new identity starts the poll again. */
export function useRemoteTurnPoll(input: {
  sessionId: string;
  active: boolean;
  /** A new value polls at once. */
  refresh: number;
  onSnapshot: (snapshot: RemoteTurnSnapshot) => void;
  /** The server no longer reports the turn. Polling stops until `active`
   *  or `refresh` changes. */
  onEnded: () => void;
}): void {
  const { sessionId, active, refresh, onSnapshot, onEnded } = input;

  useEffect(() => {
    if (!active) return;
    // A change of the inputs aborts the reads of this poll, so a late read
    // cannot apply after a newer one.
    const controller = new AbortController();
    let baseline: Message[] | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        // Read the running state first. If the turn is done, the messages read
        // after it hold the final row.
        const running = await readServerRunning(sessionId, controller.signal);
        const loadMessages = async () => {
          const anchor = running ? [...(baseline ?? [])].reverse().find((message) => message.role === "user") : undefined;
          if (!anchor || !baseline) return (await listMessages(sessionId, controller.signal)).messages;
          const tail = (await listMessages(sessionId, controller.signal, { since: anchor.messageId })).messages;
          if (tail[0]?.messageId !== anchor.messageId) {
            return (await listMessages(sessionId, controller.signal)).messages;
          }
          const anchorIndex = baseline.findIndex((message) => message.messageId === anchor.messageId);
          return [...baseline.slice(0, anchorIndex), ...tail];
        };
        const [page, approvals] = await Promise.all([
          loadMessages(),
          listApprovals(sessionId, controller.signal)
        ]);
        if (controller.signal.aborted) return;
        baseline = page;
        onSnapshot({ messages: page, approvals });
        if (!running) {
          onEnded();
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
        // A failed poll tries again at the next interval.
      }
      timer = setTimeout(() => void poll(), REMOTE_TURN_POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, refresh, sessionId, onSnapshot, onEnded]);
}
