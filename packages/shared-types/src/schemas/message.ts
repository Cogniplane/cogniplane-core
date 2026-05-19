import { z } from "zod";

import { EFFORT_LEVELS } from "../primitives.js";
import { IsoDateSchema } from "./_helpers.js";

export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
  totalTokens: z.number()
}).passthrough();
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const MessageFeedbackRatingSchema = z.enum(["thumbs_up", "thumbs_down"]);
export type MessageFeedbackRating = z.infer<typeof MessageFeedbackRatingSchema>;

export const ToolResultSchema = z.object({
  toolResultId: z.string(),
  kind: z.enum(["command", "mcp"]),
  title: z.string(),
  status: z.enum(["in_progress", "completed", "failed", "declined"]),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  server: z.string().nullable(),
  toolName: z.string().nullable(),
  input: z.string(),
  output: z.string(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable()
}).passthrough();
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const MessageSchema = z.object({
  messageId: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  status: z.enum(["pending", "streaming", "completed", "error", "interrupted"]),
  content: z.string(),
  reasoningContent: z.string(),
  planContent: z.string(),
  toolResults: z.array(ToolResultSchema),
  tokenUsage: TokenUsageSchema.nullable(),
  modelName: z.string().nullable(),
  costUsd: z.number().nullable(),
  feedbackRating: MessageFeedbackRatingSchema.nullable(),
  // Frontend-only field (passthrough): when the user's message was rewritten
  // by the PII detector before the runtime saw it, the SSE stream surfaces a
  // `runtime.user_message_replaced` event carrying the scan_run_id. The
  // optimistic user message stamps this id so the activity timeline can show
  // a "this was redacted" banner. The backend does not currently persist or
  // return this value on session reload.
  piiScanRunId: z.string().nullable().default(null),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
}).passthrough();
export type Message = z.infer<typeof MessageSchema>;

export const ApprovalSchema = z.object({
  approvalId: z.string(),
  sessionId: z.string(),
  itemId: z.string(),
  kind: z.enum(["command_execution", "file_change", "permissions"]),
  title: z.string(),
  summary: z.string(),
  status: z.enum(["pending", "approved", "rejected", "expired"])
}).passthrough();
export type Approval = z.infer<typeof ApprovalSchema>;

export const ApprovalsListResponseSchema = z.object({
  approvals: z.array(ApprovalSchema)
}).passthrough();
export type ApprovalsListResponse = z.infer<typeof ApprovalsListResponseSchema>;

// Request bodies — shared so the client and the route validator agree on
// shape by construction. The backend may further refine (e.g. the `model`
// field is narrowed to the AVAILABLE_MODELS allowlist at the route layer);
// the wire shape stays here.

export const MessagePostRequestSchema = z.object({
  sessionId: z.string().uuid(),
  text: z.string().trim().min(1),
  artifactIds: z.array(z.string().uuid()).max(10).optional(),
  model: z.string().optional(),
  effort: z.enum(EFFORT_LEVELS).optional()
});
export type MessagePostRequest = z.infer<typeof MessagePostRequestSchema>;

export const ApprovalDecisionRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  rememberForTurn: z.boolean().optional()
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export const MessagesListResponseSchema = z.object({
  messages: z.array(MessageSchema)
}).passthrough();
export type MessagesListResponse = z.infer<typeof MessagesListResponseSchema>;

// ── Feedback analytics ───────────────────────────────────────────────────────

const FeedbackSummaryShape = {
  thumbsUp: z.number(),
  thumbsDown: z.number(),
  total: z.number(),
  ratePercent: z.number().nullable()
};

export const FeedbackSummarySchema = z.object(FeedbackSummaryShape).passthrough();
export type FeedbackSummary = z.infer<typeof FeedbackSummarySchema>;

export const FeedbackDayPointSchema = z.object({
  date: z.string(),
  thumbsUp: z.number(),
  thumbsDown: z.number()
}).passthrough();
export type FeedbackDayPoint = z.infer<typeof FeedbackDayPointSchema>;

export const MessageFeedbackStatsSchema = z.object({
  totals: FeedbackSummarySchema,
  daily: z.array(FeedbackDayPointSchema),
  byModel: z.array(z.object({
    modelName: z.string(),
    ...FeedbackSummaryShape
  }).passthrough())
}).passthrough();
export type MessageFeedbackStats = z.infer<typeof MessageFeedbackStatsSchema>;

export const MessageFeedbackResponseSchema = z.object({
  stats: MessageFeedbackStatsSchema,
  days: z.number()
}).passthrough();
export type MessageFeedbackResponse = z.infer<typeof MessageFeedbackResponseSchema>;

// ── Token usage analytics ────────────────────────────────────────────────────

export const TokenUsageDayPointSchema = z.object({
  date: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number()
}).passthrough();
export type TokenUsageDayPoint = z.infer<typeof TokenUsageDayPointSchema>;

export const TokenUsageUserBreakdownSchema = z.object({
  userId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number()
}).passthrough();
export type TokenUsageUserBreakdown = z.infer<typeof TokenUsageUserBreakdownSchema>;

export const TokenUsageModelBreakdownSchema = z.object({
  modelName: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number()
}).passthrough();
export type TokenUsageModelBreakdown = z.infer<typeof TokenUsageModelBreakdownSchema>;

export const TokenUsageTotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number(),
  messageCount: z.number()
}).passthrough();
export type TokenUsageTotals = z.infer<typeof TokenUsageTotalsSchema>;

export const TokenUsageSeriesSchema = z.object({
  daily: z.array(TokenUsageDayPointSchema),
  byUser: z.array(TokenUsageUserBreakdownSchema),
  byModel: z.array(TokenUsageModelBreakdownSchema),
  totals: TokenUsageTotalsSchema
}).passthrough();
export type TokenUsageSeries = z.infer<typeof TokenUsageSeriesSchema>;

export const TokenUsageResponseSchema = z.object({
  usage: TokenUsageSeriesSchema,
  days: z.number()
}).passthrough();
export type TokenUsageResponse = z.infer<typeof TokenUsageResponseSchema>;

export const PersonalTokenUsageSeriesSchema = z.object({
  daily: z.array(TokenUsageDayPointSchema),
  byModel: z.array(TokenUsageModelBreakdownSchema),
  totals: TokenUsageTotalsSchema
}).passthrough();
export type PersonalTokenUsageSeries = z.infer<typeof PersonalTokenUsageSeriesSchema>;

export const PersonalTokenUsageResponseSchema = z.object({
  usage: PersonalTokenUsageSeriesSchema,
  days: z.number()
}).passthrough();
export type PersonalTokenUsageResponse = z.infer<typeof PersonalTokenUsageResponseSchema>;
