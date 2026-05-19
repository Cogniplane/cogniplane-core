"use client";
import {
  ModelsListResponseSchema,
  SessionImprovementContextSchema,
  type ModelsListResponse,
  type SessionImprovementContext as SessionImprovementContextType
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

type ErrorPayload = {
  message?: string;
  error?: string;
  details?: Array<{ path?: string; message?: string }>;
  scope?: string;
  limitType?: string;
  resource?: string;
};

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

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response = await fetch(buildApiUrl(path), {
    ...init,
    headers: createApiHeaders(init?.headers, init?.body),
    credentials: "include",
    cache: "no-store"
  });

  // Auto-refresh on 401 and retry once
  if (response.status === 401 && !DEV_USER_ID) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      response = await fetch(buildApiUrl(path), {
        ...init,
        headers: createApiHeaders(init?.headers, init?.body),
        credentials: "include",
        cache: "no-store"
      });
    }
  }

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function buildErrorMessage(response: Response): Promise<string> {
  let message = `Request failed: ${response.status}`;

  try {
    const payload = (await response.json()) as ErrorPayload;
    if (payload.message) {
      message =
        payload.limitType && payload.scope && payload.resource
          ? `${payload.message} (${payload.scope} ${payload.resource})`
          : payload.message;
    } else if (payload.details?.length) {
      message = payload.details
        .map((detail) =>
          detail.path ? `${detail.path}: ${detail.message ?? "Invalid value"}` : detail.message
        )
        .filter(Boolean)
        .join("\n");
    } else if (payload.error) {
      message = payload.error;
    }
  } catch {
    // Keep the status-based fallback when the response is not JSON.
  }

  return message;
}

export type SessionImprovementContext = SessionImprovementContextType;

export async function fetchSessionImprovementContext(
  sessionId: string
): Promise<SessionImprovementContext | null> {
  try {
    const raw = await request<unknown>(
      `/sessions/${encodeURIComponent(sessionId)}/improvement-context`
    );
    return parseResponse(SessionImprovementContextSchema, raw, "GET /sessions/:id/improvement-context");
  } catch {
    return null;
  }
}

export async function fetchModels(): Promise<ModelsListResponse> {
  const raw = await request<unknown>("/models");
  return parseResponse(ModelsListResponseSchema, raw, "GET /models");
}
