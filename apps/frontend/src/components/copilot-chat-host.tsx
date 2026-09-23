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
import { CopilotChat, type ComponentsMap, type InputProps } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { randomUUID, type Message as AGUIMessage, type State as AGUIState } from "@ag-ui/client";
import type { Approval, EffortLevel, Model } from "@cogniplane/shared-types";

import { DeepAgentsBrowserAgent, isSessionBusyError } from "../lib/agui/deep-agents-browser-agent";
import { useAguiCustomEvents, type AguiCustomEvents } from "../lib/agui/use-agui-custom-events";
import { useRemoteTurn, type RemoteTurnSnapshot } from "../lib/agui/use-remote-turn";
import { ApiError } from "../lib/api-client";
import { interruptSession } from "../lib/session-api";
import { planStateFromMessages, runtimeNoticesFromMessages, toAguiInitialMessages, toolStatusesFromMessages } from "./agui-transcript";
import { Button } from "./ui/button";
import { CopilotRenderSlots } from "./copilot-render-slots";
import { ModelEffortSelector } from "./model-effort-selector";
import { ContextWindowMeter } from "./context-window-meter";
import { ApprovalRowView } from "./chat-cards/approval-row";
import { MarkdownImage } from "./markdown-image";
import type { RuntimeNoticeRow, ToolStatusRow } from "./chat-cards/chat-cards.types";
import {
  McpServerStatusRowView,
  RuntimeNoticeRowView,
  ToolStatusRowView
} from "./chat-cards/status-rows";

const AGENT_NAME = "deepAgents";
const EMPTY_PROJECT_FILE_IDS: string[] = [];

function ReadOnlyChatInput(_props: InputProps) {
  return (
    <div role="note" className="border-t border-outline-variant bg-surface-container-low px-4 py-3 text-center text-sm text-on-surface-variant">
      You can read this shared session, but only project owners and editors can send messages.
    </div>
  );
}

type RemoteTurnControls = {
  canEdit: boolean;
  messageRefused: boolean;
  isStopping: boolean;
  stopError: string | null;
  onStop: () => void;
};

// CopilotChat takes an Input component type, not an element. A context gives
// the module-level component its per-host values without a new component type
// on each render, which would remount the composer.
const RemoteTurnContext = createContext<RemoteTurnControls | null>(null);

function RemoteRunningChatInput(_props: InputProps) {
  const controls = useContext(RemoteTurnContext);
  if (!controls) return null;
  const { canEdit, messageRefused, isStopping, stopError, onStop } = controls;
  return (
    <div className="flex flex-col gap-2 border-t border-outline-variant bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-brand" />
        <p role="status" className="min-w-0 flex-1">
          {messageRefused
            ? "Your message was not sent because the agent is still working on this chat. Send it again when the agent finishes."
            : canEdit
              ? "The agent is still working on this chat. You can send a message when it finishes."
              : "The agent is working on this chat. Only project owners and editors can send messages."}
        </p>
        {canEdit ? (
          <Button type="button" size="sm" variant="outline" disabled={isStopping} onClick={onStop}>
            {isStopping ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
      </div>
      {stopError ? <p role="alert" className="text-danger">{stopError}</p> : null}
    </div>
  );
}

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
  /** Persisted history to seed the transcript with; snapshotted at mount.
   *  When `isRunning` is true, it must not contain the saved in-progress reply:
   *  the host attaches to the turn, and the replay adds that reply. */
  initialMessages: AGUIMessage[];
  /** Persisted agent state to seed at mount (the plan pane); snapshotted too. */
  initialState: AGUIState;
  /** Failed/declined tool-status rows reconstructed from history so a reloaded
   *  session renders tool failures the native card can't show. */
  initialToolStatuses: ToolStatusRow[];
  /** Pending REST approvals seed the live owner when this session opens. */
  initialApprovals: Approval[];
  /** Runtime notices saved on the assistant rows of the loaded history. */
  initialNotices?: RuntimeNoticeRow[];
  /** Saved running state from the session list. A turn that runs without this
   *  tab's stream puts the chat in remote-running mode. When it is true at
   *  mount, the host also attaches to the turn and shows it live. */
  isRunning?: boolean;
  canEdit?: boolean;
  /** Optional one-shot instruction attached to an explicit project action. */
  initialPrompt?: string;
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
  onInitialPromptSent?: () => void;
  onTurnSettled?: () => void;
  onTurnActivityChange?: (activity: AguiCustomEvents["turnActivity"]) => void;
  /** True while this tab streams its own turn. */
  onRunningChange?: (isRunning: boolean) => void;
  /** True while the turn runs on the server without this tab's stream. */
  onRemoteRunningChange?: (isRemoteRunning: boolean) => void;
  onPendingApprovalsChange?: (count: number) => void;
};

export function CopilotChatHost({ session, modelSelection, usage, artifactIds, projectFileIds, events }: {
  session: ChatSessionModel;
  modelSelection: ChatModelSelection;
  usage: ChatUsageModel;
  /** Artifacts the user has checkboxed; read live at send time via a ref. */
  artifactIds: string[];
  projectFileIds?: string[];
  events: ChatEventHandlers;
}) {
  const { id: sessionId, initialMessages, initialState, initialToolStatuses, initialApprovals, initialNotices, initialPrompt, isRunning: serverRunning = false, canEdit = true } = session;
  const { model, effort, models, showEffortSelector, onModelChange, onEffortChange } = modelSelection;
  const { onInitialPromptSent, onTurnSettled, onRunningChange, onRemoteRunningChange, onPendingApprovalsChange, onTurnActivityChange } = events;
  // Per-turn inputs (model, effort, checkboxed artifact ids) are held in refs the
  // agent reads at send time, so a change between turns is picked up WITHOUT
  // re-keying the agent. Re-keying would rebind CopilotKit to a fresh agent and
  // wipe the live transcript — and model/effort settle asynchronously (they
  // validate once /models resolves, possibly mid-turn), so keying on them risks
  // orphaning an in-flight run. Only `sessionId` (the threadId) fixes identity.
  const modelRef = useRef(model);
  const effortRef = useRef(effort);
  const artifactIdsRef = useRef(artifactIds);
  const stableProjectFileIds = projectFileIds ?? EMPTY_PROJECT_FILE_IDS;
  const projectFileIdsRef = useRef(stableProjectFileIds);
  useEffect(() => {
    modelRef.current = model;
    effortRef.current = effort;
    artifactIdsRef.current = artifactIds;
    projectFileIdsRef.current = stableProjectFileIds;
  }, [model, effort, artifactIds, stableProjectFileIds]);

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
        getArtifactIds: () => artifactIdsRef.current,
        getProjectFileIds: () => projectFileIdsRef.current
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId]
  );

  // Close this tab's stream when the host unmounts. The host is keyed by
  // sessionId in the shell, so a session switch tears down this agent. The
  // turn continues on the server. Only Stop ends it early.
  useEffect(() => {
    return () => {
      agent.abortRun();
    };
  }, [agent]);

  const [messageRefused, setMessageRefused] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const enterRemoteRunningRef = useRef<() => void>(() => undefined);
  const onSessionBusy = useCallback(() => {
    setMessageRefused(true);
    enterRemoteRunningRef.current();
  }, []);
  // The stream dropped, but the turn can still run on the server. The remote
  // poll confirms the end and does the settled refresh.
  const onStreamLost = useCallback(() => enterRemoteRunningRef.current(), []);
  // Slice B: the CUSTOM AG-UI events CopilotChat doesn't render natively. We
  // subscribe to the same agent instance CopilotKit runs and drive local state.
  const { approvals, notices, mcpStatuses, toolStatuses, isRunning, turnActivity, onApprovalDecision, syncServerState, dismissStatusRows } =
    useAguiCustomEvents(agent, {
      onRunSettled: onTurnSettled,
      onSessionBusy,
      onStreamLost,
      initialToolStatuses,
      initialApprovals,
      initialNotices
    });

  // Attach when this chat opens on a running turn, or when another tab starts
  // one while this chat stays open. A server-running period gets one attempt.
  // Call the agent directly: CopilotKit's core.connectAgent clears messages
  // and state first. Polling waits until the connection ends.
  const [previousServerRunning, setPreviousServerRunning] = useState(serverRunning);
  const [isConnecting, setIsConnecting] = useState(serverRunning);
  if (serverRunning !== previousServerRunning) {
    setPreviousServerRunning(serverRunning);
    setIsConnecting(serverRunning);
  }
  useEffect(() => {
    if (!isConnecting) return;
    // A turn started in this tab already has a live stream.
    if (agent.isRunning) {
      const timer = setTimeout(() => setIsConnecting(false), 0);
      return () => clearTimeout(timer);
    }
    // Wait one task. React StrictMode mounts, cleans up, and mounts again in
    // one commit. Without the wait, the first connection starts and then
    // aborts at once.
    const timer = setTimeout(() => {
      agent
        .connectAgent()
        // The event hook handles a failed connection.
        .catch(() => undefined)
        .finally(() => setIsConnecting(false));
    }, 0);
    return () => clearTimeout(timer);
  }, [agent, isConnecting]);

  const applyRemoteSnapshot = useCallback(({ messages, approvals: serverApprovals }: RemoteTurnSnapshot) => {
    // Never overwrite the buffer of a run this tab streams.
    if (agent.isRunning) return;
    agent.setMessages(toAguiInitialMessages(messages));
    agent.setState(planStateFromMessages(messages));
    syncServerState({
      approvals: serverApprovals,
      toolStatuses: toolStatusesFromMessages(messages),
      notices: runtimeNoticesFromMessages(messages)
    });
  }, [agent, syncServerState]);
  const onRemoteSettled = useCallback(() => {
    setMessageRefused(false);
    setStopError(null);
    onTurnSettled?.();
  }, [onTurnSettled]);
  const { isRemoteRunning, enterRemoteRunning, refreshRemoteTurn } = useRemoteTurn({
    sessionId,
    serverRunning,
    localRunning: isRunning,
    liveStream: isRunning || isConnecting,
    onSnapshot: applyRemoteSnapshot,
    onSettled: onRemoteSettled
  });
  useEffect(() => {
    enterRemoteRunningRef.current = enterRemoteRunning;
  }, [enterRemoteRunning]);

  // Stop ends the turn on the server, so it also works for a turn that another
  // tab started. CopilotChat calls abortRun() after onStopGeneration, which
  // closes this tab's stream.
  const stopTurn = useCallback(async () => {
    setIsStopping(true);
    setStopError(null);
    try {
      await interruptSession(sessionId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // No turn is active. The turn ended before the request arrived, or the
        // saved running state is stale. Read the server state now, so that a
        // stale state does not lock the composer. If the server reports a
        // running turn, the mode stays on.
        refreshRemoteTurn();
      } else {
        setStopError(`The agent did not stop: ${error instanceof Error ? error.message : String(error)}`);
        // The turn can still be running. Show it, so the user can try again.
        enterRemoteRunning();
      }
    } finally {
      setIsStopping(false);
    }
  }, [enterRemoteRunning, refreshRemoteTurn, sessionId]);
  const onStopGeneration = useCallback(() => {
    void stopTurn();
  }, [stopTurn]);
  const remoteTurnControls = useMemo<RemoteTurnControls>(() => ({
    canEdit,
    messageRefused,
    isStopping,
    stopError,
    onStop: () => void stopTurn()
  }), [canEdit, isStopping, messageRefused, stopError, stopTurn]);

  // Start only after the custom-event subscriber is attached, so the explicit
  // action's running/approval/tool state is visible from its first event.
  // While another turn runs, keep the action and start it when that turn ends.
  const initialPromptSent = useRef(false);
  useEffect(() => {
    if (!initialPrompt || !canEdit || isRemoteRunning || initialPromptSent.current) return;
    initialPromptSent.current = true;
    agent.addMessage({ id: randomUUID(), role: "user", content: initialPrompt });
    agent.runAgent().then(
      () => onInitialPromptSent?.(),
      (error: unknown) => {
        // A busy session puts the host in remote-running mode. That re-runs
        // this effect when the other turn ends.
        if (isSessionBusyError(error)) {
          initialPromptSent.current = false;
          // The action starts again by itself, so the user has nothing to resend.
          setMessageRefused(false);
          return;
        }
        onInitialPromptSent?.();
      }
    );
  }, [agent, canEdit, initialPrompt, isRemoteRunning, onInitialPromptSent]);

  // Lift the live turn-running + pending-approval signals to the shell so the
  // sidebar streaming dot and header attention dot track the AG-UI stream in
  // real time (the shell can't read this state directly — the agent instance
  // that useAguiCustomEvents subscribes to lives only in this host).
  useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);
  useEffect(() => {
    onRemoteRunningChange?.(isRemoteRunning);
  }, [isRemoteRunning, onRemoteRunningChange]);
  useEffect(() => {
    onPendingApprovalsChange?.(approvals.length);
  }, [approvals.length, onPendingApprovalsChange]);

  useEffect(() => {
    onTurnActivityChange?.(turnActivity);
  }, [turnActivity, onTurnActivityChange]);

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
            disabled={isRunning || isRemoteRunning}
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
          <div aria-label="Session notifications" className="flex max-h-[30vh] shrink-0 flex-col gap-2 overflow-y-auto border-b border-outline-variant bg-surface px-4 py-3">
            {notices.length + mcpStatuses.length + toolStatuses.length > 0 && (
              <button type="button" className="self-end text-sm text-on-surface-variant underline" onClick={dismissStatusRows}>
                Dismiss notifications
              </button>
            )}
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
        <RemoteTurnContext.Provider value={remoteTurnControls}>
          <CopilotChat
            // chat-markdown: CopilotChat's built-in markdown renderer emits bare
            // <table>/<blockquote> tags; the shared rules in globals.css style them.
            className="chat-markdown flex min-h-0 flex-1 flex-col"
            labels={{ title: "Cogniplane", initial: "Ask me anything." }}
            Input={isRemoteRunning ? RemoteRunningChatInput : canEdit ? undefined : ReadOnlyChatInput}
            markdownTagRenderers={MARKDOWN_TAG_RENDERERS}
            onStopGeneration={onStopGeneration}
          />
        </RemoteTurnContext.Provider>
      </div>
    </CopilotKit>
  );
}
