import {
  ApprovalsListResponseSchema,
  SessionEnvelopeSchema,
  SessionsListResponseSchema
} from "@cogniplane/shared-types";

import { request } from "./api-client";
import { parseResponse } from "./validate-response";

import type { Approval, ApprovalDecisionRequest, Session } from "@cogniplane/shared-types";

export async function listSessions(): Promise<Session[]> {
  const raw = await request<unknown>("/sessions?purposes=normal,skill_improvement");
  return parseResponse(SessionsListResponseSchema, raw, "GET /sessions").sessions;
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
