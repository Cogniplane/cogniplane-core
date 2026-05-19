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

// Stop button — asks the backend to interrupt the in-flight turn while keeping
// the runtime warm. Returns true when the backend dispatched an interrupt,
// false when there was nothing to stop (e.g. the user clicked Stop in the
// race window between Send and turn/start, before Codex assigned a turnId).
// "Nothing to stop" is a valid no-op, not a user-facing error.
export async function interruptSession(sessionId: string): Promise<boolean> {
  try {
    await request<unknown>(`/sessions/${sessionId}/interrupt`, {
      method: "POST"
    });
    return true;
  } catch (err) {
    if (err instanceof Error && /no_active_turn/.test(err.message)) {
      return false;
    }
    throw err;
  }
}

export async function listApprovals(sessionId: string): Promise<Approval[]> {
  const raw = await request<unknown>(`/sessions/${sessionId}/approvals`);
  return parseResponse(ApprovalsListResponseSchema, raw, "GET /sessions/:id/approvals").approvals;
}

export async function resolveApproval(
  approvalId: string,
  decision: ApprovalDecisionRequest["decision"]
): Promise<void> {
  const body: ApprovalDecisionRequest = { decision };
  await request(`/approvals/${approvalId}/decision`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}
