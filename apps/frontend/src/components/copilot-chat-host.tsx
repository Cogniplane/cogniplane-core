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
// card and plan through copilot-render-slots. A pending approval that names its
// tool call shows its decision controls in that call's card while the card is
// mounted, and in the notification list otherwise (chat-cards/tool-approvals.ts).
//
// A reply can also hold UI that the agent wrote in ```a2ui fences. CopilotKit's
// markdown transport reads the fences while the reply streams and renders them
// in the reply. The saved reply holds the same fences, so a reloaded chat shows
// the same UI. The agent sends the component schema and the fence guide of the
// provider with each message (see DeepAgentsBrowserAgent). A control in
// generated UI never starts a turn. An ArtifactCard in generated UI reads the
// artifact list that the shell gives in `artifactInventory`, filtered to this
// session. The list stays in the browser and never reaches the agent.
//
// Tool-transport UI can also go to the side panel next to the transcript
// (generative-ui-side-panel.tsx). It opens by itself for the first new view on
// a wide screen, unless the user closed it, and the user can open and close it.
// It shares the provider, the catalog and the ArtifactCard list of the chat.
// The panel reads its activities from the agent's messages; the transcript does
// not render them. It shows the latest view by default and names it. When the
// chat has several views, the user can pick an earlier one.
//
// Values that the user types into generated UI, in the chat or the panel, stay
// in this tab's sessionStorage for the signed-in person and the session, and
// come back after a reload (generative-ui-drafts.ts). A line above the message
// box lists the values that the next message sends
// (generative-ui-input-context.tsx). The "Use in reply" button of a Checklist
// puts its values in the message box as a draft, through the same seam as an
// MCP App widget. Only the Send button sends it.
//
// A chat with no messages offers a few starters (chat-starters.tsx). A starter
// puts a fixed draft in the message box through that seam too, and sends
// nothing. The list shows only while this tab could send, the box is empty,
// and no project prompt waits to start. The seam refuses a click when the box
// holds text or the chat cannot send.
//
// In local development, a developer can turn on CopilotKit's Inspector for this
// provider (lib/copilotkit-inspector.ts). It is off everywhere else.

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
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ComponentType,
  type CSSProperties
} from "react";
import { Loader2Icon, SquareIcon } from "lucide-react";
import { randomUUID, type Message as AGUIMessage } from "@ag-ui/client";
import type { Approval, EffortLevel, McpAppCall, Model } from "@cogniplane/shared-types";

import {
  DeepAgentsBrowserAgent,
  isGenerativeUiActionBlocked,
  isSessionBusyError
} from "../lib/agui/deep-agents-browser-agent";
import { useAguiCustomEvents } from "../lib/agui/use-agui-custom-events";
import { useInspectorOptIn } from "../lib/copilotkit-inspector";
import { readServerRunning } from "../lib/agui/use-remote-turn";
import { isAbortError, useSessionConnection } from "../lib/agui/use-session-connection";
import { ApiError } from "../lib/api-client";
import { cn } from "../lib/cn";
import { SHORTCUTS, useShortcut } from "../lib/keyboard-shortcuts";
import { interruptSession } from "../lib/session-api";
import type { LiveTurnActivity } from "./session-status.logic";
import { ArtifactCardProvider, type ArtifactCardInventory } from "./artifact-card";
import { useComposerDraft } from "./composer-drafts";
import { ChatScrollView } from "./chat-scroll-view";
import { ChatStarters } from "./chat-starters";
import type { ChatStarter } from "./chat-starters.logic";
import { ChecklistHostProvider, type ChecklistReplyState } from "./checklist-card";
import { AgentPlan, CopilotRenderSlots, ToolOutcomeContext, ToolTurnSettledContext, type ToolOutcome } from "./copilot-render-slots";
import { GENERATIVE_UI_CONFIG } from "./generative-ui-catalog";
import { useGenerativeUiDrafts } from "./generative-ui-drafts";
import { GenerativeUiInputContext, useGenerativeUiInputContext } from "./generative-ui-input-context";
import type { InputContext } from "./generative-ui-input-context.logic";
import type { DraftScope } from "./generative-ui-drafts.logic";
import { GenerativeUiSidePanel, SidePanelNotice, SidePanelToggle, transcriptRows, useSidePanel } from "./generative-ui-side-panel";
import { ModelEffortSelector } from "./model-effort-selector";
import { ContextWindowMeter } from "./context-window-meter";
import { ApprovalRowView } from "./chat-cards/approval-row";
import { approvalsByCall, MountedToolCards, ToolApprovalContext, useListedApprovals, type ToolApprovals } from "./chat-cards/tool-approvals";
import { MarkdownImage } from "./markdown-image";
import { SafeMarkdown } from "./safe-markdown";
import { watchReadingOverflow } from "../lib/reading-overflow";
import { WidgetDraftNotice, useWidgetDraft, type WidgetDraftComposer, type WidgetDraftSeam } from "./widget-draft";
import { Button } from "./ui/button";
import type { ApprovalRow, McpServerStatusRow, RuntimeNoticeRow, ToolStatusRow } from "./chat-cards/chat-cards.types";
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

function ChatCopyButton(props: ComponentProps<typeof CopilotChatAssistantMessage.CopyButton>) {
  // Keep the SDK arrow's spacing, with no arrow over the button's focus ring.
  const tooltipProps = { tooltipClassName: "[&_svg]:invisible" };
  return <CopilotChatAssistantMessage.CopyButton {...props} {...tooltipProps} />;
}

function ChatAssistantMessage(props: CopilotChatAssistantMessageProps) {
  const context = useContext(McpAppContext);
  const calls = props.message.toolCalls ?? [];
  const readingId = useId();
  useEffect(() => {
    const root = document.getElementById(readingId);
    if (root) return watchReadingOverflow(root);
  }, [readingId]);
  return (
    <>
      <CopilotChatAssistantMessage {...props} id={readingId} markdownRenderer={MARKDOWN_RENDERER}
        copyButton={ChatCopyButton} />
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
  let lastPrompt = messages.length - 1;
  while (lastPrompt >= 0 && messages[lastPrompt]!.role !== "user") lastPrompt -= 1;
  const returned = new Set(messages.flatMap((message) => message.role === "tool" ? [message.toolCallId] : []));
  // Starting a new turn cannot restart an unfinished call from an older turn.
  for (const message of messages.slice(0, Math.max(0, lastPrompt))) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (!returned.has(call.id)) outcomes.set(call.id, "interrupted");
    }
  }
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
  // The history is shown and no turn runs here or on the server, so a tool
  // call without a result did not return.
  const settled = composer !== null && composer.ready && !composer.running && !composer.remoteRunning;
  return (
    <ToolOutcomeContext.Provider value={outcomes}>
      <ToolTurnSettledContext.Provider value={settled}>
        {composer?.ready && messages.length === 0 ? (
          composer.onStarter ? <ChatStarters onPick={composer.onStarter} /> : (
            <p className="py-6 text-center text-sm text-on-surface-variant">
              {composer.canEdit ? "Ask me anything." : "No messages in this chat yet."}
            </p>
          )
        ) : null}
        <CopilotChatMessageView {...props} isRunning={composer?.running ?? props.isRunning} transformMessages={transcriptRows} assistantMessage={ASSISTANT_MESSAGE_SLOT} reasoningMessage={REASONING_MESSAGE_SLOT} />
        <div className="mt-3 empty:hidden">
          <AgentPlan agentId={AGENT_ID} />
        </div>
      </ToolTurnSettledContext.Provider>
    </ToolOutcomeContext.Provider>
  );
}

type ComposerControls = {
  canEdit: boolean;
  /** The latest session connection delivered its history, and the host
   *  plans no other one. */
  ready: boolean;
  refused: boolean;
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
  composerDraft: ReturnType<typeof useComposerDraft>;
  /** The generated-view values that the next message sends. */
  inputContext: InputContext;
  /** Puts a starter in the message box. Null when the empty chat offers none. */
  onStarter: ((starter: ChatStarter) => void) | null;
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
      title={controls.isStopping ? "Stopping…" : "Stop"}
      data-chat-stop="true"
      aria-disabled={controls.isStopping}
      onClick={() => { if (!controls.isStopping) controls.onStop(); }}
    >
      {controls.isStopping
        ? <Loader2Icon aria-hidden="true" className="size-[18px] animate-spin motion-reduce:animate-none" />
        : <SquareIcon aria-hidden="true" className="size-[18px] fill-current" />}
    </CopilotChatInput.SendButton>
  );
}

function SendButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <CopilotChatInput.SendButton {...props} />;
}

// The SDK names the message box only by its placeholder, which goes away
// with the first character. This slot gives it a persistent name and says
// how Enter works. It keeps the SDK box and its props, and adds the height
// budget of the box (MESSAGE_BOX_BUDGET).
function MessageTextArea({ className, ...props }: ComponentProps<typeof CopilotChatInput.TextArea>) {
  const hintId = useId();
  return (
    <>
      <CopilotChatInput.TextArea
        {...props}
        className={cn(className, MESSAGE_BOX_BUDGET)}
        aria-label="Message"
        aria-describedby={hintId}
      />
      <span id={hintId} className="sr-only">Enter sends the message. Shift+Enter starts a new line.</span>
    </>
  );
}
const MESSAGE_TEXT_AREA_SLOT = asSlot<typeof CopilotChatInput.TextArea>(MessageTextArea);

// The chat has no attachments or tool menu, so it shows no add button.
const NO_ADD_MENU_SLOT = asSlot<typeof CopilotChatInput.AddMenuButton>(() => null);

// The SDK draws the composer in an overlay with `pointer-events: none`, and
// only its own message pill sets `pointer-events: auto`. The property is
// inherited, so every block that the app puts in the composer slot sets
// `pointer-events-auto` on its own box, or sits in the scroll region of
// ChatComposer, which sets it. Without it, a mouse click goes through the
// block to the transcript behind it, and only the keyboard works.
function ReadOnlyNote() {
  return (
    <div role="note" className="pointer-events-auto border-t border-outline-variant bg-surface-container-low px-4 py-3 text-center text-sm text-on-surface-variant">
      You can read this shared session, but only project owners and editors can send messages.
    </div>
  );
}

function RemoteRunningNote({ controls }: { controls: ComposerControls }) {
  const { canEdit, messageRefused, isStopping, stopError, onStop } = controls;
  return (
    <div className="pointer-events-auto flex flex-col gap-2 border-t border-outline-variant bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-brand motion-reduce:animate-none" />
        <p role="status" className="min-w-0 flex-1">
          {messageRefused
            ? "Your message was not sent because the agent is still working on this chat. Send it again when the agent finishes."
            : canEdit
              ? "The agent is still working on this chat. You can send a message when it finishes."
              : "The agent is working on this chat. Only project owners and editors can send messages."}
        </p>
        {canEdit ? (
          <Button type="button" variant="outline" size="sm" data-chat-stop="true" aria-disabled={isStopping} onClick={() => { if (!isStopping) onStop(); }}>
            {isStopping ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
      </div>
      {stopError ? <p role="alert" className="text-danger">{stopError}</p> : null}
    </div>
  );
}

// The SDK pins the composer to the bottom of the chat area, and the composer
// grows up from there with no limit. In a short chat area, the blocks above
// the message box could then grow past the top of the area and hide behind the
// toolbar, with the Review summary and the Clear draft button out of reach. So
// the composer has a height budget, and the chat area sets it (`cqh`: see the
// wrapper of CopilotChat in ChatSession). The blocks above the message box
// share one scroll region, and it takes what the budget leaves.
//
// The budget is 60% of the chat area, but at least 17.25rem: the message box at
// one row and 128px for the draft decision and Review row. It never goes above the chat area.
// In an area under 17.25rem the composer covers all of it, and the transcript
// shows again when the user closes the blocks.
// A focused transcript control reserves its own height. The composer then
// gives up accessory space first, with a 148px floor for Message and Send.
//
// On a phone, the on-screen keyboard covers the bottom of the chat area, and
// the chat area keeps its size (the SDK reads the keyboard from
// `visualViewport`). ChatComposer leaves the height of the keyboard as an empty
// margin under the composer, and sets it in `--composer-keyboard-offset`. The
// margin is in the layout of the SDK overlay, and not a transform. So the
// composer sits above the keyboard, and the overlay is taller by the keyboard
// height. CopilotChat reads the height of the overlay and adds it to the space
// at the end of the transcript, so the last messages scroll above the
// composer, and not behind the keyboard. Both budgets use the part of the chat
// area that the keyboard leaves. With no keyboard the offset is 0px, and the
// budgets are the ones above. Tailwind reads class names as plain text, so
// write each class in full. `_` is a space.
const COMPOSER_BUDGET =
  "[--composer-budget:min(calc(100cqh_-_var(--composer-keyboard-offset,0px)),max(calc((100cqh_-_var(--composer-keyboard-offset,0px))_*_0.6),17.25rem),max(9.25rem,calc(100cqh_-_var(--composer-keyboard-offset,0px)_-_var(--transcript-focus-room,0px))))] max-h-(--composer-budget)";
// The message box scrolls after a share of the chat area, so a long draft
// cannot take the room of the region. The SDK sizes the box to five rows with
// an inline `max-height`, so a class needs `!` to cap it lower. The 52px floor
// is one row with its padding. Reserve 13.75rem for the 128px accessory
// floor, the scroll cue, the SDK action row, and the bottom gap.
const MESSAGE_BOX_BUDGET = "max-h-[max(min(calc((100cqh_-_var(--composer-keyboard-offset,0px))_*_0.25),calc(var(--composer-budget)_-_13.75rem)),52px)]!";
// Accessories retain up to 128px when room permits. Transcript focus can
// reduce that floor. All content remains reachable through the two scrollers.
const REGION_FLOOR = "min-h-[min(var(--composer-region-content,0px),8rem,max(0px,calc(var(--composer-budget)_-_9.25rem)))]";
const KEYBOARD_OFFSET_PROPERTY = "--composer-keyboard-offset";
const REGION_CONTENT_PROPERTY = "--composer-region-content";

type RegionMetrics = {
  moreAbove: boolean;
  /** The element holds more content below the part that shows. */
  moreBelow: boolean;
  /** The height of its content, in pixels, whatever its own height is. */
  content: number;
};
const NO_METRICS: RegionMetrics = { moreAbove: false, moreBelow: false, content: 0 };

/** The height of the blocks in the region, with their margins. The scroll
 *  height is not this: it is never under the height of the box, and the floor
 *  of the box comes from this number, so a floor that is too high would hold
 *  itself open. */
function contentHeight(region: HTMLElement): number {
  let height = 0;
  for (const child of region.children) {
    if (!(child instanceof HTMLElement)) continue;
    const style = getComputedStyle(child);
    height += child.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
  }
  return Math.ceil(height);
}

/** The scroll state of the region of the blocks. A touch screen draws no
 *  scrollbar until the user scrolls, so a separate cue shows while more content
 *  remains below. The content height sets the floor of the
 *  region: it never has to be taller than its content. */
function useRegionMetrics(element: HTMLElement | null): RegionMetrics {
  const [metrics, setMetrics] = useState(NO_METRICS);
  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const next = {
        moreAbove: element.scrollTop > 1,
        moreBelow: element.scrollHeight - element.scrollTop - element.clientHeight > 1,
        content: contentHeight(element)
      };
      setMetrics((previous) => previous.moreAbove === next.moreAbove && previous.moreBelow === next.moreBelow && previous.content === next.content ? previous : next);
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    // The toggle event of a details element does not bubble.
    element.addEventListener("toggle", measure, true);
    // The region changes size with the budget. Its blocks change the content
    // with no change of the region size.
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const mutation = new MutationObserver(measure);
    mutation.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      element.removeEventListener("scroll", measure);
      element.removeEventListener("toggle", measure, true);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [element]);
  return metrics;
}

/** Reserve only the chat area below the visible viewport at normal zoom.
 *  A viewport can pan without changing the SDK's keyboard-height prop. */
function useKeyboardOverlap(element: HTMLElement | null, keyboardHeight: number | undefined): number {
  const [overlap, setOverlap] = useState(0);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const chat = element?.closest('[data-testid="copilot-chat"]');
    const measure = () => {
      const reported = typeof keyboardHeight === "number" && Number.isFinite(keyboardHeight) ? Math.max(0, keyboardHeight) : 0;
      const bottom = chat?.getBoundingClientRect().bottom ?? window.innerHeight;
      const covered = viewport ? bottom - (viewport.offsetTop + viewport.height) : reported;
      setOverlap((viewport?.scale ?? 1) <= 1.01 ? Math.max(0, Math.min(reported, covered)) : 0);
    };
    measure();
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    const resize = new ResizeObserver(measure);
    if (chat) resize.observe(chat);
    return () => {
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      resize.disconnect();
    };
  }, [element, keyboardHeight]);
  return overlap;
}

/** The composer slot. A send needs the restored history and no turn in
 *  progress. While a turn streams, the send button stops it. Enter then does
 *  nothing, so a stray Enter cannot stop the agent. */
function ChatComposer(props: CopilotChatInputProps) {
  const controls = useContext(ComposerContext);
  const { keyboardHeight } = props;
  const value = controls?.composerDraft.value ?? "";
  const onChange = controls?.composerDraft.change;
  const sdkClearing = useRef(false);
  const submitting = useRef(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const [region, setRegion] = useState<HTMLDivElement | null>(null);
  const lift = useKeyboardOverlap(region, keyboardHeight);
  const { moreBelow, content: regionContent } = useRegionMetrics(region);
  const draft = controls?.widgetDraft;
  const shown = controls !== null && controls.canEdit && !controls.refused && !controls.remoteRunning;
  const bindDraft = draft?.bind;
  const endDraft = draft?.end;
  // The host owns the text of the box. Binding its value and setter
  // lets a tool view put a draft in the box. The notice below reads the text.
  // A layout effect binds in the commit that shows the text. So the starters
  // of an empty chat go away before the browser paints the text, and a click
  // never meets an older text.
  useLayoutEffect(() => {
    if (!shown || !bindDraft || !onChange) return;
    bindDraft({ value, setValue: onChange });
    return () => bindDraft(null);
  }, [shown, bindDraft, onChange, value]);
  // An empty edit deliberately discards the draft and its explanation.
  const changeValue = useCallback((next: string) => {
    if (next.trim() === "") endDraft?.();
    onChange?.(next);
  }, [endDraft, onChange]);
  // CopilotChatInput 1.85.0 calls onChange("") synchronously after submit.
  // Keep the draft until the server confirms it, including refused sends.
  const submit = (text: string) => {
    sdkClearing.current = true;
    if (submitting.current) return;
    submitting.current = true;
    controls?.composerDraft.beginSend();
    const release = () => {
      submitting.current = false;
      controls?.composerDraft.cancelUnstartedSend();
    };
    try {
      void Promise.resolve(props.onSubmitMessage?.(text)).finally(release);
    } catch (error) {
      release();
      throw error;
    }
  };
  const inputChange = (text: string) => {
    if (sdkClearing.current) { sdkClearing.current = false; return; }
    changeValue(text);
  };
  const clearDraft = useCallback(() => {
    changeValue("");
    composerRef.current?.querySelector("textarea")?.focus();
  }, [changeValue]);

  if (!controls) return null;
  if (controls.refused) return null;
  if (controls.remoteRunning) return <RemoteRunningNote controls={controls} />;
  if (!controls.canEdit) return <ReadOnlyNote />;
  const canSend = controls.ready && !controls.running;
  return (
    // This box is the composer for the keyboard: the blocks and the message box
    // sit in it, and its bottom margin holds the keyboard. The overlay around it
    // has no pointer events, so this box has none, and only the blocks and the
    // message box take them. This box scrolls, so it clips what it holds. The
    // top padding keeps the 4px focus ring of the message box visible.
    <div
      ref={composerRef}
      className={`flex flex-col scroll-py-2 overflow-y-auto overscroll-contain bg-surface pt-1 pb-2 ${COMPOSER_BUDGET}`}
      style={lift > 0 ? ({ marginBottom: `${lift}px`, [KEYBOARD_OFFSET_PROPERTY]: `${lift}px` } as CSSProperties) : undefined}
    >
      {/* The draft decision comes first. Expanded generated values share this
          scroll region. The message box stays below it. */}
      <div
        ref={setRegion}
        className={`pointer-events-auto mx-auto w-[calc(100%-2rem)] max-w-3xl scroll-py-2 overflow-y-auto overscroll-contain bg-surface empty:hidden ${REGION_FLOOR}`}
        style={{ [REGION_CONTENT_PROPERTY]: `${regionContent}px` } as CSSProperties}
      >
        {controls.stopError ? (
          <p role="alert" className="mb-1.5 text-sm text-danger">{controls.stopError}</p>
        ) : null}
        {controls.widgetDraft.source !== null && value.trim() !== "" ? (
          <WidgetDraftNotice source={controls.widgetDraft.source} origin={controls.widgetDraft.origin} draft={value} onClear={clearDraft} />
        ) : null}
        <GenerativeUiInputContext context={controls.inputContext} />
      </div>
      {moreBelow ? <p aria-hidden="true" data-testid="composer-scroll-cue" className="pointer-events-none mx-auto w-[calc(100%-2rem)] max-w-3xl shrink-0 border-t border-outline-variant bg-surface-container-low px-2 text-center text-xs leading-5 text-on-surface-variant">Scroll for more</p> : null}
      {controls.composerDraft.persistence !== "ok" ? (
        <p role="status" className="px-6 text-center text-xs text-on-surface-variant">This tab could not save your message draft. It will reset if you reload.</p>
      ) : null}
      {controls.composerDraft.uncertain ? (
        <p role="status" className="px-6 text-center text-xs text-on-surface-variant">This draft may already have been sent. Check the conversation before sending it again.</p>
      ) : null}
      <CopilotChatInput
        {...props}
        value={value}
        // The margin of the box above holds the keyboard. The SDK would move the
        // message box by the same height again, and only the message box.
        keyboardHeight={0}
        className="mx-auto w-[calc(100%-2rem)] shrink-0 [&>div:first-child]:px-0"
        textArea={MESSAGE_TEXT_AREA_SLOT}
        onChange={inputChange}
        isRunning={controls.running}
        onSubmitMessage={canSend && props.onSubmitMessage ? submit : undefined}
        onStop={undefined}
        sendButton={controls.running ? StopButton : SendButton}
        addMenuButton={NO_ADD_MENU_SLOT}
        showDisclaimer={false}
      />
    </div>
  );
}

/** The notification list. Its own component, so a tool card that mounts or
 *  unmounts renders this list again, not the transcript. */
function SessionNotifications({ approvals, toolApprovals, notices, mcpStatuses, toolStatuses, onDismiss }: {
  approvals: ApprovalRow[];
  toolApprovals: ToolApprovals;
  notices: RuntimeNoticeRow[];
  mcpStatuses: McpServerStatusRow[];
  toolStatuses: ToolStatusRow[];
  onDismiss: () => void;
}) {
  const listed = useListedApprovals(approvals, toolApprovals);
  const [region, setRegion] = useState<HTMLDivElement | null>(null);
  const { moreBelow, moreAbove } = useRegionMetrics(region);
  const count = listed.length + notices.length + mcpStatuses.length + toolStatuses.length;
  if (count === 0) return null;
  return (
    <div className="shrink-0 border-b border-outline-variant bg-surface px-4 py-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-on-surface-variant">
        <p>{count} session {count === 1 ? "notification" : "notifications"}{notices.some(row => row.level === "error") ? " · Error" : ""}{notices.some(row => row.level === "warning") ? " · Warning" : ""}</p>
      {notices.length + mcpStatuses.length + toolStatuses.length > 0 && (
        <button type="button" className="self-end rounded-sm text-sm text-on-surface-variant underline underline-offset-2 outline-none hover:text-on-surface focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={onDismiss}>
          Dismiss notifications
        </button>
      )}
      </div>
      <div ref={setRegion} role="region" aria-label="Session notifications" tabIndex={0} className="max-h-[30vh] scroll-py-2 space-y-2 overflow-y-auto overscroll-contain rounded-sm p-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [scrollbar-gutter:stable]">
      {listed.map((row) => (
        <ApprovalRowView key={row.rowId} row={row} onDecision={toolApprovals.onDecision} />
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
      {moreBelow || moreAbove ? <p className="mt-1 border-t border-outline-variant bg-surface pt-1 text-center text-xs text-on-surface-variant">{moreBelow ? "Scroll for more notifications" : "Scroll up for earlier notifications"}</p> : null}
    </div>
  );
}

// A short connection, such as the one after a turn ends, finishes before this
// delay, so the status does not flash on each turn.
const CONNECTION_STATUS_DELAY_MS = 400;

/** True once `flag` has stayed true for `delayMs`. False as soon as it is false. */
function useDelayedFlag(flag: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!flag) return;
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [flag, delayMs]);
  return flag && shown;
}

/** Says why the chat cannot send yet while it waits for its history. The
 *  shown messages stay, and so does the rest of the bar. It sits beside the
 *  model control (the Side panel button keeps the left edge). On a narrow bar
 *  it takes the first row, so the controls keep their rows. */
function ConnectionStatus({ restoredBefore }: { restoredBefore: boolean }) {
  return (
    <p role="status" className="flex min-w-0 items-center gap-1.5 text-xs text-on-surface-variant @max-md:order-first @max-md:basis-full">
      <Loader2Icon aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
      <span>{restoredBefore ? "Reconnecting…" : "Loading chat…"}</span>
    </p>
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
  onArtifactsChanged?: () => void;
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
  /** The session's artifacts and the preview action, for ArtifactCard. A new
   *  list renders the cards again. It keeps the agent and the transcript. */
  artifactInventory?: ArtifactCardInventory;
  /** The signed-in person. Composer text and values typed into generated UI stay
   *  in this tab's sessionStorage for this person and session. Without it,
   *  nothing is kept. */
  draftScope?: DraftScope;
  events: ChatEventHandlers;
};

// CopilotKit logs every failed run. A connection that this tab closes before
// the response arrives (React StrictMode, a session switch) fails with an
// AbortError, which is not an error. A run that generated UI started is
// refused on purpose, and the refusal is not an error either. Log the rest as
// CopilotKit does.
export function logCopilotKitError(event: { error: Error; code: string; context?: Record<string, unknown> }) {
  if (isAbortError(event.error) || isGenerativeUiActionBlocked(event.error)) return;
  console.error(`[CopilotKit] Error (${event.code}):`, event.error, event.context ?? {});
}

export function CopilotChatHost(props: ChatHostProps) {
  const identity = JSON.stringify([props.session.id, props.draftScope?.userId, props.draftScope?.tenantId]);
  return <ScopedChatHost key={identity} {...props} />;
}

function ScopedChatHost(props: ChatHostProps) {
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
  const inspectorOptIn = useInspectorOptIn();

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
      generativeUI={GENERATIVE_UI_CONFIG}
      enableInspector={inspectorOptIn}
      showDevConsole={false}
      onError={logCopilotKitError}
    >
      <CopilotRenderSlots />
      <ArtifactCardProvider sessionId={sessionId} inventory={props.artifactInventory}>
        <ChatSession {...props} agent={agent} />
      </ArtifactCardProvider>
    </CopilotKitProvider>
  );
}

function ChatSession({ session, modelSelection, usage, events, agent, draftScope }: ChatHostProps & { agent: DeepAgentsBrowserAgent }) {
  const { id: sessionId, initialToolStatuses, initialMcpApps, initialApprovals, initialNotices, initialPrompt, isRunning: serverRunning = false, canEdit = true } = session;
  const { model, effort, models, showEffortSelector, onModelChange, onEffortChange } = modelSelection;
  const { onInitialPromptSent, onTurnSettled, onArtifactsChanged, onTurnRunningChange, onPendingApprovalsChange, onTurnActivityChange } = events;
  const { copilotkit } = useCopilotKit();

  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const stopPending = useRef(false);
  const stopFocus = useRef<Element | null>(null);
  const sidePanelId = `side-panel-${useId()}`;
  // The row ref stays out of the object, so render reads of the panel state are not ref reads.
  const { rowRef: sidePanelRowRef, ...sidePanel } = useSidePanel(agent, AGENT_ID);
  const sidePanelToggleRef = useRef<HTMLButtonElement | null>(null);

  const {
    approvals, notices, mcpStatuses, toolStatuses, mcpApps,
    onApprovalDecision, syncServerState, addNotice, clearApprovals, dismissStatusRows
  } = useAguiCustomEvents(agent, { initialToolStatuses, initialApprovals, initialNotices, initialMcpApps });

  // The tool cards that show a decision. One registry for the life of the session's agent.
  const [toolCards] = useState(() => new MountedToolCards());
  const toolApprovals = useMemo<ToolApprovals>(() => ({
    cards: toolCards, byCall: approvalsByCall(approvals), onDecision: onApprovalDecision
  }), [toolCards, approvals, onApprovalDecision]);

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
  // The first history decides the wording: before it the chat loads, after it
  // the chat reconnects. A connection starts again after a lost stream, the
  // end of a remote turn, or a turn that another tab started.
  const [restoredBefore, setRestoredBefore] = useState(false);
  if (historyRestored && !restoredBefore) setRestoredBefore(true);
  // A refused connection is final and has its own alert. A local stream can
  // wait for a planned connection, but that is not a reconnection. While a
  // turn runs on the server, its note already says why the chat cannot send.
  const waitingForConnection = useDelayedFlag(
    !ready && !running && !remoteRunning && connection.refusal === null,
    CONNECTION_STATUS_DELAY_MS
  );
  const drafts = useGenerativeUiDrafts(agent, draftScope, historyRestored);
  const inputContext = useGenerativeUiInputContext(agent, drafts.restored);

  // A generated file can appear in a card before the reply ends. Reload its
  // stored metadata when the write finishes, without waiting for turn settlement.
  useEffect(() => {
    const subscription = agent.subscribe({
      onToolCallResultEvent({ event, messages }) {
        const call = messages.flatMap((message) => message.role === "assistant" ? message.toolCalls ?? [] : [])
          .find((tool) => tool.id === event.toolCallId);
        if (call?.function.name === "write_artifact") onArtifactsChanged?.();
      }
    });
    return () => subscription.unsubscribe();
  }, [agent, onArtifactsChanged]);

  // Stop ends the turn on the server, so it also works for a turn that another
  // tab started. Then this tab's stream closes, and a poll confirms the end
  // and loads the final state. A failed request keeps the stream, so the turn
  // stays visible and the user can try again.
  const stopTurn = useCallback(async () => {
    if (stopPending.current) return;
    stopPending.current = true;
    stopFocus.current = document.activeElement?.hasAttribute("data-chat-stop") ? document.activeElement : null;
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
      stopPending.current = false;
      setIsStopping(false);
    }
  }, [closeStream, pollNow, sessionId]);
  const onStop = useCallback(() => {
    void stopTurn();
  }, [stopTurn]);
  // Esc does what the Stop button does.
  useShortcut(SHORTCUTS.stop, onStop, canEdit && (running || remoteRunning) && !isStopping);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const focusComposer = useCallback(() => chatRef.current?.querySelector<HTMLTextAreaElement>('[data-testid="copilot-chat-textarea"]')?.focus(), []);
  useLayoutEffect(() => {
    if (stopError) stopFocus.current = null;
    if (!stopFocus.current || !ready || running || remoteRunning) return;
    if (document.activeElement === stopFocus.current || document.activeElement === document.body) focusComposer();
    stopFocus.current = null;
  }, [focusComposer, ready, remoteRunning, running, stopError]);
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
  const composerDraft = useComposerDraft(agent, draftScope, widgetDraft.composer);
  const mcpAppView = useMemo<McpAppViewContext>(() => ({
    apps: mcpApps, sessionId, draft: widgetDraft.seam, canEdit, busy
  }), [mcpApps, sessionId, widgetDraft.seam, canEdit, busy]);
  // A starter needs the state of a send and an empty box. A project prompt
  // that waits to start would fill the chat, so no starter shows then. The seam
  // checks the box and the state again when the user clicks.
  const pickStarter = useCallback((starter: ChatStarter) => {
    const placement = widgetDraft.seam.place({ text: starter.draft, source: starter.label, origin: "app-starter", append: false });
    // The button goes away with the list, so the focus goes to the box.
    if (placement === "placed") focusComposer();
  }, [focusComposer, widgetDraft.seam]);
  const startersOpen = canEdit && ready && !running && !remoteRunning && !initialPrompt && !widgetDraft.composer.occupied;
  const composerControls = useMemo<ComposerControls>(() => ({
    canEdit,
    ready,
    refused: connection.refusal !== null,
    running,
    remoteRunning,
    messageRefused: connection.busyRefused,
    isStopping,
    stopError,
    onStop,
    widgetDraft: widgetDraft.composer,
    composerDraft,
    inputContext,
    onStarter: startersOpen ? pickStarter : null
  }), [canEdit, ready, running, remoteRunning, connection.refusal, connection.busyRefused, isStopping, stopError, onStop, widgetDraft.composer, composerDraft, inputContext, startersOpen, pickStarter]);
  // The "Use in reply" button of a Checklist, in the chat or the panel. The
  // seam refuses too, so a click in the same frame as a state change places nothing.
  const checklistReplyState: ChecklistReplyState = !canEdit ? "read-only" : running || remoteRunning ? "busy" : busy ? "loading" : "ready";
  const checklistHost = useMemo(() => ({
    threadId: sessionId, replyState: checklistReplyState, place: widgetDraft.seam.place
  }), [sessionId, checklistReplyState, widgetDraft.seam.place]);

  // Start an explicit project action once the history is shown and no turn
  // runs. While another turn runs, keep the action and start it when that
  // turn ends.
  const initialPromptSent = useRef(false);
  useEffect(() => {
    if (!initialPrompt || !canEdit || busy || initialPromptSent.current) return;
    initialPromptSent.current = true;
    agent.addMessage({ id: randomUUID(), role: "user", content: initialPrompt });
    // Core adds the current catalog envelope before the browser agent builds
    // the tool guide, just as it does for a send from the composer.
    copilotkit.runAgent({ agent }).then(
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
  }, [agent, busy, canEdit, clearBusyRefusal, copilotkit, initialPrompt, onInitialPromptSent]);

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
    <div ref={chatRef} data-chat-host className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain scroll-py-2">
      {/* z-40 keeps this bar above the chat body. Its usage details and model
          menu open in portals. Below 28rem the model and usage controls share their own
          row. DOM and visual focus order stay the same. */}
      <div className="@container relative z-40 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-b border-outline-variant bg-surface px-4 py-2">
        <SidePanelToggle ref={sidePanelToggleRef} panelId={sidePanelId} open={sidePanel.open} hasView={sidePanel.state.hasView}
          waiting={sidePanel.waiting} onToggle={sidePanel.toggle} />
        {waitingForConnection ? <ConnectionStatus restoredBefore={restoredBefore} /> : null}
        <div className="flex min-w-0 max-w-full items-center justify-end gap-3 @max-md:basis-full">
        <ModelEffortSelector
          model={model ?? ""}
          effort={effort}
          models={models}
          showEffortSelector={showEffortSelector}
          disabled={!canEdit || connection.refusal !== null || running || remoteRunning}
          className="flex-1"
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
        />
        <ContextWindowMeter
          usedTokens={usage.contextTokens}
          contextWindow={usage.contextWindow}
          costUsd={usage.sessionCostUsd}
        />
        </div>
      </div>
      <SidePanelNotice panelId={sidePanelId} announcement={sidePanel.announcement} visible={sidePanel.waiting && !sidePanel.open}
        onShow={sidePanel.show} />
      {/* Edits in generated UI stay in this tab. Say so when the browser
          cannot keep them through a reload. */}
      {drafts.persistence !== "ok" ? (
        <p role="status" className="border-b border-outline-variant bg-surface-container-low px-6 py-2 text-center text-xs text-on-surface-variant">
          {drafts.persistence === "unavailable"
            ? "This browser blocks tab storage, so edits in generated views reset if you reload."
            : "Some edits in generated views could not be saved in this tab. They reset if you reload."}
        </p>
      ) : null}
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
      <SessionNotifications approvals={approvals} toolApprovals={toolApprovals} notices={notices} mcpStatuses={mcpStatuses}
        toolStatuses={toolStatuses} onDismiss={dismissStatusRows} />
      {/* The panel opens and closes beside the chat. This row never changes
          its children, so neither does the transcript. The panel measures
          this row to decide whether it fits beside the chat. */}
      <ChecklistHostProvider value={checklistHost}>
        {/* Keep Message and Send usable when the notice stack is tall. The
            host scrolls once its bands and this floor exceed its height. */}
        <div ref={sidePanelRowRef} data-chat-transcript-frame className="flex min-h-40 flex-1 has-[[data-chat-transcript]_:focus]:min-h-[max(10rem,var(--transcript-focus-floor,0px))]">
          {/* The size containment gives the composer's height budget (`cqh`
              in ChatComposer) the height of the chat area. The box gets its
              height from the flex row, never from its content. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col [container-type:size]">
            <McpAppContext.Provider value={mcpAppView}>
              <ToolStatusContext.Provider value={toolStatuses}>
                <ToolApprovalContext.Provider value={toolApprovals}>
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
                      scrollView={ChatScrollView}
                      onStop={onStop}
                    />
                  </ComposerContext.Provider>
                </ToolApprovalContext.Provider>
              </ToolStatusContext.Provider>
            </McpAppContext.Provider>
          </div>
          <GenerativeUiSidePanel panelId={sidePanelId} open={sidePanel.open} narrow={sidePanel.narrow} state={sidePanel.state}
            replyNumbers={!connection.truncated} focusRequest={sidePanel.focusRequest} toggleRef={sidePanelToggleRef}
            onClose={sidePanel.close} onSelect={sidePanel.select} onShowLatest={sidePanel.showLatest} />
        </div>
      </ChecklistHostProvider>
    </div>
  );
}
