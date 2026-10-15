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
  toolStatusesFromMessages
} from "../../components/agui-transcript";
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

type ApprovalRequiredValue = Pick<Approval, "approvalId" | "itemId" | "kind" | "title" | "summary">;

function pendingApprovalRow(approval: ApprovalRequiredValue): ApprovalRow {
  return {
    type: "approval",
    rowId: `approval:${approval.approvalId}`,
    approvalId: approval.approvalId,
    itemId: approval.itemId,
    kind: approval.kind,
    title: approval.title,
    summary: approval.summary,
    status: "pending",
    decisionState: "pending"
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
    const approvalReads = new AbortController();
    let latestApprovalRead = 0;
    let approvalRetry: ReturnType<typeof setTimeout> | undefined;
    const readServerApprovals = (attempt = 1) => {
      clearTimeout(approvalRetry);
      const read = ++latestApprovalRead;
      const revision = approvalRevisionRef.current;
      const isLatest = () => !approvalReads.signal.aborted && read === latestApprovalRead;
      listApprovals(agent.threadId, approvalReads.signal).then(
        (serverApprovals) => {
          if (isLatest() && revision === approvalRevisionRef.current) {
            setApprovals((prev) => withServerApprovals(prev, serverApprovals, closedApprovalIdsRef.current));
          }
        },
        () => {
          if (!isLatest() || attempt >= APPROVAL_READ_ATTEMPTS) return;
          approvalRetry = setTimeout(() => readServerApprovals(attempt + 1), APPROVAL_READ_RETRY_MS * attempt);
        }
      );
    };

    const subscription = agent.subscribe({
      onRunInitialized({ input }) {
        if (disposed) return;
        approvalRevisionRef.current += 1;
        // A read of an earlier run does not apply and is not tried again.
        latestApprovalRead += 1;
        clearTimeout(approvalRetry);
        if (isReconnectRun(input)) return;
        // A new send replaces the report of an earlier refused send.
        setNotices((prev) => {
          const kept = prev.filter((notice) => !notice.noticeId.startsWith(SEND_REFUSED_NOTICE_PREFIX));
          return kept.length === prev.length ? prev : kept;
        });
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
      subscription.unsubscribe();
      approvalReads.abort();
      clearTimeout(approvalRetry);
    };
  }, [agent]);

  const onApprovalDecision = useCallback(
    (approvalId: string, decision: ApprovalDecision) => {
      setApprovals((prev) =>
        prev.map((a) =>
          a.approvalId === approvalId
            ? { ...a, decisionState: decision.decision === "approve" ? "approving" : "rejecting" }
            : a
        )
      );
      void resolveApproval(approvalId, decision.decision, decision.rememberForTurn)
        .then(() => {
          closedApprovalIdsRef.current.add(approvalId);
          setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId));
        })
        .catch(() => {
          // Reset so the user can retry; the backend TTL still guards a stuck row.
          setApprovals((prev) =>
            prev.map((a) => (a.approvalId === approvalId ? { ...a, decisionState: "pending" } : a))
          );
        });
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
