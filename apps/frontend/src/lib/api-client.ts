"use client";
import {
  ModelsListResponseSchema,
  type ModelsListResponse
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

let accessTokenRef: string | null = null;
let refreshPromise: Promise<string | null> | null = null;
let tokenRefresher: (() => Promise<string | null>) | null = null;

export function setAccessToken(token: string | null) {
  accessTokenRef = token;
}

export function setTokenRefresher(refresher: () => Promise<string | null>) {
  tokenRefresher = refresher;
}

export async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    if (!tokenRefresher) return null;
    const token = await tokenRefresher();
    if (token) {
      accessTokenRef = token;
    }
    return token;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
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
export async function fetchWithAuthRetry(path: string, init?: RequestInit): Promise<Response> {
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
    const newToken = await refreshAccessToken();
    if (newToken) {
      response = await doFetch();
    }
  }

  return response;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithAuthRetry(path, init);

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
