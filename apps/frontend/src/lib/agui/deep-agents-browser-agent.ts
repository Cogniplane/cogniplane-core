"use client";
// ─────────────────────────────────────────────────────────────────────────────
// Track B — DeepAgentsBrowserAgent (CopilotKit frontend swap, slice A)
//
// A thin @ag-ui/client `HttpAgent` subclass that lets CopilotKit talk to our
// EXISTING backend without changing the verified contract. The backend's
// `POST /messages?format=agui` endpoint takes our own `{ sessionId, text, model }`
// body (not AG-UI's standard `RunAgentInput`) and streams AG-UI `BaseEvent`s.
//
// HttpAgent already does the POST + SSE-parse + `verifyEvents` pipeline; we only
// override:
//   1. `requestInit` — emit our body shape (deriving `text` from the latest user
//      message AG-UI hands us), instead of the default `JSON.stringify(input)`.
//   2. the `fetch` fn — reuse the app's auth (dev-headers or JWT + 401 refresh)
//      via `createApiHeaders`/`refreshAccessToken`, so auth logic stays centralized.
//   3. `connect` — attach to the turn that runs on the server through
//      `GET /sessions/:id/events`, so a returning tab shows it live.
//
// The AG-UI `threadId` IS our session id (matches the backend, where thread_id
// === sessionId). Version note: CopilotKit 1.70.1 bundles @ag-ui/client@0.0.59 +
// rxjs@7.8.1 — the same versions the backend uses — so there is no Observable
// type-identity skew between this agent and CopilotKit's runtime.
// ─────────────────────────────────────────────────────────────────────────────

import {
  HttpAgent,
  runHttpRequest,
  transformHttpEventStream,
  type AgentSubscriber,
  type Message as AGUIMessage,
  type RunAgentInput,
  type RunAgentParameters,
  type RunAgentResult,
  type State
} from "@ag-ui/client";
import type { EffortLevel } from "@cogniplane/shared-types";

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

/** True when the backend refused the send because this session already runs a
 *  turn. @ag-ui/client's runHttpRequest puts the HTTP status and the parsed
 *  JSON body on the error it throws. The message route returns 429. A project
 *  execution lease reports the same code with 409. */
export function isSessionBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { status, payload } = error as Error & { status?: unknown; payload?: unknown };
  if (status !== 429 && status !== 409) return false;
  return typeof payload === "object" && payload !== null &&
    (payload as { error?: unknown }).error === "session_busy";
}

// Marks the input of a connectAgent() run. The connect request sends no body,
// so this value stays in the browser.
const RECONNECT_PROP = "cogniplaneReconnect";

/** True for a run that attaches to a turn on the server (connectAgent), false
 *  for a run that sends a message (runAgent). */
export function isReconnectRun(input: RunAgentInput): boolean {
  const props = input.forwardedProps as Record<string, unknown> | undefined;
  return props?.[RECONNECT_PROP] === true;
}

// `after` is the last event sequence that this tab has. 0 asks for the full
// turn. A partial replay does not work here: @ag-ui/client rejects a run that
// does not start with RUN_STARTED.
const REPLAY_FROM_START = 0;

function emptyEventStream(): Response {
  return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** 204 (no running turn) and 409 `replay_gap` (the event log no longer holds
 *  the full turn) are expected results. Change them to a stream without events,
 *  so the run ends without an error and without a terminal event. The caller
 *  then reads the saved turn state. Other responses stay as they are. */
async function withExpectedEndsAsEmpty(response: Response): Promise<Response> {
  if (response.status === 204) return emptyEventStream();
  if (response.status !== 409) return response;
  const text = await response.text();
  try {
    if ((JSON.parse(text) as { error?: unknown }).error === "replay_gap") return emptyEventStream();
  } catch {
    // Not JSON. Report it as an HTTP error below.
  }
  // runHttpRequest reads the body again to build its error.
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export interface DeepAgentsBrowserAgentConfig {
  /** Backend session id; also the AG-UI threadId. */
  sessionId: string;
  /** Persisted history to seed CopilotChat with on mount (reload / session
   *  switch). CopilotKit renders `agent.messages`, which HttpAgent's base
   *  constructor populates from `initialMessages`. */
  initialMessages?: AGUIMessage[];
  /** Persisted agent state to seed on mount — currently the plan pane (`plan`),
   *  which rides agent state (STATE_DELTA `/plan`) rather than the message list,
   *  so reload has to seed it here or the plan pane stays blank. */
  initialState?: State;
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

  constructor(config: DeepAgentsBrowserAgentConfig) {
    super({
      url: `${API_URL}/messages?format=agui`,
      fetch: authedAgentFetch,
      threadId: config.sessionId,
      ...(config.initialMessages ? { initialMessages: config.initialMessages } : {}),
      ...(config.initialState ? { initialState: config.initialState } : {})
    });
    this.sessionId = config.sessionId;
    this.getModel = config.getModel;
    this.getEffort = config.getEffort;
    this.getArtifactIds = config.getArtifactIds;
    this.getProjectFileIds = config.getProjectFileIds;
  }

  /** Attach to the turn that runs on the server. The replayed events go
   *  through the same pipeline and subscribers as a sent message. The caller
   *  must leave the saved in-progress reply out of the transcript first, or
   *  the replay shows it twice. Do not use CopilotKit's `core.connectAgent`:
   *  it clears the messages and the state first. */
  connectAgent(parameters?: RunAgentParameters, subscriber?: AgentSubscriber): Promise<RunAgentResult> {
    // AbstractAgent.connectAgent keeps the current controller, and an earlier
    // abortRun() can have aborted it. HttpAgent.runAgent also sets a new one.
    this.abortController = new AbortController();
    return super.connectAgent(
      { ...parameters, forwardedProps: { ...parameters?.forwardedProps, [RECONNECT_PROP]: true } },
      subscriber
    );
  }

  protected connect(_input: RunAgentInput): ReturnType<HttpAgent["run"]> {
    const url = `${API_URL}/sessions/${encodeURIComponent(this.sessionId)}/events?after=${REPLAY_FROM_START}`;
    const init: RequestInit = {
      method: "GET",
      headers: { ...this.headers, Accept: "text/event-stream" },
      signal: this.abortController.signal
    };
    return transformHttpEventStream(
      runHttpRequest(async () => withExpectedEndsAsEmpty(await this.fetch(url, init))),
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
