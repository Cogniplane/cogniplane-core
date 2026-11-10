"use client";
// The state of the Cogniplane custom events of a chat: approvals, notices,
// MCP server status, tool failures, and MCP Apps. This hook renders nothing.
// The host renders the rows, and copilot-render-slots renders the tool card
// and the plan.
//
// CopilotChat renders standard AG-UI events (text, tool calls, reasoning) but
// NOT our CUSTOM events. Rather than route these through CopilotKit's render
// pipeline, we subscribe directly to the agent instance CopilotKit runs
// (`agent.subscribe({ onCustomEvent })`) and drive a small piece of local state.
// The approval decision is a side-channel `POST /approvals/:id/decision` — it
// does NOT flow back through the AG-UI run (the backend resumes the graph
// server-side), so CopilotKit's `useHumanInTheLoop` (which waits for a response
// delivered back through the run) is the wrong fit here.
//
// The session lifecycle (history, running state, reconnects) is in
// useSessionConnection. The emit side is `agui-events.ts`; these value shapes
// mirror it.
//
// Callers key the component by session; a new agent needs a new mount.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AbstractAgent } from "@ag-ui/client";
import { CogniplaneCustomEventSchema, type Approval, type McpAppCall } from "@cogniplane/shared-types";

import type {
  ApprovalDecision,
  ApprovalRow,
  McpServerStatusRow,
  RuntimeNoticeRow,
  ToolStatusRow
} from "../../components/chat-cards/chat-cards.types";
import {
  mcpAppsFromMessages,
  runtimeNoticeRow,
  runtimeNoticesFromMessages,
  toolStatusesFromMessages,
  turnStoppedNotice,
  turnStopReasonOfResult
} from "../../components/agui-transcript";
import { ApiError } from "../api-client";
import { listApprovals, resolveApproval } from "../session-api";
import { isReconnectRun } from "./deep-agents-browser-agent";
import type { RemoteTurnSnapshot } from "./use-remote-turn";
import { SEND_REFUSED_NOTICE_PREFIX } from "./use-session-connection";

// Approval expiry has no dedicated AG-UI event. The backend encodes it in the
// noticeId of the `runtime_notice` custom event (the native approval coordinator and
// Policy Center emit their own prefix).
const EXPIRY_NOTICE_PREFIXES = ["approval-expired:", "policy-approval-expired:"];

export function expiredApprovalIdFromNotice(noticeId: string): string | null {
  for (const prefix of EXPIRY_NOTICE_PREFIXES) {
    if (noticeId.startsWith(prefix) && noticeId.length > prefix.length) {
      return noticeId.slice(prefix.length);
    }
  }
  return null;
}

export type AguiCustomEvents = {
  dismissStatusRows: () => void;
  approvals: ApprovalRow[];
  notices: RuntimeNoticeRow[];
  mcpStatuses: McpServerStatusRow[];
  // Tool calls that failed or were declined. The tool cards read these by
  // toolCallId, and the notification list shows them.
  toolStatuses: ToolStatusRow[];
  // MCP App results by tool call id.
  mcpApps: Record<string, McpAppCall>;
  // Sends the decision. A failure shows an error notice and enables the
  // buttons again.
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
  // Replaces approvals and tool failures with a polled server snapshot while
  // the turn runs without a stream in this tab. Adds saved notices and apps
  // that are not shown.
  syncServerState: (snapshot: RemoteTurnSnapshot) => void;
  addNotice: (notice: RuntimeNoticeRow) => void;
  // The backend ended the turn cleanly, so no approval can be outstanding.
  clearApprovals: () => void;
};

export type AguiCustomEventsOptions = {
  // Failed/declined tool-status rows reconstructed from persisted history so a
  // reloaded session shows tool failures the native card can't render. Live
  // `tool_status` events append to this on top.
  initialToolStatuses?: ToolStatusRow[];
  initialApprovals?: Approval[];
  // Runtime notices saved on the assistant rows. Live `runtime_notice` events
  // with the same noticeId do not add a second row.
  initialNotices?: RuntimeNoticeRow[];
  initialMcpApps?: Record<string, McpAppCall>;
};

const EMPTY_TOOL_STATUSES: ToolStatusRow[] = [];
const EMPTY_APPROVALS: Approval[] = [];
const EMPTY_NOTICES: RuntimeNoticeRow[] = [];
const EMPTY_MCP_APPS: Record<string, McpAppCall> = {};

// A failed approval read is tried again after 2 s, 4 s, and 6 s.
const APPROVAL_READ_RETRY_MS = 2_000;
const APPROVAL_READ_ATTEMPTS = 4;

// The notice of a failed decision. Its id ends with the approval id, so a new
// failure of the same approval replaces it and a success removes it.
const DECISION_FAILED_NOTICE_PREFIX = "approval-decision-failed:";

// The decision route answers 404 when the approval is not open for the caller:
// another tab decided it, it expired, or the caller cannot decide it now. 409
// and 410 get the same treatment.
const CLOSED_APPROVAL_STATUSES: ReadonlySet<number> = new Set([404, 409, 410]);

function isClosedApprovalError(error: unknown): boolean {
  return error instanceof ApiError && CLOSED_APPROVAL_STATUSES.has(error.status);
}

// The backend sends public error text (apiError), so an ApiError message can
// show. A body with only an error code gives the code as the message, so the
// status shows instead. Any other error is a request that got no answer.
function decisionFailureText(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "The request to the server failed. Check your connection, then try again.";
  }
  const message = error.message.trim();
  if (!message || message === error.code) {
    return `The server did not confirm your decision (HTTP ${error.status}). Try again.`;
  }
  return `${/[.!?]$/.test(message) ? message : `${message}.`} Try again.`;
}

function decisionFailedNotice(noticeId: string, error: unknown): RuntimeNoticeRow {
  const closed = isClosedApprovalError(error);
  return runtimeNoticeRow({
    noticeId,
    level: "error",
    title: closed ? "Approval no longer open" : "Decision not confirmed",
    message: closed
      ? "The server did not accept your decision because this approval is no longer open. For example, it expired or you decided it in another tab."
      : decisionFailureText(error),
    createdAt: new Date().toISOString()
  });
}

type ApprovalRequiredValue = Pick<Approval, "approvalId" | "itemId" | "kind" | "title" | "summary" | "toolCallId" | "allowForTurn">;

function pendingApprovalRow(approval: ApprovalRequiredValue): ApprovalRow {
  return {
    type: "approval",
    rowId: `approval:${approval.approvalId}`,
    approvalId: approval.approvalId,
    itemId: approval.itemId,
    ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
    kind: approval.kind,
    title: approval.title,
    summary: approval.summary,
    status: "pending",
    decisionState: "pending",
    allowForTurn: approval.allowForTurn !== false
  };
}

// Replace the rows with the pending approvals of the server, except those
// that this tab saw close. Keep the local decision state of a row, so a read
// that lands while the decision request is in flight does not re-enable its
// buttons.
function withServerApprovals(prev: ApprovalRow[], approvals: Approval[], closed: ReadonlySet<string>): ApprovalRow[] {
  return pendingApprovalRows(approvals)
    .filter((row) => !closed.has(row.approvalId))
    .map((row) => prev.find((current) => current.approvalId === row.approvalId) ?? row);
}

function pendingApprovalRows(approvals: Approval[]): ApprovalRow[] {
  const rows = new Map<string, ApprovalRow>();
  for (const approval of approvals) {
    if (approval.status !== "pending") continue;
    rows.set(approval.approvalId, pendingApprovalRow(approval));
  }
  return [...rows.values()];
}

export function useAguiCustomEvents(agent: AbstractAgent, options: AguiCustomEventsOptions = {}): AguiCustomEvents {
  const {
    initialToolStatuses = EMPTY_TOOL_STATUSES,
    initialApprovals = EMPTY_APPROVALS,
    initialNotices = EMPTY_NOTICES,
    initialMcpApps = EMPTY_MCP_APPS
  } = options;
  const [approvals, setApprovals] = useState(() => pendingApprovalRows(initialApprovals));
  const [notices, setNotices] = useState<RuntimeNoticeRow[]>(initialNotices);
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatusRow[]>([]);
  const [toolStatuses, setToolStatuses] = useState<ToolStatusRow[]>(initialToolStatuses);
  const [mcpApps, setMcpApps] = useState(initialMcpApps);
  // A saved-state snapshot, a run transition, or a clean end outranks an
  // older approval read.
  const approvalRevisionRef = useRef(0);
  // Approvals that expired or got a decision in this tab. The backend sends
  // an expiry notice before it saves the expiry, so a read can still list
  // such an approval as pending. A server read does not bring it back.
  const closedApprovalIdsRef = useRef<Set<string>>(new Set());
  // A dismissed notice stays hidden when a later poll or event carries it again.
  const dismissedNoticeIdsRef = useRef<Set<string>>(new Set());
  // tool_meta (server attribution) seen for a toolCallId before its tool_status
  // failure arrives. Not state — it only feeds the row built on tool_status.
  const toolMetaRef = useRef<Map<string, { server: string | null }>>(new Map());
  // REST returns new objects on every poll, even when the saved turn is
  // unchanged. The last applied snapshot, to skip one that did not change.
  const lastSnapshotRef = useRef<string | null>(null);
  // The agent of the subscription and a function that starts its approval
  // read. Null after the cleanup.
  const approvalReaderRef = useRef<{ agent: AbstractAgent; read: () => void } | null>(null);

  useEffect(() => {
    approvalRevisionRef.current += 1;

    // @ag-ui/client keeps the subscribers of a run from its start, so a run
    // that outlives this subscription still calls it. After the cleanup the
    // host is gone.
    let disposed = false;

    // A reconnect replays the turn from its start, so an approval_required
    // event can belong to an approval that is already decided or expired.
    // Show the pending approvals of the server instead. The backend saves an
    // approval before it sends the event, so a read that starts after the
    // event includes it. Only the latest read applies, and only when no newer
    // snapshot, run, or clean end replaced the approvals during it. An expiry
    // or a decision during the read removes only its own approval.
    //
    // A failed read keeps the cards that are shown and adds none: the event
    // alone does not show that its approval is still pending. The read is
    // tried again a few times, so a pending approval still gets its card.
    //
    // A decision that the server refuses because the approval is not open
    // also starts a read. In a live run, an approval_required event during
    // that read starts a newer read, so the older result cannot remove the
    // new card.
    const approvalReads = new AbortController();
    let latestApprovalRead = 0;
    let approvalReadRunning = false;
    let approvalRetry: ReturnType<typeof setTimeout> | undefined;
    const readServerApprovals = (attempt = 1) => {
      clearTimeout(approvalRetry);
      const read = ++latestApprovalRead;
      const revision = approvalRevisionRef.current;
      const isLatest = () => !approvalReads.signal.aborted && read === latestApprovalRead;
      approvalReadRunning = true;
      listApprovals(agent.threadId, approvalReads.signal).then(
        (serverApprovals) => {
          if (!isLatest()) return;
          approvalReadRunning = false;
          if (revision === approvalRevisionRef.current) {
            setApprovals((prev) => withServerApprovals(prev, serverApprovals, closedApprovalIdsRef.current));
          }
        },
        () => {
          if (!isLatest()) return;
          approvalReadRunning = false;
          if (attempt >= APPROVAL_READ_ATTEMPTS) return;
          approvalRetry = setTimeout(() => readServerApprovals(attempt + 1), APPROVAL_READ_RETRY_MS * attempt);
        }
      );
    };
    approvalReaderRef.current = { agent, read: () => readServerApprovals() };

    const subscription = agent.subscribe({
      onRunInitialized({ input }) {
        if (disposed) return;
        approvalRevisionRef.current += 1;
        // A read of an earlier run does not apply and is not tried again.
        latestApprovalRead += 1;
        approvalReadRunning = false;
        clearTimeout(approvalRetry);
        if (isReconnectRun(input)) return;
        // A new send replaces the report of an earlier refused send.
        setNotices((prev) => {
          const kept = prev.filter((notice) => !notice.noticeId.startsWith(SEND_REFUSED_NOTICE_PREFIX));
          return kept.length === prev.length ? prev : kept;
        });
      },
      onRunFinishedEvent({ event }) {
        if (disposed) return;
        // A turn that the backend stopped says why (a security change, ended
        // tool access). The saved row shows the same notice after a reload.
        const reason = turnStopReasonOfResult((event as { result?: unknown }).result);
        const runId = (event as { runId?: unknown }).runId;
        if (!reason || typeof runId !== "string") return;
        const notice = turnStoppedNotice(runId, reason, new Date().toISOString());
        if (dismissedNoticeIdsRef.current.has(notice.noticeId)) return;
        setNotices((prev) => (prev.some((n) => n.noticeId === notice.noticeId) ? prev : [...prev, notice]));
      },
      onCustomEvent({ event, input }) {
        if (disposed) return;
        const parsed = CogniplaneCustomEventSchema.safeParse(event);
        if (!parsed.success) return;
        const customEvent = parsed.data;
        switch (customEvent.name) {
          case "approval_required": {
            const v = customEvent.value;
            if (isReconnectRun(input)) {
              readServerApprovals();
              break;
            }
            setApprovals((prev) =>
              prev.some((a) => a.approvalId === v.approvalId) ? prev : [...prev, pendingApprovalRow(v)]
            );
            if (approvalReadRunning) readServerApprovals();
            break;
          }
          case "runtime_notice": {
            const v = customEvent.value;
            if (!dismissedNoticeIdsRef.current.has(v.noticeId)) {
              setNotices((prev) =>
                prev.some((n) => n.noticeId === v.noticeId) ? prev : [...prev, runtimeNoticeRow(v)]
              );
            }
            // Expiry rides the notice id; drop the card so it stops looking
            // actionable (deciding an expired approval errors).
            const expiredApprovalId = expiredApprovalIdFromNotice(v.noticeId);
            if (expiredApprovalId) {
              closedApprovalIdsRef.current.add(expiredApprovalId);
              setApprovals((prev) => prev.filter((a) => a.approvalId !== expiredApprovalId));
            }
            break;
          }
          case "mcp_server_status": {
            const v = customEvent.value;
            // A healthy "ready" is not a surfaced transition (matches the
            // timeline, which only renders starting/failed/cancelled) — skip it
            // so a normal successful run leaves no persistent "server · ready".
            if (v.status === "ready") break;
            // Capture the narrowed status in a const — control-flow narrowing
            // from the guard above doesn't reach into the setState closure.
            const status = v.status;
            setMcpStatuses((prev) => [
              // Keep only the latest status per server.
              ...prev.filter((s) => s.serverName !== v.serverName),
              {
                type: "mcp-server-status",
                rowId: `mcp:${v.serverName}`,
                serverName: v.serverName,
                status,
                error: v.error ?? null
              }
            ]);
            break;
          }
          case "tool_mcp_app": {
            const { toolCallId, app } = customEvent.value;
            setMcpApps((current) => ({ ...current, [toolCallId]: app }));
            break;
          }
          case "tool_meta": {
            // Stash server attribution against the toolCallId; only surfaced if
            // this call later fails (tool_status). A successful tool leaves no
            // row.
            const v = customEvent.value;
            toolMetaRef.current.set(v.toolCallId, { server: v.server ?? null });
            break;
          }
          case "tool_status": {
            // Only failed/declined are emitted. The row is keyed on
            // toolCallId: the tool card reads it to show the outcome.
            const v = customEvent.value;
            const meta = toolMetaRef.current.get(v.toolCallId);
            setToolStatuses((prev) => [
              ...prev.filter((s) => s.toolCallId !== v.toolCallId),
              {
                type: "tool-status",
                rowId: `tool:${v.toolCallId}`,
                toolCallId: v.toolCallId,
                toolName: v.toolName ?? "tool",
                status: v.status,
                server: meta?.server ?? null,
                durationMs: v.durationMs ?? null
              }
            ]);
            break;
          }
          default:
            // The browser agent applies the transcript events.
            break;
        }
      }
    });

    return () => {
      disposed = true;
      approvalReaderRef.current = null;
      subscription.unsubscribe();
      approvalReads.abort();
      clearTimeout(approvalRetry);
    };
  }, [agent]);

  const onApprovalDecision = useCallback(
    (approvalId: string, decision: ApprovalDecision) => {
      const clickedAgent = approvalReaderRef.current?.agent;
      const noticeId = `${DECISION_FAILED_NOTICE_PREFIX}${approvalId}`;
      setApprovals((prev) =>
        prev.map((a) =>
          a.approvalId === approvalId
            ? { ...a, decisionState: decision.decision === "approve" ? "approving" : "rejecting" }
            : a
        )
      );
      void resolveApproval(approvalId, decision.decision, decision.rememberForTurn).then(
        () => {
          closedApprovalIdsRef.current.add(approvalId);
          setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId));
          setNotices((prev) => {
            const kept = prev.filter((notice) => notice.noticeId !== noticeId);
            return kept.length === prev.length ? prev : kept;
          });
        },
        (error: unknown) => {
          // Enable the buttons again, so the user can try again. The backend
          // TTL still guards a stuck row.
          setApprovals((prev) =>
            prev.map((a) => (a.approvalId === approvalId ? { ...a, decisionState: "pending" } : a))
          );
          // An answer after a session switch or an unmount does not report
          // into the session that is shown now.
          const reader = approvalReaderRef.current;
          if (!reader || reader.agent !== clickedAgent) return;
          const notice = decisionFailedNotice(noticeId, error);
          setNotices((prev) => [...prev.filter((n) => n.noticeId !== noticeId), notice]);
          // The server says that the approval is not open. Its pending list
          // decides if the row stays.
          if (isClosedApprovalError(error)) reader.read();
        }
      );
    },
    []
  );

  const syncServerState = useCallback((snapshot: RemoteTurnSnapshot) => {
    const key = JSON.stringify(snapshot);
    if (key === lastSnapshotRef.current) return;
    lastSnapshotRef.current = key;
    approvalRevisionRef.current += 1;
    setApprovals((prev) => withServerApprovals(prev, snapshot.approvals, closedApprovalIdsRef.current));
    setToolStatuses(toolStatusesFromMessages(snapshot.messages));
    setMcpApps((current) => ({ ...current, ...mcpAppsFromMessages(snapshot.messages) }));
    const saved = runtimeNoticesFromMessages(snapshot.messages);
    setNotices((prev) => {
      const shown = new Set(prev.map((notice) => notice.noticeId));
      const added = saved.filter((notice) =>
        !shown.has(notice.noticeId) && !dismissedNoticeIdsRef.current.has(notice.noticeId)
      );
      return added.length > 0 ? [...prev, ...added] : prev;
    });
  }, []);

  const addNotice = useCallback((notice: RuntimeNoticeRow) => {
    setNotices((prev) => [...prev, notice]);
  }, []);

  const clearApprovals = useCallback(() => {
    approvalRevisionRef.current += 1;
    setApprovals([]);
  }, []);

  const dismissStatusRows = useCallback(() => {
    setNotices((prev) => {
      for (const notice of prev) dismissedNoticeIdsRef.current.add(notice.noticeId);
      return [];
    });
    setToolStatuses([]);
    setMcpStatuses([]);
  }, []);

  return {
    approvals, notices, mcpStatuses, toolStatuses, mcpApps,
    onApprovalDecision, syncServerState, addNotice, clearApprovals, dismissStatusRows
  };
}
