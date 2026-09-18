"use client";
// CopilotKit custom-event render slots.
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
// The emit side is `agui-events.ts`; these value shapes mirror it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AbstractAgent } from "@ag-ui/client";
import { CogniplaneCustomEventSchema, type Approval } from "@cogniplane/shared-types";

import type {
  ApprovalDecision,
  ApprovalRow,
  McpServerStatusRow,
  RuntimeNoticeRow,
  ToolStatusRow
} from "../../components/chat-cards/chat-cards.types";
import type { LiveTurnActivity } from "../../components/session-status.logic";
import { resolveApproval } from "../session-api";

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
  approvals: ApprovalRow[];
  notices: RuntimeNoticeRow[];
  mcpStatuses: McpServerStatusRow[];
  // Tool calls that failed/were declined on the live turn (native card can't
  // render failure — see ToolStatusRow).
  toolStatuses: ToolStatusRow[];
  // True while a turn is streaming. Drives model/effort picker disabling (a
  // model change re-keys the agent and would drop a live turn) and lets the
  // host refresh persisted state (tokens/cost) once a turn finalizes.
  isRunning: boolean;
  turnActivity: LiveTurnActivity | null;
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
};

function pendingApprovalRows(approvals: Approval[]): ApprovalRow[] {
  const rows = new Map<string, ApprovalRow>();
  for (const approval of approvals) {
    if (approval.status !== "pending") continue;
    rows.set(approval.approvalId, {
      type: "approval",
      rowId: `approval:${approval.approvalId}`,
      approvalId: approval.approvalId,
      itemId: approval.itemId,
      kind: approval.kind,
      title: approval.title,
      summary: approval.summary,
      status: "pending",
      decisionState: "pending"
    });
  }
  return [...rows.values()];
}

// Called once a turn reaches its terminal state (finalized or failed). The host
// uses it to reload persisted session data (token usage, cost) that the AG-UI
// wire doesn't carry live.
export function useAguiCustomEvents(
  agent: AbstractAgent,
  onRunSettled?: () => void,
  // Failed/declined tool-status rows reconstructed from persisted history so a
  // reloaded session shows tool failures the native card can't render. Seeded
  // here (not just at mount) so a re-key to a different session picks up that
  // session's failures. Live `tool_status` events append to this on top.
  initialToolStatuses: ToolStatusRow[] = [],
  initialApprovals: Approval[] = []
): AguiCustomEvents {
  const [turnActivity, setTurnActivity] = useState<AguiCustomEvents["turnActivity"]>(null);
  const [approvals, setApprovals] = useState(() => pendingApprovalRows(initialApprovals));
  const [notices, setNotices] = useState<RuntimeNoticeRow[]>([]);
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatusRow[]>([]);
  const [toolStatuses, setToolStatuses] = useState<ToolStatusRow[]>(initialToolStatuses);
  // Keep the latest seed in a ref so the [agent]-keyed reset effect reads the
  // current session's history without re-subscribing on every seed identity.
  const initialToolStatusesRef = useRef(initialToolStatuses);
  const initialApprovalsRef = useRef(initialApprovals);
  useEffect(() => {
    initialToolStatusesRef.current = initialToolStatuses;
    initialApprovalsRef.current = initialApprovals;
  });
  const [isRunning, setIsRunning] = useState(false);
  // tool_meta (server attribution) seen for a toolCallId before its tool_status
  // failure arrives. Not state — it only feeds the row built on tool_status.
  const toolMetaRef = useRef<Map<string, { server: string | null }>>(new Map());

  // Keep the latest callback in a ref so the subscription effect stays keyed on
  // [agent] alone — a new onRunSettled identity per render must not re-subscribe.
  const onRunSettledRef = useRef(onRunSettled);
  useEffect(() => {
    onRunSettledRef.current = onRunSettled;
  });

  useEffect(() => {
    // Reset when the agent is re-keyed (new session/model) so stale approvals/
    // notices from the previous agent don't leak in. This is a prop-change reset,
    // not a render-loop — same pattern the shell uses for its own re-key resets.
    // REST seeds the collection on session entry. Subsequent refreshes must
    // not resurrect approvals already decided or expired in this live owner.
    setApprovals(pendingApprovalRows(initialApprovalsRef.current));
    setNotices([]);
    setMcpStatuses([]);
    // Seed from the re-keyed session's persisted failures (not []) so a reloaded
    // session shows tool failures immediately; live events append on top.
    setToolStatuses(initialToolStatusesRef.current);
    setIsRunning(false);
    setTurnActivity(null);
    toolMetaRef.current = new Map();

    // A failed run reaches BOTH onRunFailed (catchError) and onRunFinalized
    // (RxJS finalize) in @ag-ui/client, so settlement has to be idempotent per
    // run or every failure fires two REST refreshes.
    // "failed" wins: onRunFailed lands FIRST on a failure, then finalize, so
    // this records which path settled the run and the finalize handler reads it
    // instead of assuming a clean finish.
    let settledOutcome: "failed" | "finalized" | null = null;
    const settle = (outcome: "failed" | "finalized") => {
      if (settledOutcome) return;
      settledOutcome = outcome;
      setIsRunning(false);
      setTurnActivity((previous) => previous ? {
        ...previous,
        isRunning: false,
        failed: outcome === "failed"
      } : null);
      onRunSettledRef.current?.();
    };

    const subscription = agent.subscribe({
      onRunInitialized() {
        settledOutcome = null;
        setIsRunning(true);
        setTurnActivity({ startedAt: new Date().toISOString(), isRunning: true, failed: false });
      },
      onRunFinalized() {
        // A run that finishes cleanly cannot leave a decision outstanding: a
        // native approval holds the run open until every decision lands, and a
        // policy approval holds the gateway request open until decision or
        // expiry. So a row still here is stale.
        //
        // A FAILED run is the opposite case, which is why this does not live in
        // settle(). If the stream drops while an interrupt is pending, the
        // backend row stays pending and the graph stays paused until its TTL —
        // clearing the card would remove their chance to decide. Reopening
        // the session also restores these cards from the REST seed.
        if (settledOutcome !== "failed") setApprovals([]);
        settle("finalized");
      },
      onRunFailed() {
        settle("failed");
      },
      onCustomEvent({ event, messages }) {
        const parsed = CogniplaneCustomEventSchema.safeParse(event);
        if (!parsed.success) return;
        const customEvent = parsed.data;
        switch (customEvent.name) {
          case "turn_started": {
            setTurnActivity((previous) => previous ? {
              ...previous, turnId: customEvent.value.messageId, turnSequence: customEvent.value.sequence
            } : null);
            break;
          }
          case "approval_required": {
            const v = customEvent.value;
            setApprovals((prev) =>
              prev.some((a) => a.approvalId === v.approvalId)
                ? prev
                : [
                    ...prev,
                    {
                      type: "approval",
                      rowId: `approval:${v.approvalId}`,
                      approvalId: v.approvalId,
                      itemId: v.itemId,
                      kind: v.kind,
                      title: v.title,
                      summary: v.summary,
                      status: "pending",
                      decisionState: "pending"
                    }
                  ]
            );
            break;
          }
          case "runtime_notice": {
            const v = customEvent.value;
            setNotices((prev) =>
              prev.some((n) => n.noticeId === v.noticeId)
                ? prev
                : [
                    ...prev,
                    {
                      type: "runtime-notice",
                      rowId: `notice:${v.noticeId}`,
                      noticeId: v.noticeId,
                      level: v.level,
                      title: v.title,
                      message: v.message,
                      createdAt: v.createdAt
                    }
                  ]
            );
            // Expiry rides the notice id; drop the card so it stops looking
            // actionable (deciding an expired approval errors).
            const expiredApprovalId = expiredApprovalIdFromNotice(v.noticeId);
            if (expiredApprovalId) {
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
          case "tool_meta": {
            // Stash server attribution against the toolCallId; only surfaced if
            // this call later fails (tool_status). A successful tool leaves no
            // row. tool_retracted is not handled here (it drops a card the
            // native renderer owns).
            const v = customEvent.value;
            toolMetaRef.current.set(v.toolCallId, { server: v.server ?? null });
            break;
          }
          case "tool_status": {
            // Only failed/declined are emitted. CopilotKit's native tool card
            // can't show failure (no toolCallId in its render props), so surface
            // it as a side-channel row keyed on toolCallId.
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
          case "user_message_replaced": {
            // PII transform: the backend sent+persisted transformed text but the
            // optimistic bubble still shows the original. Patch the LAST user
            // message's content to the transformed text. We match on position (the
            // most recent user turn is the one just submitted), not the backend
            // messageId — CopilotKit's optimistic bubble carries a client-side id,
            // not the persisted one.
            //
            // We RETURN the mutation instead of calling agent.setMessages(): the
            // AG-UI run keeps its own per-run message buffer (defaultApplyEvents),
            // and processApplyEvents overwrites this.messages from that buffer on
            // every subsequent event — so a direct setMessages() would be reverted
            // by the next assistant TEXT_MESSAGE event. onCustomEvent is run through
            // the subscriber pipeline that DOES fold a returned {messages} back into
            // the run buffer, so the patch survives. We patch the `messages` handed
            // to us (the run-local buffer), not agent.messages. A brand-new array is
            // required — the buffer merge skips a return equal by identity. Reload
            // self-heals regardless (DB already holds the transformed text).
            const v = customEvent.value;
            let lastUserIndex = -1;
            for (let i = messages.length - 1; i >= 0; i -= 1) {
              if (messages[i]?.role === "user") {
                lastUserIndex = i;
                break;
              }
            }
            if (lastUserIndex === -1) break;
            const current = messages[lastUserIndex];
            // Narrowed to a user message above; its content is a string.
            if (current.role !== "user") break;
            if (current.content === v.text) break;
            const patched = messages.slice();
            patched[lastUserIndex] = { ...current, role: "user", content: v.text };
            return { messages: patched };
          }
          default:
            // tool_retracted / text_retracted enrich the native transcript, not
            // surfaced here.
            break;
        }
        return undefined;
      }
    });

    return () => subscription.unsubscribe();
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
        .then(() => setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId)))
        .catch(() => {
          // Reset so the user can retry; the backend TTL still guards a stuck row.
          setApprovals((prev) =>
            prev.map((a) => (a.approvalId === approvalId ? { ...a, decisionState: "pending" } : a))
          );
        });
    },
    []
  );

  return { approvals, notices, mcpStatuses, toolStatuses, isRunning, turnActivity, onApprovalDecision };
}
