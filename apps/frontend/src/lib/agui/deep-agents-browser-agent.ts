"use client";
// ─────────────────────────────────────────────────────────────────────────────
// DeepAgentsBrowserAgent connects CopilotKit to the backend AG-UI stream.
//
// A thin @ag-ui/client `HttpAgent` subclass that lets CopilotKit talk to our
// backend through the application request contract. The backend's
// `POST /messages?format=agui` endpoint takes our own `{ sessionId, text, model }`
// body (not AG-UI's standard `RunAgentInput`) and streams AG-UI `BaseEvent`s.
//
// HttpAgent already does the POST + SSE-parse + `verifyEvents` pipeline; we only
// override:
//   1. `requestInit` — emit our body shape (deriving `text` from the latest user
//      message AG-UI hands us), instead of the default `JSON.stringify(input)`.
//   2. the `fetch` fn — reuse the app's auth (dev-headers or JWT + 401 refresh)
//      via `createApiHeaders`/`refreshAccessToken`, so auth logic stays centralized,
//      and leave out earlier UI records that the PII policy blocked (see below).
//   3. `connect` — load the session through `GET /sessions/:id/connect`: the
//      saved history, then the turn that runs on the server, replayed and live.
//   4. `runAgent` — refuse a run that generated UI starts (see below).
//
// Generated UI never starts a turn. CopilotKit starts runs from generated UI in
// two ways, and `runAgent` refuses both: a user event (`forwardEvent`), and the
// follow-up that answers a `callRendererFunction` line of the model.
//
// The provider supplies its catalog envelope. Build the render_ui guide here
// and send only that bounded text and the fixed transport flag. The guide
// offers the chat and the side panel, when the host mounts it. The backend
// scans this text for PII before exposing its own tool. Markdown context from
// older hosts is still accepted without the tool flag.
//
// The guide also carries read-only records of earlier surfaces, with what the
// user typed in them. The user cannot clear a value in an older side-panel
// view, because the panel shows only the newest one. So when the PII policy
// blocks a message that carried records, later messages leave those records
// out, and the refusal asks the user to send again.
//
// A built-in subscriber keeps the transcript equal to what the backend saved
// (TRANSCRIPT_SUBSCRIBER). The AG-UI `threadId` IS our session id (matches the
// backend, where thread_id === sessionId). CopilotKit 1.78 pins @ag-ui/client
// 1.0.2 exactly; the workspace manifests must pin the same version, or this
// class extends a second HttpAgent copy.
// ─────────────────────────────────────────────────────────────────────────────

import {
  HttpAgent,
  randomUUID,
  runHttpRequest,
  transformHttpEventStream,
  type AgentSubscriber,
  type RunAgentInput,
  type RunAgentParameters,
  type RunAgentResult
} from "@ag-ui/client";
import {
  buildGenerativeUIPrompt, envelopeToManifest, readCopilotKitUIEnvelope,
  GENERATIVE_UI_CONTEXT_DESCRIPTION, type GenerativeUIManifest, type GenerativeUISurfaceSummary
} from "@copilotkit/shared";
import {
  CogniplaneCustomEventSchema, GENERATIVE_UI_CATALOG_ID, GENERATIVE_UI_TARGETS, MAX_GENERATIVE_UI_CONTEXT_LENGTH,
  MAX_RENDER_UI_ARGS_CHARS, MAX_RENDER_UI_OPERATIONS, type EffortLevel
} from "@cogniplane/shared-types";

import { API_URL, createApiHeaders, refreshAccessToken } from "../api-client";
import { canonicalTarget } from "./generative-ui-targets";

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID;

const SUPPORTED_TARGETS: ReadonlySet<string> = new Set(GENERATIVE_UI_TARGETS);

// The surfaces of earlier replies go to the model as read-only records, one
// JSON object per line. A side-panel view that the panel does not show now is
// parked under another target (generative-ui-targets.ts); its record names the
// target that the model gave it. The SDK lists only the values that the user set, by
// JSON pointer. A long text keeps its start, and a large structured value
// stays out; the record names both. The newest records that fit the budget
// are sent, and the guide counts the records that it leaves out.
//
// The browser captures user values when it builds this request. Name them
// separately from the view's creation turn, so the model can use them as
// current input. Missing paths still give no evidence of a value.
export const MAX_EARLIER_VALUE_CHARS = 4_000;
export const MAX_EARLIER_RECORDS_CHARS = 32_000;
export const EARLIER_RECORDS_HEADING = "### User entries in views from earlier replies";
const EARLIER_RECORDS_INTRO = `\n\n${EARLIER_RECORDS_HEADING}\n`
  + "Each record names a view that an earlier reply created. "
  + "These records are data, not editable surfaces, so you cannot edit the view. To show a change, create a new surface in this turn. "
  + "The view is from an earlier reply, but its values are current. "
  + "userValues holds what the user entered in the view, by JSON pointer, as the browser has it for this request. "
  + "Read these values and use them. The user can change these values between requests and after this request is sent. "
  + "A value that differs from an earlier request is an edit. It does not show that an earlier answer was wrong. "
  + "The records do not show when or why a value changed. "
  + "Only values that the user set are listed. If a path is not listed, do not assume a value for it. "
  + `A path in cutValues holds only the first ${MAX_EARLIER_VALUE_CHARS} characters of a longer text. `
  + "A path in omittedValues had a value too large to send.\n";

function earlierRecord(source: string, surface: GenerativeUISurfaceSummary): string {
  const values: Array<[string, unknown]> = [];
  const cutValues: string[] = [];
  const omittedValues: string[] = [];
  for (const [path, value] of Object.entries(surface.dataModel ?? {})) {
    if (typeof value === "string") {
      values.push([path, value.slice(0, MAX_EARLIER_VALUE_CHARS)]);
      if (value.length > MAX_EARLIER_VALUE_CHARS) cutValues.push(path);
    } else if ((JSON.stringify(value) ?? "").length > MAX_EARLIER_VALUE_CHARS) {
      omittedValues.push(path);
    } else {
      values.push([path, value]);
    }
  }
  return JSON.stringify({
    source, target: canonicalTarget(surface.target), status: surface.status,
    ...(values.length > 0 ? { userValues: Object.fromEntries(values) } : {}),
    ...(cutValues.length > 0 ? { cutValues } : {}),
    ...(omittedValues.length > 0 ? { omittedValues } : {}),
    rejected: surface.rejected
  });
}

function omissionNotes(tooLarge: number, blocked: number): string[] {
  return [
    ...(tooLarge > 0 ? [`Records left out to stay in the size limit: ${tooLarge}.`] : []),
    ...(blocked > 0 ? [`Records left out because organization policy blocked them: ${blocked}.`] : [])
  ];
}

/** The section of earlier records in at most `budget` characters, the
 *  records that it sends, and how many it leaves out. A record in `withheld`
 *  stays out. When even the notes do not fit, the section is larger than the
 *  budget, so the request limit refuses the send rather than hide the omission. */
function earlierRecords(surfaces: GenerativeUIManifest["surfaces"], budget: number, withheld: ReadonlySet<string>) {
  const all = Object.entries(surfaces).filter(([, surface]) => SUPPORTED_TARGETS.has(canonicalTarget(surface.target)))
    .map(([source, surface]) => earlierRecord(source, surface));
  const candidates = all.filter((record) => !withheld.has(record));
  const blocked = all.length - candidates.length;
  const lineCost = (lines: string[]) => lines.reduce((sum, line) => sum + line.length + 1, 0);
  let room = budget - EARLIER_RECORDS_INTRO.length - lineCost(omissionNotes(candidates.length, blocked));
  const records: string[] = [];
  for (const record of [...candidates].reverse()) {
    if (record.length + 1 > room) continue;
    room -= record.length + 1;
    records.unshift(record);
  }
  const tooLarge = candidates.length - records.length;
  const lines = [...records, ...omissionNotes(tooLarge, blocked)];
  return { text: lines.length > 0 ? EARLIER_RECORDS_INTRO + lines.join("\n") : "", records, tooLarge, blocked };
}

/** One earlier record as the next message sends it. */
export type EarlierRecordPreview = {
  source: string;
  target: string;
  userValues?: Record<string, unknown>;
  cutValues?: string[];
  omittedValues?: string[];
};

/** What the next message sends about earlier surfaces: the same records, from
 *  the same code, as `buildRenderUiGuide`. The preview uses the full record
 *  budget. The request uses less only when the guide leaves less room in the
 *  request limit, and a test keeps the catalog small enough for that not to
 *  happen. */
export function previewEarlierRecords(
  surfaces: GenerativeUIManifest["surfaces"],
  withheld: ReadonlySet<string> = new Set()
): { records: EarlierRecordPreview[]; tooLarge: number; blocked: number } {
  const earlier = earlierRecords(surfaces, MAX_EARLIER_RECORDS_CHARS, withheld);
  return {
    records: earlier.records.map((record) => JSON.parse(record) as EarlierRecordPreview),
    tooLarge: earlier.tooLarge,
    blocked: earlier.blocked
  };
}

/** The render_ui guide for this run, and the earlier records that it sends.
 *  It names only the targets that are mounted on the page and that the
 *  backend accepts, so a stray GenerativeUISurface elsewhere in the app is
 *  never offered to the model. The earlier records use the room that the
 *  request limit leaves, up to their own budget. */
export function buildRenderUiGuide(
  manifest: GenerativeUIManifest,
  withheld: ReadonlySet<string> = new Set()
): { text: string; records: string[] } {
  const targets = manifest.targets.filter((target) => SUPPORTED_TARGETS.has(target.id));
  const names = targets.map((target) => `"${target.id}"`).join(" or ");
  const guide = `${GENERATIVE_UI_CONTEXT_DESCRIPTION}\n${buildGenerativeUIPrompt({ ...manifest, targets, surfaces: {} })}`;
  const rules = `\n\nRender only to ${names}. A surface keeps the target of its createSurface. `
    + "Create a new surface in this turn before updating it. "
    + "You cannot change surfaces from earlier replies. "
    + `Use at most ${MAX_RENDER_UI_OPERATIONS} operations and ${MAX_RENDER_UI_ARGS_CHARS} characters per call.`;
  const budget = Math.min(MAX_EARLIER_RECORDS_CHARS, MAX_GENERATIVE_UI_CONTEXT_LENGTH - guide.length - rules.length);
  const earlier = earlierRecords(manifest.surfaces, budget, withheld);
  return { text: guide + earlier.text + rules, records: earlier.records };
}

/** Auth-aware fetch for an ABSOLUTE url (HttpAgent calls fetch(this.url, init)),
 *  mirroring `fetchWithAuthRetry` which only accepts relative paths. */
async function authedAgentFetch(url: string, init: RequestInit): Promise<Response> {
  const doFetch = () =>
    fetch(url, {
      ...init,
      headers: createApiHeaders(init.headers, init.body as BodyInit | null | undefined),
      credentials: "include",
      cache: "no-store"
    });
  let response = await doFetch();
  if (response.status === 401 && !DEV_USER_ID) {
    const token = await refreshAccessToken();
    if (token) response = await doFetch();
  }
  return response;
}

/** The latest user-authored text in the AG-UI message list (what the user just
 *  typed in CopilotChat). Our backend derives the turn prompt from this. */
function latestUserText(input: RunAgentInput): string {
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const message = input.messages[i];
    if (message?.role === "user") {
      return typeof message.content === "string" ? message.content : "";
    }
  }
  return "";
}

// The descriptions of the two context entries that the provider's markdown
// transport registers: the fence guide, and the component schema with the
// surfaces that exist. They are the only entries that reach the backend. The
// host test checks them against the real provider.
const GENERATIVE_UI_GUIDE_DESCRIPTION =
  "Generative UI markdown guide: how to write UI surfaces inside ```a2ui code fences in a normal markdown reply.";
const GENERATIVE_UI_SCHEMA_DESCRIPTION =
  "Generative UI component schema: the components, props, events, slots, functions, and targets that ```a2ui code fences can use, and the surfaces that already exist.";
const GENERATIVE_UI_CONTEXT_DESCRIPTIONS = [GENERATIVE_UI_GUIDE_DESCRIPTION, GENERATIVE_UI_SCHEMA_DESCRIPTION];

/** The generative-UI context is larger than the backend accepts. The error has
 *  the shape of an HTTP refusal, so the session connection refuses the send,
 *  removes the message that was not sent, and shows the message of the error. */
export class GenerativeUiContextTooLargeError extends Error {
  readonly status = 413;
  readonly payload: { error: string; message: string };

  constructor(length: number) {
    const message =
      `The interface description that this chat sends with each message is too large ` +
      `(${length} characters, and the limit is ${MAX_GENERATIVE_UI_CONTEXT_LENGTH}).`;
    super(message);
    this.name = "GenerativeUiContextTooLargeError";
    this.payload = { error: "generative_ui_context_too_large", message };
  }
}

/** The text of the two generative-UI context entries, each as its description
 *  and its value, or undefined when the run has neither. Every other context
 *  entry stays in the browser. The last entry of a description wins. */
export function composeGenerativeUiContext(context: RunAgentInput["context"] | undefined): string | undefined {
  const parts: string[] = [];
  for (const description of GENERATIVE_UI_CONTEXT_DESCRIPTIONS) {
    let value: string | undefined;
    for (const entry of context ?? []) {
      if (entry.description === description && entry.value.trim() !== "") value = entry.value;
    }
    if (value !== undefined) parts.push(`${description}\n${value}`);
  }
  if (parts.length === 0) return undefined;
  const text = parts.join("\n\n");
  if (text.length > MAX_GENERATIVE_UI_CONTEXT_LENGTH) throw new GenerativeUiContextTooLargeError(text.length);
  return text;
}

// The error code of the message route when the PII policy blocks the
// generative-UI context.
const GENERATIVE_UI_CONTEXT_BLOCKED = "generative_ui_context_blocked";

/** The PII policy blocked a message that carried records of earlier
 *  surfaces. The backend saved nothing, and later messages leave those
 *  records out. The error has the shape of an HTTP refusal, as the backend's
 *  own refusal does, with a message that tells the user what changed. */
export class GenerativeUiRecordsWithheldError extends Error {
  readonly status = 422;
  readonly payload: { error: string; message: string };

  constructor() {
    const message =
      "Organization policy blocked information from earlier generated views, such as values that you entered. " +
      "The chat no longer sends this information. Send your message again.";
    super(message);
    this.name = "GenerativeUiRecordsWithheldError";
    this.payload = { error: GENERATIVE_UI_CONTEXT_BLOCKED, message };
  }
}

/** A run that generated UI started. The run is refused, and nothing leaves
 *  the browser. */
export class GenerativeUiActionBlockedError extends Error {
  constructor() {
    super("Generated UI cannot start an agent turn.");
    this.name = "GenerativeUiActionBlockedError";
  }
}

export function isGenerativeUiActionBlocked(error: unknown): boolean {
  return error instanceof GenerativeUiActionBlockedError;
}

/** A copy of the chat agent cannot run or connect (see `clone`). */
export class AgentCopyRefusedError extends Error {
  constructor() {
    super("A copy of this chat agent cannot run. Send messages from the chat.");
    this.name = "AgentCopyRefusedError";
  }
}

function readField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** CopilotKit's `forwardEvent` sets `copilotkit.ui.metadata.extensions.copilotkit_action`
 *  in the forwarded props of the run that it starts for a user event. */
function carriesGenerativeUiAction(parameters: RunAgentParameters | undefined): boolean {
  const extensions = readField(readField(readField(readField(parameters?.forwardedProps, "copilotkit"), "ui"), "metadata"), "extensions");
  return typeof extensions === "object" && extensions !== null && Object.hasOwn(extensions, "copilotkit_action");
}

export type HttpFailure = { status: number; body: { error?: unknown; message?: unknown } };

/** The HTTP status and the parsed JSON body of a refused request, or null for
 *  any other error. @ag-ui/client's runHttpRequest puts `status` and `payload`
 *  on the error that it throws for a non-OK response. A body that is not a
 *  JSON object reads as empty. */
export function httpFailure(error: unknown): HttpFailure | null {
  if (!(error instanceof Error)) return null;
  const { status, payload } = error as Error & { status?: unknown; payload?: unknown };
  if (typeof status !== "number") return null;
  return { status, body: typeof payload === "object" && payload !== null ? payload : {} };
}

/** True when the backend refused the send because this session already runs a
 *  turn. The message route returns 429. A project execution lease reports the
 *  same code with 409. */
export function isSessionBusyError(error: unknown): boolean {
  const failure = httpFailure(error);
  return failure !== null && (failure.status === 429 || failure.status === 409) && failure.body.error === "session_busy";
}

// Marks the input of a connectAgent() run. The connect request sends no body,
// so this value stays in the browser.
const RECONNECT_PROP = "cogniplaneReconnect";

/** True for a run that loads the session through `GET /sessions/:id/connect`
 *  (connectAgent), false for a run that sends a message (runAgent). */
export function isReconnectRun(input: RunAgentInput): boolean {
  const props = input.forwardedProps as Record<string, unknown> | undefined;
  return props?.[RECONNECT_PROP] === true;
}

// Keeps the run's transcript equal to what the backend saved. Each handler
// returns a mutation, so @ag-ui/client folds it into the run's own message
// buffer: a direct setMessages() would be overwritten by the next event of
// the run. The buffer merge needs a new array.
const TRANSCRIPT_SUBSCRIBER: AgentSubscriber = {
  // A connection sends the complete saved history. @ag-ui/client 1.0 merges a
  // snapshot into the messages that it has: it updates messages with the same
  // id in place, adds the other ones at the end, and keeps reasoning that the
  // snapshot does not have. After a reconnect, a reply that grew would then
  // show its new parts after its old end, and a replayed reasoning block would
  // show twice. Start the merge from no messages: the snapshot then replaces
  // the transcript.
  onMessagesSnapshotEvent({ input }) {
    return isReconnectRun(input) ? { messages: [] } : undefined;
  },
  onCustomEvent({ event, messages, input }) {
    const parsed = CogniplaneCustomEventSchema.safeParse(event);
    if (!parsed.success) return undefined;
    const customEvent = parsed.data;
    if (customEvent.name === "user_message_persisted") {
      // The session can become "running" before its prompt row is saved, so
      // the history of a connection can lack the prompt of the turn that it
      // replays. Add the saved prompt before the reply events. The sending
      // tab already shows its own message.
      const { messageId, text } = customEvent.value;
      if (!isReconnectRun(input) || messages.some((message) => message.id === messageId)) return undefined;
      return { messages: [...messages, { id: messageId, role: "user" as const, content: text }] };
    }
    if (customEvent.name === "user_message_replaced") {
      // The PII policy changed the prompt before the backend saved and sent
      // it. Show the saved text in the newest user message. The position
      // finds it: the optimistic message of the sending tab has a browser id,
      // not the saved one.
      const { text } = customEvent.value;
      let index = messages.length - 1;
      while (index >= 0 && messages[index]?.role !== "user") index -= 1;
      const current = messages[index];
      if (current?.role !== "user" || current.content === text) return undefined;
      const patched = messages.slice();
      patched[index] = { ...current, content: text };
      return { messages: patched };
    }
    return undefined;
  }
};

export interface DeepAgentsBrowserAgentConfig {
  /** Backend session id; also the AG-UI threadId. */
  sessionId: string;
  // Per-turn inputs are read via getters at send time (not captured at
  // construction) so model/effort/artifact-selection changes between turns are
  // picked up WITHOUT reconstructing the agent — a reconstruction would rebind
  // CopilotKit to a fresh agent and wipe the live in-memory transcript, and
  // model/effort can settle asynchronously (localStorage → validated once
  // /models resolves) even mid-turn. Only `sessionId` (the threadId) is fixed.
  /** Model id (e.g. "zai/glm-4.7"); returns undefined → backend default. */
  getModel?: () => string | undefined;
  /** Reasoning effort; returns null/undefined → backend default for the model. */
  getEffort?: () => EffortLevel | null | undefined;
  /** Artifacts the user has checkboxed for the next turn. */
  getArtifactIds?: () => string[];
  /** Project files the user selected for extra attention on the next turn. */
  getProjectFileIds?: () => string[];
}

export class DeepAgentsBrowserAgent extends HttpAgent {
  private readonly sessionId: string;
  private readonly getModel?: () => string | undefined;
  private readonly getEffort?: () => EffortLevel | null | undefined;
  private readonly getArtifactIds?: () => string[];
  private readonly getProjectFileIds?: () => string[];
  /** The latest session connection: its run, and the controller of its fetch. */
  private connection: { runId: string; controller: AbortController } | null = null;
  /** True for a copy that `clone` made. */
  private isCopy = false;
  /** The earlier UI records that each message request carries. */
  private readonly sentRecords = new WeakMap<RequestInit, string[]>();
  /** Earlier UI records that the PII policy blocked. Later messages leave them out. */
  private readonly withheldRecords = new Set<string>();

  constructor(config: DeepAgentsBrowserAgentConfig) {
    super({
      url: `${API_URL}/messages?format=agui`,
      threadId: config.sessionId
    });
    this.sessionId = config.sessionId;
    this.getModel = config.getModel;
    this.getEffort = config.getEffort;
    this.getArtifactIds = config.getArtifactIds;
    this.getProjectFileIds = config.getProjectFileIds;
    this.fetch = async (url, init) => this.withholdBlockedRecords(init, await authedAgentFetch(url, init));
    this.subscribe(TRANSCRIPT_SUBSCRIBER);
  }

  /** The earlier records that the next message of this chat sends, with the
   *  records that the PII policy blocked left out. The composer shows it. */
  previewEarlierRecords(surfaces: GenerativeUIManifest["surfaces"]): ReturnType<typeof previewEarlierRecords> {
    return previewEarlierRecords(surfaces, this.withheldRecords);
  }

  /** The message route checks the generative-UI context against the chat PII
   *  policy, and refuses a blocked message before it saves anything. When the
   *  blocked request carried earlier UI records, later messages leave those
   *  records out. A record that the user changes after that is new data, and
   *  the next message sends it. A refusal with no records keeps the backend's
   *  message: there is nothing that this tab can leave out. */
  private async withholdBlockedRecords(init: RequestInit, response: Response): Promise<Response> {
    const records = this.sentRecords.get(init);
    if (response.status !== 422 || !records) return response;
    const body: unknown = await response.clone().json().catch(() => undefined);
    if (readField(body, "error") !== GENERATIVE_UI_CONTEXT_BLOCKED) return response;
    for (const record of records) this.withheldRecords.add(record);
    throw new GenerativeUiRecordsWithheldError();
  }

  /** Loads the session: the saved history, then the turn that runs on the
   *  server, if any. CopilotChat calls this through CopilotKit's connection
   *  path when it mounts, and the chat host calls it the same way to load the
   *  session again. CopilotKit waits until the previous run ends before it
   *  calls this.
   *
   *  The caller owns `abortController`, and its abort closes this connection.
   *  A message run replaces that controller, so the connection fetch uses its
   *  own controller. A new connection, Stop (abortRun), and CopilotKit's detach
   *  also close it: @ag-ui/client does not cancel a fetch that waits for its
   *  response headers. */
  connectAgent(parameters?: RunAgentParameters, subscriber?: AgentSubscriber): Promise<RunAgentResult> {
    if (this.isCopy) return Promise.reject(new AgentCopyRefusedError());
    this.connection?.controller.abort();
    const runId = parameters?.runId ?? randomUUID();
    const controller = new AbortController();
    this.connection = { runId, controller };
    const caller = this.abortController.signal;
    if (caller.aborted) {
      controller.abort();
      return Promise.resolve({ result: undefined, newMessages: [] });
    }
    const close = () => controller.abort();
    caller.addEventListener("abort", close, { once: true });
    return super.connectAgent(
      { ...parameters, runId, forwardedProps: { ...parameters?.forwardedProps, [RECONNECT_PROP]: true } },
      subscriber
    ).finally(() => caller.removeEventListener("abort", close));
  }

  /** Refuses the two runs that CopilotKit starts for generated UI. The error
   *  does not reach the backend, and the host does not log it.
   *
   *  1. A user event of a control. CopilotKit adds a user message that states
   *     the event, then runs the agent. Remove that last user message. An
   *     earlier user message stays.
   *  2. The follow-up for a function that the model called with
   *     `callRendererFunction`. CopilotKit adds a hidden developer message with
   *     the answer, then runs the agent, also when the call failed. A message
   *     that the user sends always ends with the user message, and the backend
   *     history has no developer message, so a run that ends with one is this
   *     follow-up. The answer stays: CopilotKit reads it to run each call once. */
  async runAgent(parameters?: Parameters<HttpAgent["runAgent"]>[0], subscriber?: AgentSubscriber): Promise<RunAgentResult> {
    if (this.isCopy) throw new AgentCopyRefusedError();
    if (carriesGenerativeUiAction(parameters)) {
      if (this.messages.at(-1)?.role === "user") this.setMessages(this.messages.slice(0, -1));
      throw new GenerativeUiActionBlockedError();
    }
    if (this.messages.at(-1)?.role === "developer") throw new GenerativeUiActionBlockedError();
    return super.runAgent(parameters, subscriber);
  }

  /** True when this tab closed the connection of a connect run: its caller, a
   *  newer connection, Stop, or CopilotKit's detach. Such a run did not lose
   *  its stream. */
  isClosedByClient(input: RunAgentInput): boolean {
    return this.connection?.runId !== input.runId || this.connection.controller.signal.aborted;
  }

  /** Closes this tab's stream: the running message or the connection. The
   *  turn continues on the server. Only an interrupt request stops it. */
  abortRun(): void {
    this.connection?.controller.abort();
    super.abortRun();
  }

  /** CopilotKit detaches the active run before a new run or connection. A
   *  detached connection must also close its fetch, or its stream stays
   *  open until the server ends it. */
  async detachActiveRun(): Promise<void> {
    if (this.isCopy) throw new AgentCopyRefusedError();
    const detached = super.detachActiveRun();
    this.connection?.controller.abort();
    await detached;
  }

  /** CopilotKit copies an agent to run it outside its chat: the playground of
   *  the development Inspector, and suggestions, which this app does not use.
   *  The @ag-ui/client copy has no session id, so its run would post a
   *  message with no session. It also keeps the subscribers of this agent, so
   *  a change to the copy would reach this chat: the side panel reads
   *  `messages` from the subscriber event. So the copy has no subscribers,
   *  and it refuses to run or connect before a request. CopilotKit's
   *  runAgent calls detachActiveRun before it tells the chat that a run
   *  started, so the refusal there keeps the active thread of this chat. */
  clone(): DeepAgentsBrowserAgent {
    const copy = super.clone() as DeepAgentsBrowserAgent;
    copy.subscribers = [];
    copy.isCopy = true;
    return copy;
  }

  protected connect(input: RunAgentInput): ReturnType<HttpAgent["run"]> {
    if (this.isCopy) throw new AgentCopyRefusedError();
    const url = `${API_URL}/sessions/${encodeURIComponent(this.sessionId)}/connect`;
    // @ag-ui/client calls this after an await in connectAgent. A newer
    // connection can start in that time; this one then must not fetch.
    const current = this.connection;
    const signal = current?.runId === input.runId ? current.controller.signal : AbortSignal.abort();
    return transformHttpEventStream(
      runHttpRequest(() => this.fetch(url, {
        method: "GET",
        headers: { ...this.headers, Accept: "text/event-stream" },
        signal
      })),
      this.debugLogger
    );
  }

  protected requestInit(input: RunAgentInput): RequestInit {
    if (this.isCopy) throw new AgentCopyRefusedError();
    const model = this.getModel?.();
    const effort = this.getEffort?.();
    const artifactIds = this.getArtifactIds?.() ?? [];
    const projectFileIds = this.getProjectFileIds?.() ?? [];
    const envelope = readCopilotKitUIEnvelope(input.forwardedProps);
    const manifest = envelope ? envelopeToManifest(envelope) : undefined;
    const guide = manifest?.catalogId === GENERATIVE_UI_CATALOG_ID ? buildRenderUiGuide(manifest, this.withheldRecords) : undefined;
    const toolContext = guide?.text;
    if (toolContext && toolContext.length > MAX_GENERATIVE_UI_CONTEXT_LENGTH) {
      throw new GenerativeUiContextTooLargeError(toolContext.length);
    }
    const generativeUiContext = toolContext ?? composeGenerativeUiContext(input.context);
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({
        sessionId: this.sessionId,
        text: latestUserText(input),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(artifactIds.length ? { artifactIds } : {}),
        ...(projectFileIds.length ? { projectFileIds } : {}),
        ...(generativeUiContext ? { generativeUiContext } : {}),
        ...(toolContext ? { generativeUiTransport: "tool" } : {})
      }),
      signal: this.abortController.signal
    };
    // HttpAgent passes this object to `fetch`, which reads the records on a refusal.
    if (guide && guide.records.length > 0) this.sentRecords.set(init, guide.records);
    return init;
  }
}
