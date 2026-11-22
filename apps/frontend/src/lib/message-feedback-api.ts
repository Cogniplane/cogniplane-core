import { MessageFeedbackResponseSchema } from "@cogniplane/shared-types";

import { requestJson } from "./api-client";

import type {
  MessageFeedbackStats
} from "@cogniplane/shared-types";

export type {
  FeedbackDayPoint,
  FeedbackSummary,
  MessageFeedbackStats
} from "@cogniplane/shared-types";

export async function fetchMessageFeedback(days: number): Promise<MessageFeedbackStats> {
  return (await requestJson(`/admin/message-feedback?days=${days}`, MessageFeedbackResponseSchema)).stats;
}
