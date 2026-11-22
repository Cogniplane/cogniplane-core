import {
  ApprovalsListResponseSchema,
  SessionEnvelopeSchema,
  SessionsListResponseSchema,
  SessionCapabilitiesSchema,
  SESSION_TRASH_RETENTION_DAYS,
  type SessionCapabilitiesUpdate
} from "@cogniplane/shared-types";

import { requestJson, requestEmpty } from "./api-client";

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
  return await requestJson(`/sessions/${encodeURIComponent(sessionId)}/capabilities`, SessionCapabilitiesSchema);
}

export async function updateSessionCapabilities(sessionId: string, input: SessionCapabilitiesUpdate) {
  return await requestJson(`/sessions/${encodeURIComponent(sessionId)}/capabilities`, SessionCapabilitiesSchema, {
      method: "PUT", body: JSON.stringify(input)
    });
}

async function fetchSessionPage(status: "active" | "archived", options: SessionListOptions): Promise<SessionList> {
  const params = new URLSearchParams({ purposes: options.personalOnly ? "normal" : CHAT_SESSION_PURPOSES, limit: "50" });
  if (status === "archived") params.set("status", status);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.search) params.set("search", options.search);
  if (options.ids) { params.set("ids", options.ids.join(",")); params.set("limit", "100"); }
  if (options.personalOnly) params.set("personalOnly", "true");
  const response = await requestJson(`/sessions?${params}`, SessionsListResponseSchema, { signal: options.signal });
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
  return (await requestJson(`/sessions/${sessionId}/archive`, SessionEnvelopeSchema, { method: "POST" })).session;
}

export async function restoreSession(sessionId: string): Promise<Session> {
  return (await requestJson(`/sessions/${sessionId}/restore`, SessionEnvelopeSchema, { method: "POST" })).session;
}

export async function createSession(name?: string): Promise<Session> {
  return (await requestJson("/sessions", SessionEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify(name ? { name } : {})
  })).session;
}

export async function renameSession(sessionId: string, name: string): Promise<Session> {
  return (await requestJson(`/sessions/${sessionId}/name`, SessionEnvelopeSchema, {
    method: "PUT",
    body: JSON.stringify({ name })
  })).session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await requestEmpty(`/sessions/${sessionId}`, {
    method: "DELETE"
  });
}

export async function interruptSession(sessionId: string): Promise<void> {
  await requestEmpty(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST" });
}

export async function listApprovals(sessionId: string, signal?: AbortSignal): Promise<Approval[]> {
  return (await requestJson(`/sessions/${sessionId}/approvals`, ApprovalsListResponseSchema, { signal })).approvals;
}

export async function resolveApproval(
  approvalId: string,
  decision: ApprovalDecisionRequest["decision"],
  rememberForTurn = false
): Promise<void> {
  const body: ApprovalDecisionRequest = rememberForTurn
    ? { decision, rememberForTurn: true }
    : { decision };
  await requestEmpty(`/approvals/${approvalId}/decision`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}
