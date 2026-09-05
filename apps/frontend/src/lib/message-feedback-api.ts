import { MessageFeedbackResponseSchema } from "@cogniplane/shared-types";

import { request } from "./api-client";
import { parseResponse } from "./validate-response";

import type {
  MessageFeedbackStats
} from "@cogniplane/shared-types";

export type {
  FeedbackDayPoint,
  FeedbackSummary,
  MessageFeedbackStats
} from "@cogniplane/shared-types";

export async function fetchMessageFeedback(days: number): Promise<MessageFeedbackStats> {
  const raw = await request<unknown>(`/admin/message-feedback?days=${days}`);
  return parseResponse(MessageFeedbackResponseSchema, raw, "GET /admin/message-feedback").stats;
}
