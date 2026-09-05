import { MessagesListResponseSchema } from "@cogniplane/shared-types";

import { request } from "./api-client";
import { parseResponse } from "./validate-response";

import type { Message } from "@cogniplane/shared-types";

export type ListMessagesResult = {
  messages: Message[];
  /**
   * The backend clipped the transcript to its newest N messages and withheld
   * older turns. Must be surfaced to the user — silently serving a partial
   * history looks identical to a complete one.
   */
  hasMore: boolean;
};

export async function listMessages(sessionId: string, signal?: AbortSignal): Promise<ListMessagesResult> {
  const raw = await request<unknown>(`/sessions/${sessionId}/messages`, { signal });
  const result = parseResponse(MessagesListResponseSchema, raw, "GET /sessions/:id/messages");
  // Defensive default in case an older backend doesn't return these fields yet.
  return {
    messages: result.messages.map((m) => ({
      ...m,
      reasoningContent: m.reasoningContent ?? "",
      planContent: m.planContent ?? ""
    })),
    hasMore: result.hasMore ?? false
  };
}
