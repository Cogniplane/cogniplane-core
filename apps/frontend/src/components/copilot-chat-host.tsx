"use client";
// CopilotKit chat host (the default chat UI).
//
// Renders CopilotKit's <CopilotChat> against our backend via the direct
// dev-only-agent path (`agents__unsafe_dev_only`), so NO Next.js CopilotRuntime
// API route is needed — which also sidesteps the Cloudflare-Workers runtime
// concern. The agent is DeepAgentsBrowserAgent, an HttpAgent subclass pointed at
// `POST /messages?format=agui`.
//
// Text/tool-calls/reasoning render natively; the custom AG-UI events (approvals,
// notices, MCP status) render via useAguiCustomEvents, and tool cards + the plan
// pane via CopilotRenderSlots.

import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChat, type ComponentsMap } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { useEffect, useMemo, useRef } from "react";
import type { Message as AGUIMessage, State as AGUIState } from "@ag-ui/client";
import type { Approval, EffortLevel, Model } from "@cogniplane/shared-types";

import { DeepAgentsBrowserAgent } from "../lib/agui/deep-agents-browser-agent";
import { useAguiCustomEvents } from "../lib/agui/use-agui-custom-events";
import { CopilotRenderSlots } from "./copilot-render-slots";
import { ModelEffortSelector } from "./model-effort-selector";
import { ContextWindowMeter } from "./context-window-meter";
import { ApprovalRowView } from "./chat-cards/approval-row";
import { MarkdownImage } from "./markdown-image";
import type { ToolStatusRow } from "./chat-cards/chat-cards.types";
import {
  McpServerStatusRowView,
  RuntimeNoticeRowView,
  ToolStatusRowView
} from "./chat-cards/status-rows";

const AGENT_NAME = "deepAgents";

// CopilotKit sanitizes assistant markdown with rehype's default schema, which
// permits <img> — so an agent-authored image tag reaches the DOM and the CSP
// blocks the fetch, leaving a broken icon. Route it through the same renderer
// SafeMarkdown uses: trusted hosts render, everything else becomes a
// click-through link. ComponentsMap types its entries as React.FC over a
// children-carrying prop bag rather than react-markdown's Components, so the
// cast lives here, at the boundary, and not inside markdown-image.tsx.
const MARKDOWN_TAG_RENDERERS: ComponentsMap = {
  img: MarkdownImage as ComponentsMap[string]
};

export type ChatSessionModel = {
  id: string;
  /** Persisted history to seed the transcript with; snapshotted at mount. */
  initialMessages: AGUIMessage[];
  /** Persisted agent state to seed at mount (the plan pane); snapshotted too. */
  initialState: AGUIState;
  /** Failed/declined tool-status rows reconstructed from history so a reloaded
   *  session renders tool failures the native card can't show. */
  initialToolStatuses: ToolStatusRow[];
  /** Pending REST approvals seed the live owner when this session opens. */
  initialApprovals: Approval[];
};

export type ChatModelSelection = {
  model?: string;
  effort: EffortLevel | null;
  models: Model[];
  showEffortSelector: boolean;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
};

export type ChatUsageModel = {
  contextTokens: number;
  contextWindow: number;
  sessionCostUsd: number;
};

export type ChatEventHandlers = {
  onTurnSettled?: () => void;
  onRunningChange?: (isRunning: boolean) => void;
  onPendingApprovalsChange?: (count: number) => void;
};

export function CopilotChatHost({ session, modelSelection, usage, artifactIds, events }: {
  session: ChatSessionModel;
  modelSelection: ChatModelSelection;
  usage: ChatUsageModel;
  /** Artifacts the user has checkboxed; read live at send time via a ref. */
  artifactIds: string[];
  events: ChatEventHandlers;
}) {
  const { id: sessionId, initialMessages, initialState, initialToolStatuses, initialApprovals } = session;
  const { model, effort, models, showEffortSelector, onModelChange, onEffortChange } = modelSelection;
  const { onTurnSettled, onRunningChange, onPendingApprovalsChange } = events;
  // Per-turn inputs (model, effort, checkboxed artifact ids) are held in refs the
  // agent reads at send time, so a change between turns is picked up WITHOUT
  // re-keying the agent. Re-keying would rebind CopilotKit to a fresh agent and
  // wipe the live transcript — and model/effort settle asynchronously (they
  // validate once /models resolves, possibly mid-turn), so keying on them risks
  // orphaning an in-flight run. Only `sessionId` (the threadId) fixes identity.
  const modelRef = useRef(model);
  const effortRef = useRef(effort);
  const artifactIdsRef = useRef(artifactIds);
  useEffect(() => {
    modelRef.current = model;
    effortRef.current = effort;
    artifactIdsRef.current = artifactIds;
  }, [model, effort, artifactIds]);

  // `initialMessages`/`initialState` seed the transcript + plan pane at
  // construction; they are intentionally NOT deps — the parent gates this mount
  // on `isSessionDataReady`, so
  // the first (and only) construction already carries this session's history, and
  // a post-turn refresh must not reconstruct the agent and drop live state. The
  // getters read their refs lazily at send time, not during render, so they are
  // safe despite the react-hooks/refs heuristic.
  const agent = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      new DeepAgentsBrowserAgent({
        sessionId,
        initialMessages,
        initialState,
        getModel: () => modelRef.current,
        getEffort: () => effortRef.current,
        getArtifactIds: () => artifactIdsRef.current
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId]
  );

  // Abort any in-flight run when this host unmounts. The host is keyed by
  // sessionId in the shell, so switching sessions mid-turn tears down this
  // agent — without this, the underlying fetch/SSE keeps streaming and the
  // backend keeps executing the turn (E2B sandbox, LLM tokens, DB connection)
  // until RUNTIME_TURN_TIMEOUT_MS (up to 20 min). abortRun() closes the fetch,
  // which trips the backend's socket-close interrupt and tears the turn down.
  useEffect(() => {
    return () => {
      agent.abortRun();
    };
  }, [agent]);

  // Slice B: the CUSTOM AG-UI events CopilotChat doesn't render natively. We
  // subscribe to the same agent instance CopilotKit runs and drive local state.
  const { approvals, notices, mcpStatuses, toolStatuses, isRunning, onApprovalDecision } =
    useAguiCustomEvents(agent, onTurnSettled, initialToolStatuses, initialApprovals);

  // Lift the live turn-running + pending-approval signals to the shell so the
  // sidebar streaming dot and header attention dot track the AG-UI stream in
  // real time (the shell can't read this state directly — the agent instance
  // that useAguiCustomEvents subscribes to lives only in this host).
  useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);
  useEffect(() => {
    onPendingApprovalsChange?.(approvals.length);
  }, [approvals.length, onPendingApprovalsChange]);

  return (
    <CopilotKit
      agents__unsafe_dev_only={{ [AGENT_NAME]: agent }}
      agent={AGENT_NAME}
      threadId={sessionId}
      showDevConsole={false}
    >
      <CopilotRenderSlots agentName={AGENT_NAME} />
      <div className="flex min-h-0 flex-1 flex-col">
        {/* z-40: must beat .copilotKitChat's own `z-index: 30` (a flex item's
            z-index applies even at position:static), or popovers hanging off
            this bar — the context/cost tooltip, the model dropdown — paint
            UNDER the chat body regardless of their own z-index. */}
        <div className="relative z-40 flex items-center justify-end gap-3 border-b border-outline-variant bg-surface px-4 py-2">
          <ModelEffortSelector
            model={model ?? ""}
            effort={effort}
            models={models}
            showEffortSelector={showEffortSelector}
            disabled={isRunning}
            onModelChange={onModelChange}
            onEffortChange={onEffortChange}
          />
          <ContextWindowMeter
            usedTokens={usage.contextTokens}
            contextWindow={usage.contextWindow}
            costUsd={usage.sessionCostUsd}
          />
        </div>
        {(approvals.length > 0 ||
          notices.length > 0 ||
          mcpStatuses.length > 0 ||
          toolStatuses.length > 0) && (
          <div className="flex flex-col gap-2 border-b border-outline-variant bg-surface px-4 py-3">
            {approvals.map((row) => (
              <ApprovalRowView key={row.rowId} row={row} onDecision={onApprovalDecision} />
            ))}
            {notices.map((row) => (
              <RuntimeNoticeRowView key={row.rowId} row={row} />
            ))}
            {mcpStatuses.map((row) => (
              <McpServerStatusRowView key={row.rowId} row={row} />
            ))}
            {toolStatuses.map((row) => (
              <ToolStatusRowView key={row.rowId} row={row} />
            ))}
          </div>
        )}
        <CopilotChat
          // chat-markdown: CopilotChat's built-in markdown renderer emits bare
          // <table>/<blockquote> tags; the shared rules in globals.css style them.
          className="chat-markdown flex min-h-0 flex-1 flex-col"
          labels={{ title: "Cogniplane", initial: "Ask me anything." }}
          markdownTagRenderers={MARKDOWN_TAG_RENDERERS}
        />
      </div>
    </CopilotKit>
  );
}
