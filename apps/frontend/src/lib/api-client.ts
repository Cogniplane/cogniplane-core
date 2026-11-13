"use client";
import {
  ModelsListResponseSchema,
  StepUpRefusalSchema,
  type ModelsListResponse,
  type StepUpAction
} from "@cogniplane/shared-types";

import { SessionCoordinator, type TokenRefresher } from "./session-coordinator";
import { parseResponse } from "./validate-response";
// This module must never run server-side: it holds module-level auth state
// (the session coordinator, with the token and the refresher that AuthProvider
// pushes in). In an SSR context that state would be shared across all
// requests in the same Node process. The "use client" directive prevents
// Next.js from importing this module in the server bundle.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID;
const DEV_TENANT_ID = process.env.NEXT_PUBLIC_DEV_TENANT_ID ?? "local-dev-tenant";
// Shared secret for dev-headers mode. It ships in the browser bundle, so it is
// not a secret from a user of this UI — it only stops an unrelated client that
// can reach the backend port from asserting an identity.
const DEV_AUTH_KEY = process.env.NEXT_PUBLIC_DEV_AUTH_KEY;

type ErrorPayload = {
  message?: string;
  code?: string;
  error?: string;
  details?: Array<{ path?: string; message?: string }>;
  scope?: string;
  limitType?: string;
  resource?: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly method: string;
  readonly path: string;

  constructor(input: {
    status: number;
    code?: string;
    method: string;
    path: string;
    message: string;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.status = input.status;
    this.code = input.code;
    this.method = input.method;
    this.path = input.path;
  }
}

/**
 * Asks the user for a fresh proof for one step-up action, then calls `resend`
 * with the step-up token and returns its response. Rejects when the user
 * cancels. StepUpHost (components/step-up-host.tsx) sets it.
 */
export type StepUpPrompt = (action: StepUpAction, resend: (stepUpToken: string) => Promise<Response>) => Promise<Response>;

/** The user cancelled the confirmation, so the request was not sent again. */
export class StepUpCancelledError extends Error {
  constructor() {
    super("step_up_cancelled");
    this.name = "StepUpCancelledError";
  }
}

let stepUpPrompt: StepUpPrompt | null = null;
// One prompt at a time: a second refused request waits for the first.
let stepUpQueue: Promise<unknown> = Promise.resolve();

export function setStepUpPrompt(prompt: StepUpPrompt | null) {
  stepUpPrompt = prompt;
}

// ---- The session token, in order ----
//
// session-coordinator.ts owns the session token, the refresh and the
// session-change gate, and explains their order. This module makes its one
// instance and gives the exports below. Import them from here.

const session = new SessionCoordinator();

export {
  REFRESH_ATTEMPTS,
  REFRESH_TIME_LIMIT_MS,
  SESSION_CHANGE_TIME_LIMIT_MS,
  SessionChangeTimeoutError,
  type TokenRefresher
} from "./session-coordinator";

/** Writes the token of the session in memory, as a refresh does. */
export function setAccessToken(token: string | null) {
  session.writeToken(token);
}

/**
 * Starts a new session in memory (a token) or ends it (null). From now on,
 * the answers of calls that started before are late. Returns the new epoch.
 */
export function replaceSession(token: string | null): number {
  return session.replaceSession(token);
}

export function getAccessToken(): string | null {
  return session.getToken();
}

export function getSessionEpoch(): number {
  return session.getEpoch();
}

/**
 * The session epoch in which a session change installed `token` before its
 * gate opened, or null when no session change installed it.
 */
export function installedSessionEpoch(token: string): number | null {
  return session.installedEpoch(token);
}

/**
 * Only for tests: opens the gate and forgets the token, the epoch and the
 * refresh. Token listeners stay. Work from before the reset changes nothing
 * after it.
 */
export function __resetSessionGateForTests(): void {
  session.resetForTests();
}

/** For useSyncExternalStore: the listener runs after each token write. */
export function subscribeAccessToken(listener: () => void): () => void {
  return session.subscribe(listener);
}

export function setTokenRefresher(refresher: TokenRefresher) {
  session.setRefresher(refresher);
}

/**
 * The shared refresh. It waits until no session change runs, and all callers
 * get the same promise until it settles.
 */
export function refreshAccessToken(): Promise<string | null> {
  return session.requestRefresh();
}

/** `request` for the calls in changeSession: it holds the gate. */
export type SessionChangeRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

/**
 * Runs `send`, a call whose answer sets or deletes the refresh cookie, while
 * it holds the session-change gate. Session changes run one at a time.
 *
 * Inside `send`, use the `request` that it receives, not the module `request`:
 * a 401 then refreshes at once. The module `request` would wait for the gate
 * that this call holds. This refresh is safe: a 401 answer changed no session,
 * and no other session change runs. A plain fetch in `send` must use the
 * `signal` that it receives.
 *
 * `send` has SESSION_CHANGE_TIME_LIMIT_MS. The limit starts when `send`
 * starts, after the wait for the changes ahead and for a refresh on the wire.
 * When the limit passes, the signal aborts, the call fails with
 * SessionChangeTimeoutError, and the gate opens.
 *
 * Do not call changeSession inside `send`: the inner call would wait for the
 * gate that the outer call holds. A call in the synchronous part of `send`
 * fails at once. A call after an await waits until the time limit ends the
 * outer call.
 *
 * `install` reads the token of the answer: a token for a new session, null
 * when the session ended, undefined to keep the token in memory (the caller
 * installs it, or the answer has no session). The token goes in before the
 * gate opens, so a refresh that waited uses it. It does not go in when the
 * epoch changed during the call (for example, a sign-out came first).
 *
 * `interruptible` lets sign-out cancel a callback, including a pending body.
 * Other session changes retain their existing deadline and queue order.
 *
 * `stopRefresh` is for a sign-out: it aborts the refresh on the wire instead
 * of waiting for its answer, so a hung refresh cannot delay the sign-out. An
 * aborted answer that had not arrived sets no cookie. If its headers had
 * arrived, the browser has its cookie, and the sign-out sends that one and
 * ends it. Thus the browser keeps no cookie that the sign-out did not end.
 */
export function changeSession<T>(
  send: (request: SessionChangeRequest, signal: AbortSignal) => Promise<T>,
  install?: (result: T) => string | null | undefined,
  options: { stopRefresh?: boolean; interruptible?: boolean } = {}
): Promise<T> {
  return session.changeSession((signal, refreshNow) => send(gatedRequest(signal, refreshNow), signal), install, options);
}

/**
 * The `request` of a session change: its fetch aborts at the time limit or
 * when the caller's signal aborts. A 401 refreshes without the gate, the
 * request goes once more when the refresh gives a token, and no step-up
 * prompt opens.
 */
function gatedRequest(limit: AbortSignal, refreshNow: () => Promise<string | null>): SessionChangeRequest {
  return (path, init) => requestWithRefresh(path, { ...init, signal: eitherSignal(init?.signal, limit) }, refreshNow);
}

/** A signal that aborts when the caller's signal or the time limit aborts. */
function eitherSignal(caller: AbortSignal | null | undefined, limit: AbortSignal): AbortSignal {
  if (!caller) return limit;
  const either = new AbortController();
  for (const signal of [caller, limit]) {
    if (signal.aborted) {
      either.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => either.abort(signal.reason), { once: true });
  }
  return either.signal;
}

export function buildApiUrl(path: string): string {
  return `${API_URL}${path}`;
}

export function createApiHeaders(init?: HeadersInit, body?: BodyInit | null): Headers {
  const headers = new Headers(init);

  // In dev-headers mode (NEXT_PUBLIC_DEV_USER_ID is set), use the old header-based auth
  if (DEV_USER_ID) {
    headers.set("X-User-Id", DEV_USER_ID);
    headers.set("X-Tenant-Id", DEV_TENANT_ID);
    // Required by the backend when dev-headers runs on a non-loopback bind.
    if (DEV_AUTH_KEY) headers.set("X-Dev-Auth-Key", DEV_AUTH_KEY);
  } else {
    const token = session.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  if (body != null && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  } else {
    headers.delete("Content-Type");
  }

  return headers;
}

// Returns the raw Response (not parsed JSON) so SSE callers can stream the body.
export function fetchWithAuthRetry(path: string, init?: RequestInit): Promise<Response> {
  return fetchWithRefresh(path, init, refreshAccessToken);
}

async function fetchWithRefresh(
  path: string,
  init: RequestInit | undefined,
  refresh: () => Promise<string | null>
): Promise<Response> {
  const doFetch = () =>
    fetch(buildApiUrl(path), {
      ...init,
      headers: createApiHeaders(init?.headers, init?.body),
      credentials: "include",
      cache: "no-store"
    });

  let response = await doFetch();

  // Auto-refresh on 401 and retry once
  if (response.status === 401 && !DEV_USER_ID) {
    const newToken = await refresh();
    if (newToken) {
      response = await doFetch();
    }
  }

  return response;
}

/**
 * A 403 that names a step-up action (a sensitive change, such as a setting
 * that changes where the organization's data goes): the backend refused the
 * request before any change. The prompt asks for a fresh proof and sends the
 * same request once more, with the single-use token in X-Step-Up. A request
 * that already carried a token is not sent again: its caller handles step-up.
 */
async function retryWithStepUp(path: string, init: RequestInit | undefined, refused: Response): Promise<Response | null> {
  const prompt = stepUpPrompt;
  if (!prompt || new Headers(init?.headers).has("X-Step-Up")) return null;
  let body: unknown;
  try {
    body = await refused.clone().json();
  } catch {
    return null;
  }
  const refusal = StepUpRefusalSchema.safeParse(body);
  if (!refusal.success || refusal.data.error !== "step_up_required") return null;
  const resend = (stepUpToken: string) => {
    const headers = new Headers(init?.headers);
    headers.set("X-Step-Up", stepUpToken);
    return fetchWithAuthRetry(path, { ...init, headers });
  };
  const turn = stepUpQueue.then(() => prompt(refusal.data.action, resend));
  stepUpQueue = turn.catch(() => undefined);
  try {
    return await turn;
  } catch (error) {
    if (error instanceof StepUpCancelledError) {
      throw new ApiError({
        status: 403,
        code: "step_up_cancelled",
        method: init?.method ?? "GET",
        path,
        message: "Not saved. You did not confirm the change."
      });
    }
    throw error;
  }
}

export function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestWithRefresh<T>(path, init, refreshAccessToken, true);
}

async function requestWithRefresh<T>(
  path: string,
  init: RequestInit | undefined,
  refresh: () => Promise<string | null>,
  // Only the module `request` asks for step-up. A call in changeSession holds
  // the session gate and must not wait for a person.
  askStepUp = false
): Promise<T> {
  let response = await fetchWithRefresh(path, init, refresh);

  if (askStepUp && response.status === 403) {
    response = (await retryWithStepUp(path, init, response)) ?? response;
  }

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw new ApiError({
      status: response.status,
      code: payload.code ?? payload.error,
      method: init?.method ?? "GET",
      path,
      message: formatErrorMessage(response.status, payload)
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

// A 404 returns undefined so callers can distinguish it from a successful JSON null.
export async function requestOptionalOn404<T>(path: string, init?: RequestInit): Promise<T | undefined> {
  try {
    return await request<T>(path, init);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

async function readErrorPayload(response: Response): Promise<ErrorPayload> {
  try {
    const payload: unknown = await response.json();
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as ErrorPayload)
      : {};
  } catch {
    return {};
  }
}

function formatErrorMessage(status: number, payload: ErrorPayload): string {
  if (payload.message) {
    return payload.limitType && payload.scope && payload.resource
      ? `${payload.message} (${payload.scope} ${payload.resource})`
      : payload.message;
  }
  if (payload.details?.length) {
    return payload.details
      .map((detail) =>
        detail.path ? `${detail.path}: ${detail.message ?? "Invalid value"}` : detail.message
      )
      .filter(Boolean)
      .join("\n");
  }
  if (payload.error) return payload.error;
  return `Request failed: ${status}`;
}

export async function buildErrorMessage(response: Response): Promise<string> {
  return formatErrorMessage(response.status, await readErrorPayload(response));
}

export async function fetchModels(): Promise<ModelsListResponse> {
  const raw = await request<unknown>("/models");
  return parseResponse(ModelsListResponseSchema, raw, "GET /models");
}
