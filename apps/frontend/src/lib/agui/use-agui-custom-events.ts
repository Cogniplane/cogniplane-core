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
// The emit side is `runtime-event-to-agui.ts`; these value shapes mirror it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AbstractAgent } from "@ag-ui/client";

import type {
  ApprovalDecision,
  ApprovalRow,
  McpServerStatusRow,
  RuntimeNoticeRow,
  ToolStatusRow
} from "../../components/chat-cards/chat-cards.types";
import { resolveApproval } from "../session-api";

// Custom-event `value` payloads (mirror the emit side in runtime-event-to-agui.ts).
type ApprovalValue = {
  approvalId: string;
  itemId: string;
  kind: string;
  title: string;
  summary: string;
  availableDecisions?: string[];
  command?: string | null;
  cwd?: string | null;
};
type NoticeValue = {
  noticeId: string;
  level: RuntimeNoticeRow["level"];
  title: string;
  message: string;
  createdAt: string;
};
type McpStatusValue = {
  serverName: string;
  // Wire status includes the healthy "ready"; the row type only carries the
  // surfaced transitions (starting/failed/cancelled), so "ready" is filtered out.
  status: McpServerStatusRow["status"] | "ready";
  error?: string;
};
// tool_meta rides tool START (server/kind/command); tool_status rides tool
// COMPLETION and only fires for failed/declined (see completeTool). So meta
// arrives first for a given toolCallId — we stash it and merge server in when
// the failure status lands.
type ToolMetaValue = {
  toolCallId: string;
  kind?: string;
  server?: string | null;
  command?: string | null;
};
type ToolStatusValue = {
  toolCallId: string;
  toolName?: string;
  status: "failed" | "declined";
  durationMs?: number | null;
};
type UserMessageReplacedValue = {
  messageId: string;
  text: string;
  scanRunId?: string | null;
};

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
  onApprovalDecision: (approvalId: string, decision: ApprovalDecision) => void;
};

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
  initialToolStatuses: ToolStatusRow[] = []
): AguiCustomEvents {
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [notices, setNotices] = useState<RuntimeNoticeRow[]>([]);
  const [mcpStatuses, setMcpStatuses] = useState<McpServerStatusRow[]>([]);
  const [toolStatuses, setToolStatuses] = useState<ToolStatusRow[]>(initialToolStatuses);
  // Keep the latest seed in a ref so the [agent]-keyed reset effect reads the
  // current session's history without re-subscribing on every seed identity.
  const initialToolStatusesRef = useRef(initialToolStatuses);
  useEffect(() => {
    initialToolStatusesRef.current = initialToolStatuses;
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setApprovals([]);
    setNotices([]);
    setMcpStatuses([]);
    // Seed from the re-keyed session's persisted failures (not []) so a reloaded
    // session shows tool failures immediately; live events append on top.
    setToolStatuses(initialToolStatusesRef.current);
    setIsRunning(false);
    toolMetaRef.current = new Map();

    const settle = () => {
      setIsRunning(false);
      onRunSettledRef.current?.();
    };

    const subscription = agent.subscribe({
      onRunInitialized() {
        setIsRunning(true);
      },
      onRunFinalized() {
        settle();
      },
      onRunFailed() {
        settle();
      },
      onCustomEvent({ event, messages }) {
        const value = (event.value ?? {}) as Record<string, unknown>;
        switch (event.name) {
          case "approval_required": {
            const v = value as ApprovalValue;
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
                      kind: v.kind as ApprovalRow["kind"],
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
            const v = value as NoticeValue;
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
            break;
          }
          case "mcp_server_status": {
            const v = value as McpStatusValue;
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
            const v = value as ToolMetaValue;
            if (v.toolCallId) {
              toolMetaRef.current.set(v.toolCallId, { server: v.server ?? null });
            }
            break;
          }
          case "tool_status": {
            // Only failed/declined are emitted. CopilotKit's native tool card
            // can't show failure (no toolCallId in its render props), so surface
            // it as a side-channel row keyed on toolCallId.
            const v = value as ToolStatusValue;
            if (!v.toolCallId) break;
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
            const v = value as UserMessageReplacedValue;
            if (typeof v.text !== "string") break;
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

  return { approvals, notices, mcpStatuses, toolStatuses, isRunning, onApprovalDecision };
}
