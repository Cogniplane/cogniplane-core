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
//
// The AG-UI `threadId` IS our session id (matches the backend, where thread_id
// === sessionId). Version note: CopilotKit 1.70.1 bundles @ag-ui/client@0.0.59 +
// rxjs@7.8.1 — the same versions the backend uses — so there is no Observable
// type-identity skew between this agent and CopilotKit's runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { HttpAgent, type Message as AGUIMessage, type RunAgentInput, type State } from "@ag-ui/client";
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
}

export class DeepAgentsBrowserAgent extends HttpAgent {
  private readonly sessionId: string;
  private readonly getModel?: () => string | undefined;
  private readonly getEffort?: () => EffortLevel | null | undefined;
  private readonly getArtifactIds?: () => string[];

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
  }

  protected requestInit(input: RunAgentInput): RequestInit {
    const model = this.getModel?.();
    const effort = this.getEffort?.();
    const artifactIds = this.getArtifactIds?.() ?? [];
    return {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({
        sessionId: this.sessionId,
        text: latestUserText(input),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(artifactIds.length ? { artifactIds } : {})
      }),
      signal: this.abortController.signal
    };
  }
}
