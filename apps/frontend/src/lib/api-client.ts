"use client";
import {
  ModelsListResponseSchema,
  StepUpRefusalSchema,
  type ModelsListResponse,
  type StepUpAction
} from "@cogniplane/shared-types";

import { parseResponse } from "./validate-response";
// This module must never run server-side: it holds module-level auth state
// (accessTokenRef, tokenRefresher) that is pushed in by AuthProvider. In an
// SSR context that state would be shared across all requests in the same Node
// process. The "use client" directive prevents Next.js from importing this
// module in the server bundle.

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
// Different writers change the session token. A refresh renews it. A sign-in
// or an account change (a new password, a first second factor) starts a new
// session. A sign-out ends it. Without an order, the last answer wins: a late
// answer for an older session can replace a newer session, and a late
// /auth/refresh answer can set or delete the refresh cookie of a newer one.
// Two rules give the order:
//
// 1. The session-change gate. A call whose answer sets or deletes the refresh
//    cookie runs in changeSession and holds the gate while it runs. A refresh
//    waits until no session change runs before it sends the cookie, and a
//    session change waits for a refresh that is on the wire. Thus no refresh
//    sends a cookie that a running session change replaces. A refresh that
//    waited uses the token that the session change installed, and sends
//    nothing.
// 2. The session epoch. It changes when a new session starts in memory or the
//    session ends, not when a refresh renews the token. A writer reads it
//    before its call. If it is different after the call, the answer is for an
//    older session, and the writer must not apply it.
//
// Both waits have a time limit. A session change waits for a refresh on the
// wire at most REFRESH_ATTEMPTS × REFRESH_TIME_LIMIT_MS, and a sign-out does
// not wait: it stops the refresh. A stopped or timed-out refresh is aborted,
// so an answer that did not arrive cannot set its cookie later.

let accessTokenRef: string | null = null;
let sessionEpoch = 0;
/** Counts every token write, also a refresh. */
let tokenWrites = 0;
const tokenListeners = new Set<() => void>();

/**
 * Sends /auth/refresh once. It must give `signal` to its fetch and change
 * nothing after the signal aborts.
 */
export type TokenRefresher = (signal: AbortSignal) => Promise<string | null>;

let tokenRefresher: TokenRefresher | null = null;
/** The shared refresh. It can wait at the gate before it sends. */
let refreshPromise: Promise<string | null> | null = null;
/** The /auth/refresh request on the wire. */
let refreshOnWire: Promise<string | null> | null = null;
/** Stops the refresh on the wire (changeSession with `stopRefresh`). */
let refreshStop: AbortController | null = null;

/**
 * The time limit of one /auth/refresh attempt. When it passes, the attempt is
 * aborted and the refresh sends the cookie once more. The server can have
 * rotated the cookie while the answer did not arrive. For 60 seconds after a
 * rotation, the server answers the same cookie with the same result
 * (refresh-token-store.ts in the backend); after that, the old cookie is
 * reuse, which ends the session. The second attempt is sent inside that
 * window, and both attempts end within REFRESH_ATTEMPTS × this limit.
 */
export const REFRESH_TIME_LIMIT_MS = 15_000;
/** The first attempt, and one more after a time-out. */
export const REFRESH_ATTEMPTS = 2;
const TIMED_OUT = Symbol("refresh timed out");

/** Session changes that wait or run. */
let sessionChanges = 0;
/** Settles when no session change waits or runs. */
let gateOpened: Promise<void> = Promise.resolve();
let openGate: () => void = () => {};
/** Settles when the last session change in the queue ends. */
let lastSessionChange: Promise<void> = Promise.resolve();
/** True while the synchronous part of a session change's send runs. */
let sendStarting = false;
/** Callback exchanges can be cancelled by sign-out. */
const interruptibleSessionChanges = new Set<AbortController>();
/** The token that the last session change installed, and its epoch. */
let lastInstall: { token: string; epoch: number } | null = null;

/**
 * The time limit of a session-changing call. When it passes, the call is
 * aborted and the gate opens. If its answer had not arrived, its Set-Cookie
 * does not apply, so a late answer cannot replace a newer cookie. If the
 * headers had arrived (the body or the parse was late), the browser already
 * has the new cookie, and the next refresh uses it.
 */
export const SESSION_CHANGE_TIME_LIMIT_MS = 30_000;

/** A session-changing call that did not answer in its time limit. */
export class SessionChangeTimeoutError extends Error {
  constructor() {
    super("The session change did not answer in time.");
    this.name = "SessionChangeTimeoutError";
  }
}

function writeToken(token: string | null) {
  accessTokenRef = token;
  tokenWrites += 1;
  for (const listener of tokenListeners) listener();
}

/** Writes the token of the session in memory, as a refresh does. */
export function setAccessToken(token: string | null) {
  writeToken(token);
}

/**
 * Starts a new session in memory (a token) or ends it (null). From now on,
 * the answers of calls that started before are late. Returns the new epoch.
 */
export function replaceSession(token: string | null): number {
  sessionEpoch += 1;
  writeToken(token);
  return sessionEpoch;
}

export function getAccessToken(): string | null {
  return accessTokenRef;
}

export function getSessionEpoch(): number {
  return sessionEpoch;
}

/**
 * The session epoch in which a session change installed `token` before its
 * gate opened, or null when no session change installed it.
 */
export function installedSessionEpoch(token: string): number | null {
  return lastInstall?.token === token ? lastInstall.epoch : null;
}

/** Only for tests: opens the gate and forgets the token, the epoch and the refresh. */
export function __resetSessionGateForTests(): void {
  openGate();
  accessTokenRef = null;
  sessionEpoch = 0;
  tokenWrites = 0;
  tokenRefresher = null;
  refreshPromise = null;
  refreshOnWire = null;
  refreshStop = null;
  sessionChanges = 0;
  gateOpened = Promise.resolve();
  openGate = () => {};
  lastSessionChange = Promise.resolve();
  sendStarting = false;
  lastInstall = null;
  interruptibleSessionChanges.clear();
}

/** For useSyncExternalStore: the listener runs after each token write. */
export function subscribeAccessToken(listener: () => void): () => void {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
}

export function setTokenRefresher(refresher: TokenRefresher) {
  tokenRefresher = refresher;
}

/**
 * Sends /auth/refresh now, once for all callers. Only refreshAccessToken and
 * a holder of the gate call it.
 */
function sendRefresh(): Promise<string | null> {
  if (refreshOnWire) return refreshOnWire;
  const epoch = sessionEpoch;
  const stop = new AbortController();
  refreshStop = stop;
  refreshOnWire = (async () => {
    const refresher = tokenRefresher;
    if (!refresher) return null;
    let token: string | null = null;
    for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt += 1) {
      const answer = await attemptInTimeLimit(refresher, stop.signal);
      if (answer !== TIMED_OUT) {
        token = answer;
        break;
      }
    }
    // A sign-out stopped this refresh: its answer applies to nothing.
    if (stop.signal.aborted) return null;
    // A new session started, or the session ended, while this refresh ran.
    // Its answer is for the older session: keep the newer one.
    if (sessionEpoch !== epoch) return accessTokenRef;
    if (token) writeToken(token);
    return token;
  })().finally(() => {
    refreshOnWire = null;
    refreshStop = null;
  });
  return refreshOnWire;
}

/**
 * One refresh attempt in REFRESH_TIME_LIMIT_MS. Gives TIMED_OUT when the
 * limit passes, and null when `stop` aborts. Either way, the attempt's signal
 * aborts, and a later result of the refresher is ignored.
 */
async function attemptInTimeLimit(refresher: TokenRefresher, stop: AbortSignal): Promise<string | null | typeof TIMED_OUT> {
  if (stop.aborted) return null;
  const attempt = new AbortController();
  let end!: (result: null | typeof TIMED_OUT) => void;
  const ended = new Promise<null | typeof TIMED_OUT>((resolve) => {
    end = resolve;
  });
  const onStop = () => {
    attempt.abort(stop.reason);
    end(null);
  };
  stop.addEventListener("abort", onStop, { once: true });
  const timer = setTimeout(() => {
    attempt.abort(new DOMException("The refresh did not answer in time.", "TimeoutError"));
    end(TIMED_OUT);
  }, REFRESH_TIME_LIMIT_MS);
  try {
    const running = refresher(attempt.signal);
    // An answer after the limit is dropped; its failure is not unhandled.
    running.catch(() => undefined);
    return await Promise.race([running, ended]);
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", onStop);
  }
}

export function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = refreshAfterSessionChanges().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function refreshAfterSessionChanges(): Promise<string | null> {
  const writes = tokenWrites;
  while (sessionChanges > 0) await gateOpened;
  // A session change installed a token while this refresh waited (or ended
  // the session). Its cookie is new, so a refresh is not necessary.
  if (tokenWrites !== writes) return accessTokenRef;
  return sendRefresh();
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
 * `send` has SESSION_CHANGE_TIME_LIMIT_MS. When the limit passes, the signal
 * aborts, the call fails with SessionChangeTimeoutError, and the gate opens.
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
export async function changeSession<T>(
  send: (request: SessionChangeRequest, signal: AbortSignal) => Promise<T>,
  install?: (result: T) => string | null | undefined,
  options: { stopRefresh?: boolean; interruptible?: boolean } = {}
): Promise<T> {
  if (sendStarting) {
    throw new Error("changeSession was called inside a session change. Use the request that changeSession gives to send.");
  }
  if (sessionChanges === 0) {
    gateOpened = new Promise<void>((resolve) => {
      openGate = resolve;
    });
  }
  if (options.stopRefresh) {
    refreshStop?.abort();
    for (const interrupt of interruptibleSessionChanges) interrupt.abort(new Error("Sign-out cancelled the callback"));
  }
  const interrupt = options.interruptible ? new AbortController() : null;
  if (interrupt) interruptibleSessionChanges.add(interrupt);
  sessionChanges += 1;
  const before = lastSessionChange;
  let ended!: () => void;
  lastSessionChange = new Promise<void>((resolve) => {
    ended = resolve;
  });
  try {
    await before;
    // A refresh on the wire ends first: its answer can set or delete the
    // refresh cookie. A sign-out stops it.
    if (refreshOnWire) {
      if (options.stopRefresh) refreshStop?.abort();
      await refreshOnWire.catch(() => null);
    }
    const epoch = sessionEpoch;
    const result = await sendInTimeLimit(send, interrupt?.signal);
    const token = sessionEpoch === epoch ? install?.(result) : undefined;
    if (token !== undefined && sessionEpoch === epoch) {
      const installed = replaceSession(token);
      lastInstall = token === null ? null : { token, epoch: installed };
    }
    return result;
  } finally {
    if (interrupt) interruptibleSessionChanges.delete(interrupt);
    sessionChanges -= 1;
    if (sessionChanges === 0) openGate();
    ended();
  }
}

async function sendInTimeLimit<T>(send: (request: SessionChangeRequest, signal: AbortSignal) => Promise<T>, stop?: AbortSignal): Promise<T> {
  if (stop?.aborted) throw stop.reason;
  const limit = new AbortController();
  const request: SessionChangeRequest = (path, init) =>
    requestWithRefresh(path, { ...init, signal: eitherSignal(init?.signal, limit.signal) }, sendRefresh);
  let sending: Promise<T>;
  sendStarting = true;
  try {
    sending = send(request, limit.signal);
  } catch (error) {
    sending = Promise.reject(error);
  } finally {
    sendStarting = false;
  }
  // An answer after the limit is dropped; its failure is not unhandled.
  sending.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new SessionChangeTimeoutError();
      limit.abort(error);
      reject(error);
    }, SESSION_CHANGE_TIME_LIMIT_MS);
  });
  let onStop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onStop = () => { limit.abort(stop?.reason); reject(stop?.reason); };
    if (stop?.aborted) onStop();
    else stop?.addEventListener("abort", onStop, { once: true });
  });
  try {
    return await Promise.race([sending, expired, stopped]);
  } finally {
    if (onStop) stop?.removeEventListener("abort", onStop);
    clearTimeout(timer);
  }
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
  } else if (accessTokenRef) {
    headers.set("Authorization", `Bearer ${accessTokenRef}`);
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
