import { MessagesListResponseSchema } from "@cogniplane/shared-types";

import { request } from "./api-client";
import { parseResponse } from "./validate-response";

import type { Message } from "@cogniplane/shared-types";

export async function listMessages(sessionId: string): Promise<Message[]> {
  const raw = await request<unknown>(`/sessions/${sessionId}/messages`);
  const result = parseResponse(MessagesListResponseSchema, raw, "GET /sessions/:id/messages");
  // Defensive default in case an older backend doesn't return these fields yet.
  return result.messages.map((m) => ({
    ...m,
    reasoningContent: m.reasoningContent ?? "",
    planContent: m.planContent ?? ""
  }));
}
