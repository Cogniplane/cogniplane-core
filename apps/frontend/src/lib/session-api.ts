import {
  ApprovalsListResponseSchema,
  SessionEnvelopeSchema,
  SessionsListResponseSchema,
  SessionCapabilitiesSchema,
  SESSION_TRASH_RETENTION_DAYS,
  type SessionCapabilitiesUpdate
} from "@cogniplane/shared-types";

import { request } from "./api-client";
import { parseResponse } from "./validate-response";

import type { Approval, ApprovalDecisionRequest, Session } from "@cogniplane/shared-types";

const CHAT_SESSION_PURPOSES = "normal,skill_improvement";
export type SessionList = { sessions: Session[]; trashRetentionDays: number; nextCursor?: string | null };
export type SessionListOptions = {
  cursor?: string;
  search?: string;
  ids?: string[];
  personalOnly?: boolean;
  signal?: AbortSignal;
};

export async function getSessionCapabilities(sessionId: string) {
  return parseResponse(SessionCapabilitiesSchema,
    await request<unknown>(`/sessions/${encodeURIComponent(sessionId)}/capabilities`), "GET /sessions/:id/capabilities");
}

export async function updateSessionCapabilities(sessionId: string, input: SessionCapabilitiesUpdate) {
  return parseResponse(SessionCapabilitiesSchema,
    await request<unknown>(`/sessions/${encodeURIComponent(sessionId)}/capabilities`, {
      method: "PUT", body: JSON.stringify(input)
    }), "PUT /sessions/:id/capabilities");
}

async function fetchSessionPage(status: "active" | "archived", options: SessionListOptions): Promise<SessionList> {
  const params = new URLSearchParams({ purposes: options.personalOnly ? "normal" : CHAT_SESSION_PURPOSES, limit: "50" });
  if (status === "archived") params.set("status", status);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.search) params.set("search", options.search);
  if (options.ids) { params.set("ids", options.ids.join(",")); params.set("limit", "100"); }
  if (options.personalOnly) params.set("personalOnly", "true");
  const raw = await request<unknown>(`/sessions?${params}`, { signal: options.signal });
  const response = parseResponse(SessionsListResponseSchema, raw, "GET /sessions");
  return { sessions: response.sessions, nextCursor: response.nextCursor ?? null,
    trashRetentionDays: response.trashRetentionDays ?? SESSION_TRASH_RETENTION_DAYS };
}

export function listSessions(options: SessionListOptions = {}): Promise<SessionList> {
  return fetchSessionPage("active", options);
}

export function listArchivedSessions(options: SessionListOptions = {}): Promise<SessionList> {
  return fetchSessionPage("archived", options);
}

export async function archiveSession(sessionId: string): Promise<Session> {
  const raw = await request<unknown>(`/sessions/${sessionId}/archive`, { method: "POST" });
  return parseResponse(SessionEnvelopeSchema, raw, "POST /sessions/:id/archive").session;
}

export async function restoreSession(sessionId: string): Promise<Session> {
  const raw = await request<unknown>(`/sessions/${sessionId}/restore`, { method: "POST" });
  return parseResponse(SessionEnvelopeSchema, raw, "POST /sessions/:id/restore").session;
}

export async function createSession(name?: string): Promise<Session> {
  const raw = await request<unknown>("/sessions", {
    method: "POST",
    body: JSON.stringify(name ? { name } : {})
  });
  return parseResponse(SessionEnvelopeSchema, raw, "POST /sessions").session;
}

export async function renameSession(sessionId: string, name: string): Promise<Session> {
  const raw = await request<unknown>(`/sessions/${sessionId}/name`, {
    method: "PUT",
    body: JSON.stringify({ name })
  });
  return parseResponse(SessionEnvelopeSchema, raw, "PUT /sessions/:id/name").session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await request<void>(`/sessions/${sessionId}`, {
    method: "DELETE"
  });
}

export async function interruptSession(sessionId: string): Promise<void> {
  await request(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST" });
}

export async function listApprovals(sessionId: string, signal?: AbortSignal): Promise<Approval[]> {
  const raw = await request<unknown>(`/sessions/${sessionId}/approvals`, { signal });
  return parseResponse(ApprovalsListResponseSchema, raw, "GET /sessions/:id/approvals").approvals;
}

export async function resolveApproval(
  approvalId: string,
  decision: ApprovalDecisionRequest["decision"],
  rememberForTurn = false
): Promise<void> {
  const body: ApprovalDecisionRequest = rememberForTurn
    ? { decision, rememberForTurn: true }
    : { decision };
  await request(`/approvals/${approvalId}/decision`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}
