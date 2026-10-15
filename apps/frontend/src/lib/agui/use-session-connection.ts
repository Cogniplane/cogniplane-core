"use client";
// The lifecycle of a chat session in this tab, in one owner.
//
// CopilotChat owns the transcript. It loads the session through CopilotKit's
// connection path (`GET /sessions/:id/connect`), and the host connects again
// through the same path. This hook follows the runs of the agent and decides:
//   • whether the latest saved history is shown, so that a send can start;
//   • where the current turn is visible: in this tab's stream, or only on the
//     server (then it polls the saved state until the turn ends);
//   • when to connect again, with a bounded backoff;
//   • when a turn ended, so that the caller refreshes the saved data once.
//
// A pure reducer holds the state. The subscriber keeps one small record of the
// current run and turns its callbacks into reducer events. Approvals, notices,
// MCP and tool status stay in useAguiCustomEvents.

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  randomUUID,
  type AgentStateMutation,
  type Message,
  type RunAgentInput
} from "@ag-ui/client";
import { CogniplaneCustomEventSchema, type CustomEventValue } from "@cogniplane/shared-types";

import type { RuntimeNoticeRow } from "../../components/chat-cards/chat-cards.types";
import type { LiveTurnActivity } from "../../components/session-status.logic";
import { runtimeNoticeRow } from "../../components/agui-transcript";
import { httpFailure, isReconnectRun, isSessionBusyError, type DeepAgentsBrowserAgent } from "./deep-agents-browser-agent";
import { REMOTE_TURN_POLL_MS, useRemoteTurnPoll, type RemoteTurnSnapshot } from "./use-remote-turn";

export type ActiveTurn = CustomEventValue<"session_connection">["activeTurn"];

/** The HTTP status and the server's message of a refused connection. */
export type ConnectionRefusal = { status: number | null; message: string | null };

/** A planned connection. Its identity tells one plan from a newer one. */
export type ConnectionPlan = { failures: number };

export type ConnectionState = {
  /** Whether the transcript shows the latest saved history. A refused
   *  connection is final: connecting again does not help. */
  view: "loading" | "ready" | "refused";
  /** Where this tab sees the current turn: in its own stream, or only on the
   *  server. */
  turn: "none" | "streaming" | "remote";
  /** A planned connection has not started its run. */
  pending: boolean;
  /** Each new object asks for one connection. `failures` sets its backoff. */
  nextConnection: ConnectionPlan | null;
  /** Connections that failed in a row. */
  failures: number;
  /** Each change polls the server at once while the turn is remote. */
  poll: number;
  /** Each change asks the caller to refresh the saved session data. */
  settles: number;
  /** The last send was refused because another turn runs. */
  busyRefused: boolean;
  /** The history left out older messages. */
  truncated: boolean;
  /** Why the server refused the connection. */
  refusal: ConnectionRefusal | null;
  activity: LiveTurnActivity | null;
  /** The running state of the session list. */
  serverRunning: boolean;
};

export type ConnectionEvent =
  | { type: "connect_started" }
  | { type: "connect_skipped"; plan: ConnectionPlan }
  | { type: "history"; activeTurn: ActiveTurn; hasMoreHistory: boolean }
  | { type: "connection_lost" }
  | { type: "connection_refused"; refusal: ConnectionRefusal }
  | { type: "send_started"; at: string }
  | { type: "send_refused"; busy: boolean }
  | { type: "turn_identified"; turnId: string; sequence: number }
  | { type: "turn_ended"; failed: boolean }
  | { type: "stream_lost" }
  | { type: "stream_closed" }
  | { type: "remote_ended" }
  | { type: "poll" }
  | { type: "server_running"; running: boolean }
  | { type: "busy_refusal_cleared" };

export function initialConnectionState(serverRunning: boolean): ConnectionState {
  return {
    view: "loading",
    turn: "none",
    pending: false,
    nextConnection: null,
    failures: 0,
    poll: 0,
    settles: 0,
    busyRefused: false,
    truncated: false,
    refusal: null,
    activity: null,
    serverRunning
  };
}

function planConnection(state: ConnectionState): ConnectionState {
  return { ...state, pending: true, nextConnection: { failures: state.failures } };
}

// The turn is no longer visible in this tab. The caller refreshes once.
function endTurn(state: ConnectionState): ConnectionState {
  if (state.turn === "none") return state;
  return { ...state, turn: "none", busyRefused: false, settles: state.settles + 1 };
}

function pollRemote(state: ConnectionState): ConnectionState {
  return { ...state, turn: "remote", poll: state.poll + 1 };
}

export function connectionReducer(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  // A refused connection is final. Late events of earlier runs and polls change
  // nothing, and nothing plans a connection or a poll. The hook dispatches the
  // running state of the session list during render until the state agrees,
  // so that fact still follows the list.
  if (state.view === "refused") {
    return event.type === "server_running" && event.running !== state.serverRunning
      ? { ...state, serverRunning: event.running }
      : state;
  }
  switch (event.type) {
    case "connect_started":
      // The transcript shows the state before this connection until its
      // history arrives.
      return { ...state, pending: false, view: "loading" };
    case "connect_skipped":
      // A plan ended without a run. Only the current plan is released: a
      // newer plan still waits for its own connection.
      return state.pending && event.plan === state.nextConnection ? { ...state, pending: false } : state;
    case "history": {
      const next = { ...state, view: "ready" as const, truncated: event.hasMoreHistory, failures: 0 };
      if (event.activeTurn === "attached") return { ...next, turn: "streaming" };
      if (event.activeTurn === "unavailable") return pollRemote(next);
      // No turn runs: this history already holds the final state.
      return endTurn(next);
    }
    case "connection_lost":
      return planConnection({ ...state, failures: state.failures + 1 });
    case "connection_refused":
      // This tab no longer follows the turn, so the poll stops. The end of the
      // turn is not known: no refresh, and the approvals stay.
      return {
        ...state,
        view: "refused",
        refusal: event.refusal,
        pending: false,
        nextConnection: null,
        turn: "none",
        busyRefused: false,
        activity: null
      };
    case "send_started":
      return {
        ...state,
        turn: "streaming",
        busyRefused: false,
        activity: { startedAt: event.at, isRunning: true, failed: false }
      };
    case "send_refused":
      // No turn started. A busy session runs another turn: show it.
      return event.busy
        ? planConnection(pollRemote({ ...state, busyRefused: true, activity: null }))
        : { ...state, turn: "none", activity: null };
    case "turn_identified":
      return state.activity
        ? { ...state, activity: { ...state.activity, turnId: event.turnId, turnSequence: event.sequence } }
        : state;
    case "turn_ended":
      return endTurn({
        ...state,
        activity: state.activity ? { ...state.activity, isRunning: false, failed: event.failed } : null
      });
    case "stream_lost":
      // The turn can still run on the server. Poll its end, and show it live
      // again through a new connection.
      return planConnection(pollRemote({ ...state, activity: null }));
    case "stream_closed":
      // This tab closed its stream after Stop. Poll until the turn ends.
      return state.turn === "none" ? state : pollRemote({ ...state, activity: null });
    case "remote_ended":
      // Load the final state of the turn through a connection.
      return state.turn === "remote" ? planConnection(endTurn(state)) : state;
    case "poll":
      return { ...state, poll: state.poll + 1 };
    case "server_running":
      if (event.running === state.serverRunning) return state;
      // Another tab started a turn: connect again to show it. When the
      // saved state reports the end, poll at once.
      return event.running
        ? planConnection({ ...state, serverRunning: true })
        : { ...state, serverRunning: false, poll: state.poll + 1 };
    case "busy_refusal_cleared":
      return { ...state, busyRefused: false };
  }
}

// Connections that this hook starts wait at least this long after the
// previous one. Each failed connection doubles the wait, up to the maximum,
// so a network outage cannot make a tight loop.
const RECONNECT_INTERVAL_MS = REMOTE_TURN_POLL_MS;
const RECONNECT_MAX_INTERVAL_MS = 30_000;

export function reconnectDelay(failures: number, lastConnectAt: number, now: number): number {
  const interval = Math.min(RECONNECT_MAX_INTERVAL_MS, RECONNECT_INTERVAL_MS * 2 ** Math.max(0, failures - 1));
  return Math.max(0, lastConnectAt + interval - now);
}

// @ag-ui/client ignores these abort shapes (this tab's Stop or unmount) after
// it calls onRunFailed. The same list is in its AbstractAgent.onError.
// Some runtimes do not make DOMException an Error subclass, so read the fields
// from any object.
export function isAbortError(error: unknown): boolean {
  if (String(error) === "component unmounted") return true;
  if (typeof error !== "object" || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === "AbortError" ||
    message === "Fetch is aborted" ||
    message === "signal is aborted without reason" ||
    message === "component unmounted";
}

/** True when the stream broke after the request left this tab, for example a
 *  network drop or a stream that did not parse. The backend turn can continue.
 *  A refused request did not start a turn. An abort comes from this tab. */
export function isStreamLossError(error: unknown): boolean {
  return !isAbortError(error) && httpFailure(error) === null;
}

// Notices for a refused send use this prefix. A new send removes them.
export const SEND_REFUSED_NOTICE_PREFIX = "send-refused:";

/** A notice when the backend refused a send before its stream opened, or null
 *  when the error is not such a refusal. The message route saves the user
 *  message only after all of its refusal checks, so a 4xx response, or 503
 *  `server_draining`, means that the message was not sent. Other 5xx responses
 *  can come after the save, so they stay turn failures. Check session_busy
 *  first, because it has its own flow. */
export function refusedSendNotice(error: unknown): RuntimeNoticeRow | null {
  const failure = httpFailure(error);
  if (!failure) return null;
  const { status, body } = failure;
  const draining = status === 503 && body.error === "server_draining";
  if (!draining && (status < 400 || status > 499)) return null;
  const message = body.error === "running_turn_limit"
    ? "Too many agents are running for you or your organization. Wait for an agent to finish, or stop one. Then send your message again."
    : draining
      ? "The server does not accept new messages at this time. Send your message again in a few minutes."
      : typeof body.message === "string" && body.message.trim()
        ? body.message
        : `The server did not accept the message (HTTP ${status}).`;
  return runtimeNoticeRow({
    noticeId: `${SEND_REFUSED_NOTICE_PREFIX}${randomUUID()}`,
    level: "error",
    title: "Your message was not sent",
    message,
    createdAt: new Date().toISOString()
  });
}

/** The refusal when the server refused a connection for good: no access, no
 *  session, or a history format that this version cannot read. A 429 or 5xx
 *  response can pass, so it gives null and the hook connects again. */
function connectionRefusal(error: unknown): ConnectionRefusal | null {
  const failure = httpFailure(error);
  if (!failure || failure.status === 429 || failure.status >= 500) return null;
  const { message } = failure.body;
  return { status: failure.status, message: typeof message === "string" && message.trim() ? message : null };
}

// Ends a connection failure in this subscriber. Later subscribers do not see
// it, and the run does not throw. Otherwise CopilotKit marks the connection
// of CopilotChat as failed, and CopilotChat refuses each send until it mounts
// again. @ag-ui/client 1.0.2 reads stopPropagation from an onRunFailed result,
// although its type leaves the field out.
const HANDLED_CONNECTION_FAILURE: AgentStateMutation = { stopPropagation: true };

// The run buffer without the user message that this run tried to send. The
// backend did not save it. A new array is necessary for the buffer merge.
function withoutSentUserMessage(
  messages: readonly Readonly<Message>[],
  input: Readonly<RunAgentInput>
): Omit<AgentStateMutation, "stopPropagation"> | undefined {
  const sentId = [...input.messages].reverse().find((message) => message.role === "user")?.id;
  return sentId ? { messages: messages.filter((message) => message.id !== sentId) } : undefined;
}

/** What the subscriber knows about the current run. */
type RunRecord = {
  id: string;
  /** A session connection (connectAgent), not a sent message. */
  connect: boolean;
  /** The connection's history arrived, with its report of the turn. */
  historyDone: boolean;
  activeTurn: ActiveTurn;
  hasMoreHistory: boolean;
  /** RUN_FINISHED or RUN_ERROR of the turn: the backend ended it. */
  terminal: boolean;
  failed: boolean;
  /** This tab aborted the run. */
  aborted: boolean;
  /** onRunFailed and onRunFinalized both end a failed run. Only the first counts. */
  ended: boolean;
};

/** The connection follows the turn that runs on the server. */
const attached = (record: RunRecord) => record.connect && record.historyDone && record.activeTurn === "attached";

export type SessionConnectionOptions = {
  sessionId: string;
  /** The running state of the session list. */
  serverRunning: boolean;
  /** Starts a session connection through CopilotKit. */
  connect: () => Promise<unknown>;
  /** Called once when a turn ended and the saved data can change. */
  onTurnSettled?: () => void;
  /** Called when the backend ended the turn that this tab streamed. */
  onTurnEnded?: () => void;
  /** Called when the backend refused a send before its stream opened. */
  onSendRefused?: (notice: RuntimeNoticeRow) => void;
  /** A poll of the saved state while the turn is remote. */
  onRemoteSnapshot: (snapshot: RemoteTurnSnapshot) => void;
};

export type SessionConnection = {
  /** The latest connection delivered its history, and no other one is planned. */
  ready: boolean;
  historyRestored: boolean;
  /** This tab streams the turn: a sent message, or an attached connection. */
  running: boolean;
  /** The turn runs on the server without a stream in this tab. */
  remoteRunning: boolean;
  /** A send, a project prompt, or an app message must wait. */
  busy: boolean;
  busyRefused: boolean;
  truncated: boolean;
  /** Set when the server refused the connection. */
  refusal: ConnectionRefusal | null;
  activity: LiveTurnActivity | null;
  /** Closes this tab's stream after Stop, then polls until the turn ends. */
  closeStream: () => void;
  /** Polls at once while the turn is remote. */
  pollNow: () => void;
  clearBusyRefusal: () => void;
};

export function useSessionConnection(agent: DeepAgentsBrowserAgent, options: SessionConnectionOptions): SessionConnection {
  const { sessionId, serverRunning } = options;
  const [state, dispatch] = useReducer(connectionReducer, serverRunning, initialConnectionState);
  if (serverRunning !== state.serverRunning) dispatch({ type: "server_running", running: serverRunning });

  const callbacks = useRef(options);
  useEffect(() => {
    callbacks.current = options;
  });

  useEffect(() => {
    let disposed = false;
    let run: RunRecord | null = null;
    // @ag-ui/client keeps the subscribers of a run from its start, so a run
    // can call this subscription after the cleanup or after a newer run
    // started. Such calls are ignored.
    const current = (input: RunAgentInput) => (!disposed && run?.id === input.runId ? run : null);

    const endRun = (
      record: RunRecord,
      input: RunAgentInput,
      failure?: { error: unknown; messages: readonly Readonly<Message>[] }
    ): AgentStateMutation | undefined => {
      if (record.ended) return undefined;
      record.ended = true;
      if (record.terminal) {
        // A clean end cannot leave a decision outstanding, so the caller
        // clears the approvals. Other ends keep them: the turn can still
        // wait on one.
        callbacks.current.onTurnEnded?.();
        dispatch({ type: "turn_ended", failed: record.failed });
        // A connection already carried the end of the turn, so a transport
        // failure after it needs nothing. A message run keeps its failure.
        return record.connect && failure ? HANDLED_CONNECTION_FAILURE : undefined;
      }
      const error = failure?.error;
      // This tab closed the stream: Stop, unmount, or a newer connection.
      // Whoever closed it decides what follows.
      if (record.aborted || isAbortError(error) || (record.connect && agent.isClosedByClient(input))) return undefined;
      if (record.connect) {
        // CopilotKit also sees a refusal, so CopilotChat keeps sends closed.
        const refusal = failure ? connectionRefusal(error) : null;
        if (refusal) {
          dispatch({ type: "connection_refused", refusal });
          return undefined;
        }
        if (attached(record)) {
          dispatch({ type: "stream_lost" });
        } else if (!record.historyDone) {
          dispatch({ type: "connection_lost" });
        }
        // This hook connects again when the session needs it.
        return failure ? HANDLED_CONNECTION_FAILURE : undefined;
      }
      if (failure) {
        if (isSessionBusyError(error)) {
          dispatch({ type: "send_refused", busy: true });
          return withoutSentUserMessage(failure.messages, input);
        }
        const notice = refusedSendNotice(error);
        if (notice) {
          callbacks.current.onSendRefused?.(notice);
          dispatch({ type: "send_refused", busy: false });
          return withoutSentUserMessage(failure.messages, input);
        }
        if (!isStreamLossError(error)) {
          dispatch({ type: "turn_ended", failed: true });
          return undefined;
        }
      }
      // The stream ended before the end of the turn. A run that CopilotKit
      // detaches and a stream that a proxy closes cleanly also end this way.
      dispatch({ type: "stream_lost" });
      return undefined;
    };

    const subscription = agent.subscribe({
      onRunInitialized({ input }) {
        if (disposed) return;
        const connect = isReconnectRun(input);
        run = {
          id: input.runId, connect, historyDone: false, activeTurn: "none", hasMoreHistory: false,
          terminal: false, failed: false, aborted: false, ended: false
        };
        dispatch(connect ? { type: "connect_started" } : { type: "send_started", at: new Date().toISOString() });
      },
      onCustomEvent({ event, input }) {
        const record = current(input);
        if (!record) return;
        const parsed = CogniplaneCustomEventSchema.safeParse(event);
        if (!parsed.success) return;
        if (parsed.data.name === "session_connection" && record.connect && !record.historyDone) {
          record.activeTurn = parsed.data.value.activeTurn;
          record.hasMoreHistory = parsed.data.value.hasMoreHistory;
        } else if (parsed.data.name === "turn_started") {
          dispatch({ type: "turn_identified", turnId: parsed.data.value.messageId, sequence: parsed.data.value.sequence });
        }
      },
      onRunFinishedEvent({ input }) {
        const record = current(input);
        if (!record) return;
        // A connection first carries the saved history as its own finished run.
        if (record.connect && !record.historyDone) {
          record.historyDone = true;
          dispatch({ type: "history", activeTurn: record.activeTurn, hasMoreHistory: record.hasMoreHistory });
          return;
        }
        if (!record.connect || attached(record)) record.terminal = true;
      },
      onRunErrorEvent({ event, input }) {
        const record = current(input);
        if (!record) return;
        // @ag-ui/client reports this tab's abort as RUN_ERROR with code "abort".
        if ((event as { code?: unknown }).code === "abort") {
          record.aborted = true;
          return;
        }
        // Before its history, a connection did not load. The end of the run
        // reports it.
        if (record.connect && !attached(record)) return;
        record.terminal = true;
        record.failed = true;
      },
      onRunFailed({ error, messages, input }) {
        const record = current(input);
        return record ? endRun(record, input, { error, messages }) : undefined;
      },
      onRunFinalized({ input }) {
        const record = current(input);
        if (record) endRun(record, input);
      }
    });
    return () => {
      disposed = true;
      subscription.unsubscribe();
    };
  }, [agent]);

  // Starts each planned connection after its backoff. A connection cannot
  // start while a run is active: CopilotKit would detach that run.
  const lastConnectAt = useRef(0);
  const { nextConnection } = state;
  useEffect(() => {
    if (!nextConnection) return;
    const timer = setTimeout(() => {
      if (agent.isRunning) {
        dispatch({ type: "connect_skipped", plan: nextConnection });
        return;
      }
      lastConnectAt.current = Date.now();
      // The connection follows the caller's controller. A Stop or an earlier
      // connection can have aborted the current one.
      agent.abortController = new AbortController();
      // When the connection ended before it started a run, for example
      // because CopilotKit did not start it, nothing is left to wait for.
      // After a run started, connect_started already released the plan.
      void callbacks.current.connect().finally(() => dispatch({ type: "connect_skipped", plan: nextConnection }));
    }, reconnectDelay(nextConnection.failures, lastConnectAt.current, Date.now()));
    return () => clearTimeout(timer);
  }, [agent, nextConnection]);

  useEffect(() => {
    if (state.settles > 0) callbacks.current.onTurnSettled?.();
  }, [state.settles]);

  const onRemoteSnapshot = useCallback((snapshot: RemoteTurnSnapshot) => callbacks.current.onRemoteSnapshot(snapshot), []);
  const onRemoteEnded = useCallback(() => dispatch({ type: "remote_ended" }), []);
  useRemoteTurnPoll({
    sessionId,
    active: state.turn === "remote",
    refresh: state.poll,
    onSnapshot: onRemoteSnapshot,
    onEnded: onRemoteEnded
  });

  const closeStream = useCallback(() => {
    agent.abortRun();
    dispatch({ type: "stream_closed" });
  }, [agent]);
  const pollNow = useCallback(() => dispatch({ type: "poll" }), []);
  const clearBusyRefusal = useCallback(() => dispatch({ type: "busy_refusal_cleared" }), []);

  const ready = state.view === "ready" && !state.pending;
  return {
    ready,
    historyRestored: state.view === "ready",
    running: state.turn === "streaming",
    remoteRunning: state.turn === "remote",
    busy: state.turn !== "none" || !ready,
    busyRefused: state.busyRefused,
    truncated: state.truncated,
    refusal: state.refusal,
    activity: state.activity,
    closeStream,
    pollNow,
    clearBusyRefusal
  };
}
