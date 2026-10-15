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
//      via `createApiHeaders`/`refreshAccessToken`, so auth logic stays centralized.
//   3. `connect` — load the session through `GET /sessions/:id/connect`: the
//      saved history, then the turn that runs on the server, replayed and live.
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
import { CogniplaneCustomEventSchema, type EffortLevel } from "@cogniplane/shared-types";

import { API_URL, createApiHeaders, refreshAccessToken } from "../api-client";

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID;

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

  constructor(config: DeepAgentsBrowserAgentConfig) {
    super({
      url: `${API_URL}/messages?format=agui`,
      fetch: authedAgentFetch,
      threadId: config.sessionId
    });
    this.sessionId = config.sessionId;
    this.getModel = config.getModel;
    this.getEffort = config.getEffort;
    this.getArtifactIds = config.getArtifactIds;
    this.getProjectFileIds = config.getProjectFileIds;
    this.subscribe(TRANSCRIPT_SUBSCRIBER);
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
    const detached = super.detachActiveRun();
    this.connection?.controller.abort();
    await detached;
  }

  protected connect(input: RunAgentInput): ReturnType<HttpAgent["run"]> {
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
    const model = this.getModel?.();
    const effort = this.getEffort?.();
    const artifactIds = this.getArtifactIds?.() ?? [];
    const projectFileIds = this.getProjectFileIds?.() ?? [];
    return {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({
        sessionId: this.sessionId,
        text: latestUserText(input),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(artifactIds.length ? { artifactIds } : {}),
        ...(projectFileIds.length ? { projectFileIds } : {})
      }),
      signal: this.abortController.signal
    };
  }
}
