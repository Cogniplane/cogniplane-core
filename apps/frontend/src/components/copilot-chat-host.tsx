"use client";
// CopilotKit chat host (the default chat UI).
//
// Renders CopilotKit V2's <CopilotChat> against our backend. The agent is
// DeepAgentsBrowserAgent, an HttpAgent subclass: it sends a message through
// `POST /messages?format=agui` and loads the session through
// `GET /sessions/:id/connect`. The provider registers it through
// `agents__unsafe_dev_only`, so no CopilotKit runtime or Next.js API route is
// needed. This also avoids a runtime on Cloudflare Workers.
//
// CopilotChat owns the transcript. It connects when it mounts, with threadId =
// sessionId, and that connection restores the saved history, the plan, and a
// turn that runs on the server. useSessionConnection owns the lifecycle of
// the session in this tab: readiness, the running state, reconnects, polls,
// and the refresh at the end of a turn. It loads the session again through
// the same CopilotKit connection path. The host never writes messages or
// state into the agent.
//
// Text, reasoning, and tool calls render natively. The custom AG-UI events
// (approvals, notices, MCP status) render through useAguiCustomEvents, the tool
// card and plan through copilot-render-slots.

import {
  CopilotChat,
  CopilotChatAssistantMessage,
  CopilotChatInput,
  CopilotChatMessageView,
  CopilotChatReasoningMessage,
  CopilotKitProvider,
  useCopilotKit,
  type CopilotChatAssistantMessageProps,
  type CopilotChatInputProps,
  type CopilotChatMessageViewProps,
  type ReactActivityMessageRenderer
} from "@copilotkit/react-core/v2";
// Next.js does not load the stylesheet that the package imports inside its
// own dist, so import it here. globals.css maps its theme to our tokens.
import "@copilotkit/react-core/v2/styles.css";
import dynamic from "next/dynamic";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ComponentType
} from "react";
import { SquareIcon } from "lucide-react";
import { randomUUID, type Message as AGUIMessage } from "@ag-ui/client";
import type { Approval, EffortLevel, McpAppCall, Model } from "@cogniplane/shared-types";

import { DeepAgentsBrowserAgent, isSessionBusyError } from "../lib/agui/deep-agents-browser-agent";
import { useAguiCustomEvents } from "../lib/agui/use-agui-custom-events";
import { readServerRunning } from "../lib/agui/use-remote-turn";
import { isAbortError, useSessionConnection } from "../lib/agui/use-session-connection";
import { ApiError } from "../lib/api-client";
import { SHORTCUTS, useShortcut } from "../lib/keyboard-shortcuts";
import { interruptSession } from "../lib/session-api";
import type { LiveTurnActivity } from "./session-status.logic";
import { AgentPlan, CopilotRenderSlots, ToolOutcomeContext, type ToolOutcome } from "./copilot-render-slots";
import { ModelEffortSelector } from "./model-effort-selector";
import { ContextWindowMeter } from "./context-window-meter";
import { ApprovalRowView } from "./chat-cards/approval-row";
import { MarkdownImage } from "./markdown-image";
import { SafeMarkdown } from "./safe-markdown";
import { WidgetDraftNotice, useWidgetDraft, type WidgetDraftComposer, type WidgetDraftSeam } from "./widget-draft";
import type { RuntimeNoticeRow, ToolStatusRow } from "./chat-cards/chat-cards.types";
import {
  McpServerStatusRowView,
  RuntimeNoticeRowView,
  ToolStatusRowView
} from "./chat-cards/status-rows";

const AGENT_ID = "deepAgents";

// CopilotKit registers a built-in renderer for `mcp-apps` activity messages. It
// builds a srcdoc iframe from its own HTML and can run the agent from a widget
// message without the confirmation step. This app shows app tool results with
// McpAppFrame, from CUSTOM events, and never sends activity messages, so that
// renderer must not run. CopilotKit picks a renderer of the chat's agent ID
// before one with no agent ID (useRenderActivityMessage, findRenderer), and the
// built-in one has no agent ID. So this entry takes over, and it renders
// nothing. Its schema accepts any content: the entry reads none, and a message
// that a stricter schema rejects would also render nothing. The type is the
// library's MCPAppsActivityType. The host test keeps the two equal.
const ANY_ACTIVITY_CONTENT: ReactActivityMessageRenderer<unknown>["content"] = {
  "~standard": { version: 1, vendor: "cogniplane", validate: (value) => ({ value }) }
};
// The provider needs a stable array.
const ACTIVITY_RENDERERS: ReactActivityMessageRenderer<unknown>[] = [
  { activityType: "mcp-apps", agentId: AGENT_ID, content: ANY_ACTIVITY_CONTENT, render: () => null }
];

const EMPTY_PROJECT_FILE_IDS: string[] = [];
const McpAppFrame = dynamic(() => import("./mcp-app-frame").then((module) => module.McpAppFrame), { ssr: false });

type McpAppViewContext = {
  apps: Record<string, McpAppCall>;
  sessionId: string;
  /** How a tool view puts text in the message box. It never sends a message. */
  draft: WidgetDraftSeam;
  canEdit: boolean;
  busy: boolean;
};
const McpAppContext = createContext<McpAppViewContext | null>(null);

// CopilotKit types a component slot as its default component, with that
// component's static parts. renderSlot renders any component with the same
// props, so only the type needs this cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asSlot<Default extends ComponentType<any>>(component: ComponentType<ComponentProps<Default>>): Default {
  return component as unknown as Default;
}

// CopilotKit sanitizes assistant markdown with rehype-sanitize's default
// schema, after rehype-raw. That schema permits <img>, and Streamdown allows
// every image host. So an agent-authored image would reach the DOM, and the
// CSP would block the fetch and show a broken icon. Render images through the
// renderer that SafeMarkdown uses: trusted sources render, and every other
// image becomes a click-through link that fetches nothing. The schema also
// permits <picture><source srcset>, which loads an image that no <img>
// names, so drop <source>.
const MARKDOWN_RENDERER = { components: { img: MarkdownImage, source: () => null } };

// The library's reasoning view renders its text with Streamdown and the
// default rules above: raw HTML, and images from every host. It keeps the text
// mounted while the block is collapsed, so such an image would load at once.
// Render the text with SafeMarkdown instead: no raw HTML, and the image rules
// of replies. The library keeps the header, the toggle, and when the block
// opens and closes.
function ReasoningContent({
  isStreaming,
  hasContent,
  children
}: ComponentProps<typeof CopilotChatReasoningMessage.Content>) {
  if (!hasContent && !isStreaming) return null;
  return (
    <div className="pb-2 pt-1 text-sm text-on-surface-variant">
      <SafeMarkdown>{typeof children === "string" ? children : ""}</SafeMarkdown>
      {isStreaming && hasContent ? (
        <span aria-hidden="true" className="ml-1 inline-block size-2 animate-pulse rounded-full bg-on-surface-variant align-middle" />
      ) : null}
    </div>
  );
}

const REASONING_MESSAGE_SLOT = {
  contentView: asSlot<typeof CopilotChatReasoningMessage.Content>(ReasoningContent)
};

function ChatAssistantMessage(props: CopilotChatAssistantMessageProps) {
  const context = useContext(McpAppContext);
  const calls = props.message.toolCalls ?? [];
  return (
    <>
      <CopilotChatAssistantMessage {...props} markdownRenderer={MARKDOWN_RENDERER} />
      {context ? calls.map((call) => {
        const app = context.apps[call.id];
        return app ? (
          <McpAppFrame key={call.id} sessionId={context.sessionId} toolCallId={call.id} toolName={call.function.name}
            app={app} draft={context.draft} canEdit={context.canEdit} busy={context.busy} />
        ) : null;
      }) : null}
    </>
  );
}

const ASSISTANT_MESSAGE_SLOT = asSlot<typeof CopilotChatAssistantMessage>(ChatAssistantMessage);

// Live tool failures. Saved failures also reach the cards through the
// `error` of their saved tool message.
const ToolStatusContext = createContext<ToolStatusRow[]>([]);

function toolOutcomes(messages: AGUIMessage[], statuses: ToolStatusRow[]): ReadonlyMap<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const error = (message as { error?: unknown }).error;
    if (error === "failed" || error === "declined" || error === "interrupted") outcomes.set(message.toolCallId, error);
  }
  for (const status of statuses) outcomes.set(status.toolCallId, status.status);
  return outcomes;
}

const NO_MESSAGES: AGUIMessage[] = [];

function ChatMessageList(props: CopilotChatMessageViewProps) {
  const statuses = useContext(ToolStatusContext);
  const composer = useContext(ComposerContext);
  const messages = props.messages ?? NO_MESSAGES;
  const outcomes = useMemo(() => toolOutcomes(messages, statuses), [messages, statuses]);
  return (
    <ToolOutcomeContext.Provider value={outcomes}>
      {composer?.ready && messages.length === 0 ? (
        <p className="py-6 text-center text-sm text-on-surface-variant">Ask me anything.</p>
      ) : null}
      <CopilotChatMessageView {...props} assistantMessage={ASSISTANT_MESSAGE_SLOT} reasoningMessage={REASONING_MESSAGE_SLOT} />
      <div className="mt-3 empty:hidden">
        <AgentPlan agentId={AGENT_ID} />
      </div>
    </ToolOutcomeContext.Provider>
  );
}

type ComposerControls = {
  canEdit: boolean;
  /** The latest session connection delivered its history, and the host
   *  plans no other one. */
  ready: boolean;
  /** This tab streams the turn: a sent message, or an attached connection. */
  running: boolean;
  /** The turn runs on the server without a stream in this tab. */
  remoteRunning: boolean;
  messageRefused: boolean;
  isStopping: boolean;
  stopError: string | null;
  onStop: () => void;
  /** The message box and the draft that a tool view wrote in it. */
  widgetDraft: WidgetDraftComposer;
};

// CopilotChat takes the composer as a component type, not an element. A
// context gives the module-level component its per-host values without a new
// component type on each render, which would remount the composer.
const ComposerContext = createContext<ComposerControls | null>(null);

function StopButton() {
  const controls = useContext(ComposerContext);
  if (!controls) return null;
  return (
    <CopilotChatInput.SendButton
      aria-label={controls.isStopping ? "Stopping" : "Stop"}
      title="Stop"
      disabled={controls.isStopping}
      onClick={controls.onStop}
    >
      <SquareIcon className="size-[18px] fill-current" />
    </CopilotChatInput.SendButton>
  );
}

function SendButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <CopilotChatInput.SendButton {...props} />;
}

// The chat has no attachments or tool menu, so it shows no add button.
const NO_ADD_MENU_SLOT = asSlot<typeof CopilotChatInput.AddMenuButton>(() => null);

function ReadOnlyNote() {
  return (
    <div role="note" className="border-t border-outline-variant bg-surface-container-low px-4 py-3 text-center text-sm text-on-surface-variant">
      You can read this shared session, but only project owners and editors can send messages.
    </div>
  );
}

function RemoteRunningNote({ controls }: { controls: ComposerControls }) {
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
          <button
            type="button"
            className="rounded-md border border-outline-variant px-3 py-1 text-sm font-medium text-on-surface hover:bg-surface-container disabled:opacity-50"
            disabled={isStopping}
            onClick={onStop}
          >
            {isStopping ? "Stopping…" : "Stop"}
          </button>
        ) : null}
      </div>
      {stopError ? <p role="alert" className="text-danger">{stopError}</p> : null}
    </div>
  );
}

/** The composer slot. A send needs the restored history and no turn in
 *  progress. While a turn streams, the send button stops it. Enter then does
 *  nothing, so a stray Enter cannot stop the agent. */
function ChatComposer(props: CopilotChatInputProps) {
  const controls = useContext(ComposerContext);
  const { value = "", onChange } = props;
  const draft = controls?.widgetDraft;
  const shown = controls !== null && controls.canEdit && !controls.remoteRunning;
  const bindDraft = draft?.bind;
  const endDraft = draft?.end;
  // CopilotChat owns the text of the box. Binding its `value` and `onChange`
  // lets a tool view put a draft in the box. The notice below reads the text.
  useEffect(() => {
    if (!shown || !bindDraft || !onChange) return;
    bindDraft({ value, setValue: onChange });
    return () => bindDraft(null);
  }, [shown, bindDraft, onChange, value]);
  // An empty box means the draft is gone or sent. Typing and the chat's own
  // clear after a send both come through here.
  const changeValue = useCallback((next: string) => {
    if (next.trim() === "") endDraft?.();
    onChange?.(next);
  }, [endDraft, onChange]);
  const clearDraft = useCallback(() => changeValue(""), [changeValue]);

  if (!controls) return null;
  if (controls.remoteRunning) return <RemoteRunningNote controls={controls} />;
  if (!controls.canEdit) return <ReadOnlyNote />;
  const canSend = controls.ready && !controls.running;
  return (
    <>
      {controls.stopError ? (
        <p role="alert" className="mx-auto mb-2 w-full max-w-3xl px-4 text-sm text-danger">{controls.stopError}</p>
      ) : null}
      {controls.widgetDraft.source !== null && value.trim() !== "" ? (
        <div className="px-4">
          <WidgetDraftNotice source={controls.widgetDraft.source} draft={value} onClear={clearDraft} />
        </div>
      ) : null}
      <CopilotChatInput
        {...props}
        onChange={changeValue}
        isRunning={controls.running}
        onSubmitMessage={canSend ? props.onSubmitMessage : undefined}
        onStop={undefined}
        sendButton={controls.running ? StopButton : SendButton}
        addMenuButton={NO_ADD_MENU_SLOT}
        showDisclaimer={false}
      />
    </>
  );
}

const MESSAGE_VIEW_SLOT = asSlot<typeof CopilotChatMessageView>(ChatMessageList);
const COMPOSER_SLOT = asSlot<typeof CopilotChatInput>(ChatComposer);

export type ChatSessionModel = {
  id: string;
  /** Failed/declined tool-status rows from saved history, shown in the
   *  notification list. */
  initialToolStatuses: ToolStatusRow[];
  initialMcpApps?: Record<string, McpAppCall>;
  /** Pending REST approvals seed the live owner when this session opens. */
  initialApprovals: Approval[];
  /** Runtime notices saved on the assistant rows of the loaded history. */
  initialNotices?: RuntimeNoticeRow[];
  /** Saved running state from the session list. When it changes to true
   *  while this chat is open, another tab started a turn, and the host loads
   *  the session again to show it. */
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
  onTurnActivityChange?: (activity: LiveTurnActivity | null) => void;
  /** True while a turn runs: this tab streams it, or it runs on the server
   *  without this tab's stream. */
  onTurnRunningChange?: (isRunning: boolean) => void;
  onPendingApprovalsChange?: (count: number) => void;
};

type ChatHostProps = {
  session: ChatSessionModel;
  modelSelection: ChatModelSelection;
  usage: ChatUsageModel;
  /** Artifacts the user has checkboxed; read live at send time via a ref. */
  artifactIds: string[];
  projectFileIds?: string[];
  events: ChatEventHandlers;
};

// CopilotKit logs every failed run. A connection that this tab closes before
// the response arrives (React StrictMode, a session switch) fails with an
// AbortError, which is not an error. Log the rest as CopilotKit does.
function logCopilotKitError(event: { error: Error; code: string; context?: Record<string, unknown> }) {
  if (isAbortError(event.error)) return;
  console.error(`[CopilotKit] Error (${event.code}):`, event.error, event.context ?? {});
}

export function CopilotChatHost(props: ChatHostProps) {
  const { session, modelSelection, artifactIds, projectFileIds } = props;
  const sessionId = session.id;
  // Per-turn inputs (model, effort, checkboxed artifact ids) are held in refs the
  // agent reads at send time, so a change between turns is picked up WITHOUT
  // re-keying the agent. Re-keying would rebind CopilotKit to a fresh agent and
  // wipe the live transcript — and model/effort settle asynchronously (they
  // validate once /models resolves, possibly mid-turn), so keying on them risks
  // orphaning an in-flight run. Only `sessionId` (the threadId) fixes identity.
  const modelRef = useRef(modelSelection.model);
  const effortRef = useRef(modelSelection.effort);
  const artifactIdsRef = useRef(artifactIds);
  const stableProjectFileIds = projectFileIds ?? EMPTY_PROJECT_FILE_IDS;
  const projectFileIdsRef = useRef(stableProjectFileIds);
  useEffect(() => {
    modelRef.current = modelSelection.model;
    effortRef.current = modelSelection.effort;
    artifactIdsRef.current = artifactIds;
    projectFileIdsRef.current = stableProjectFileIds;
  }, [modelSelection.model, modelSelection.effort, artifactIds, stableProjectFileIds]);

  // One agent per session. The getters read their refs at send time, not
  // during render, so they are safe despite the react-hooks/refs heuristic.
  const agent = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      new DeepAgentsBrowserAgent({
        sessionId,
        getModel: () => modelRef.current,
        getEffort: () => effortRef.current,
        getArtifactIds: () => artifactIdsRef.current,
        getProjectFileIds: () => projectFileIdsRef.current
      }),
    [sessionId]
  );
  // The provider needs a stable registration. A new map would register again.
  const agents = useMemo(() => ({ [AGENT_ID]: agent }), [agent]);

  // Close this tab's stream when the host unmounts. The shell keys the host by
  // sessionId, so a session switch tears down this agent. The turn continues
  // on the server. Only Stop ends it early.
  useEffect(() => {
    return () => {
      agent.abortRun();
    };
  }, [agent]);

  return (
    <CopilotKitProvider
      agents__unsafe_dev_only={agents}
      renderActivityMessages={ACTIVITY_RENDERERS}
      enableInspector={false}
      showDevConsole={false}
      onError={logCopilotKitError}
    >
      <CopilotRenderSlots />
      <ChatSession {...props} agent={agent} />
    </CopilotKitProvider>
  );
}

function ChatSession({ session, modelSelection, usage, events, agent }: ChatHostProps & { agent: DeepAgentsBrowserAgent }) {
  const { id: sessionId, initialToolStatuses, initialMcpApps, initialApprovals, initialNotices, initialPrompt, isRunning: serverRunning = false, canEdit = true } = session;
  const { model, effort, models, showEffortSelector, onModelChange, onEffortChange } = modelSelection;
  const { onInitialPromptSent, onTurnSettled, onTurnRunningChange, onPendingApprovalsChange, onTurnActivityChange } = events;
  const { copilotkit } = useCopilotKit();

  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const {
    approvals, notices, mcpStatuses, toolStatuses, mcpApps,
    onApprovalDecision, syncServerState, addNotice, clearApprovals, dismissStatusRows
  } = useAguiCustomEvents(agent, { initialToolStatuses, initialApprovals, initialNotices, initialMcpApps });

  const connect = useCallback(() => copilotkit.connectAgent({ agent }), [agent, copilotkit]);
  const settleTurn = useCallback(() => {
    setStopError(null);
    onTurnSettled?.();
  }, [onTurnSettled]);
  const connection = useSessionConnection(agent, {
    sessionId,
    serverRunning,
    connect,
    onTurnSettled: settleTurn,
    onTurnEnded: clearApprovals,
    onSendRefused: addNotice,
    onRemoteSnapshot: syncServerState
  });
  const { ready, busy, running, remoteRunning, historyRestored, closeStream, pollNow, clearBusyRefusal } = connection;

  // Stop ends the turn on the server, so it also works for a turn that another
  // tab started. Then this tab's stream closes, and a poll confirms the end
  // and loads the final state. A failed request keeps the stream, so the turn
  // stays visible and the user can try again.
  const stopTurn = useCallback(async () => {
    setIsStopping(true);
    setStopError(null);
    try {
      await interruptSession(sessionId);
      closeStream();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // The server found no turn that it could stop. That alone does not
        // show that no turn runs: a new turn can start at the same time. Ask
        // the server. When no turn runs, the stream of this tab is stale, and
        // the composer stays locked while it is open: close it, and load the
        // final state through the connection. When a turn runs, or the read
        // fails, keep the stream and its Stop control.
        const serverTurnRuns = await readServerRunning(sessionId).catch(() => null);
        if (serverTurnRuns === false) closeStream();
        else pollNow();
      } else {
        setStopError(`The agent did not stop: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      setIsStopping(false);
    }
  }, [closeStream, pollNow, sessionId]);
  const onStop = useCallback(() => {
    void stopTurn();
  }, [stopTurn]);
  // Esc does what the Stop button does.
  useShortcut(SHORTCUTS.stop, onStop, canEdit && (running || remoteRunning) && !isStopping);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const focusComposer = useCallback(() => chatRef.current?.querySelector("textarea")?.focus(), []);
  useShortcut(SHORTCUTS.focusComposer, focusComposer, canEdit && !remoteRunning);
  // Put the cursor in the message box when the history is shown. Not on
  // narrow screens, where focus opens the on-screen keyboard, and not when the
  // user already focused something else.
  useEffect(() => {
    if (!historyRestored) return;
    const idle = document.activeElement === null || document.activeElement === document.body;
    if (idle && !window.matchMedia("(max-width: 767px)").matches) focusComposer();
  }, [focusComposer, historyRestored]);

  // A tool view can put a draft in the message box only while this tab can
  // send: it can edit, the history is shown, and no turn runs.
  const widgetDraft = useWidgetDraft(canEdit && !busy);
  const mcpAppView = useMemo<McpAppViewContext>(() => ({
    apps: mcpApps, sessionId, draft: widgetDraft.seam, canEdit, busy
  }), [mcpApps, sessionId, widgetDraft.seam, canEdit, busy]);
  const composerControls = useMemo<ComposerControls>(() => ({
    canEdit,
    ready,
    running,
    remoteRunning,
    messageRefused: connection.busyRefused,
    isStopping,
    stopError,
    onStop,
    widgetDraft: widgetDraft.composer
  }), [canEdit, ready, running, remoteRunning, connection.busyRefused, isStopping, stopError, onStop, widgetDraft.composer]);

  // Start an explicit project action once the history is shown and no turn
  // runs. While another turn runs, keep the action and start it when that
  // turn ends.
  const initialPromptSent = useRef(false);
  useEffect(() => {
    if (!initialPrompt || !canEdit || busy || initialPromptSent.current) return;
    initialPromptSent.current = true;
    agent.addMessage({ id: randomUUID(), role: "user", content: initialPrompt });
    agent.runAgent().then(
      () => onInitialPromptSent?.(),
      (error: unknown) => {
        // A busy session shows the other turn. Its end re-runs this effect.
        if (isSessionBusyError(error)) {
          initialPromptSent.current = false;
          // The action starts again by itself, so the user has nothing to resend.
          clearBusyRefusal();
          return;
        }
        onInitialPromptSent?.();
      }
    );
  }, [agent, busy, canEdit, clearBusyRefusal, initialPrompt, onInitialPromptSent]);

  // Lift the live turn-running + pending-approval signals to the shell so the
  // sidebar streaming dot and header attention dot track the AG-UI stream in
  // real time (the shell can't read this state directly — the agent instance
  // that the hooks subscribe to lives only in this host).
  const turnRunning = running || remoteRunning;
  useEffect(() => {
    onTurnRunningChange?.(turnRunning);
  }, [turnRunning, onTurnRunningChange]);
  useEffect(() => {
    onPendingApprovalsChange?.(approvals.length);
  }, [approvals.length, onPendingApprovalsChange]);
  useEffect(() => {
    onTurnActivityChange?.(connection.activity);
  }, [connection.activity, onTurnActivityChange]);

  return (
    <div ref={chatRef} className="flex min-h-0 flex-1 flex-col">
      {/* z-40 keeps popovers that hang off this bar (the context/cost tooltip,
          the model menu) above the chat body. */}
      <div className="relative z-40 flex items-center justify-end gap-3 border-b border-outline-variant bg-surface px-4 py-2">
        <ModelEffortSelector
          model={model ?? ""}
          effort={effort}
          models={models}
          showEffortSelector={showEffortSelector}
          disabled={running || remoteRunning}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
        />
        <ContextWindowMeter
          usedTokens={usage.contextTokens}
          contextWindow={usage.contextWindow}
          costUsd={usage.sessionCostUsd}
        />
      </div>
      {/* The server refused the connection, for example after the user lost
          access. Connecting again does not help, so sends stay closed. */}
      {connection.refusal ? (
        <div role="alert" className="border-b border-outline-variant bg-surface-container-low px-6 py-3 text-center text-sm">
          <p className="font-medium text-danger">This chat did not load</p>
          <p className="text-on-surface-variant">
            {connection.refusal.message ??
              `The server did not send this chat (HTTP ${connection.refusal.status ?? "error"}). Reload the page to try again.`}
          </p>
        </div>
      ) : null}
      {/* The backend caps the history at its newest messages. Say so: a
          clipped history looks the same as a complete one, and there is no
          way to load the older part. */}
      {connection.truncated ? (
        <div
          role="status"
          className="border-b border-outline-variant bg-surface-container-low px-6 py-2 text-center text-xs text-on-surface-variant"
        >
          Older messages in this session aren&apos;t shown. The most recent history is
          displayed below.
        </div>
      ) : null}
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
      <McpAppContext.Provider value={mcpAppView}>
        <ToolStatusContext.Provider value={toolStatuses}>
          <ComposerContext.Provider value={composerControls}>
            <CopilotChat
              agentId={AGENT_ID}
              threadId={sessionId}
              // chat-surface maps CopilotKit's theme variables to our tokens.
              // chat-markdown styles the tables, quotes, and code of replies.
              className="chat-surface chat-markdown min-h-0 flex-1"
              welcomeScreen={false}
              messageView={MESSAGE_VIEW_SLOT}
              input={COMPOSER_SLOT}
              onStop={onStop}
            />
          </ComposerContext.Provider>
        </ToolStatusContext.Provider>
      </McpAppContext.Provider>
    </div>
  );
}
