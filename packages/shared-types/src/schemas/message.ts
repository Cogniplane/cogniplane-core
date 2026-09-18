import { ProjectInstructionsSnapshotSchema } from "./project-instructions.js";
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

// MCP Apps / MCP-UI resource embedded in a tool result (the `{type:"resource"}`
// content block). Rendered client-side as a sandboxed iframe by @mcp-ui/client.
// `uri` uses the `ui://` scheme; content is either inline `text` HTML or a
// base64 `blob`. Kept `.passthrough()` so forward-compatible fields survive.
export const UiResourceSchema = z.object({
  uri: z.string(),
  mimeType: z.string(),
  text: z.string().optional(),
  blob: z.string().optional()
}).passthrough();
export type UiResource = z.infer<typeof UiResourceSchema>;

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
  durationMs: z.number().nullable(),
  // Character length of the assistant text when this tool call started; lets a
  // session reload interleave the card back into the right spot in the turn's
  // text. Null/absent on legacy rows, so reload falls back to text-then-tools.
  // Remove the default only after retained tool results have offsets backfilled
  // or the affected conversations are deleted.
  textOffset: z.number().nullable().default(null),
  // Present only when an MCP tool returns UI resource blocks (MCP Apps).
  uiResources: z.array(UiResourceSchema).optional()
}).passthrough();
export type ToolResult = z.infer<typeof ToolResultSchema>;

// A reasoning burst positioned by its character offset into the assistant text.
export const ReasoningSegmentSchema = z.object({ offset: z.number(), text: z.string() });
export type ReasoningSegment = z.infer<typeof ReasoningSegmentSchema>;

export const MessageSchema = z.object({
  messageId: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  status: z.enum(["pending", "streaming", "completed", "error", "interrupted"]),
  content: z.string(),
  reasoningContent: z.string(),
  // Reasoning bursts positioned by their character offset into the assistant
  // text, for interleaved reload of AG-UI turns. Null on legacy rows, where
  // reload renders the single `reasoningContent` block. Remove this default only
  // after retained reasoning is backfilled into segments or its conversations
  // are deleted.
  reasoningSegments: z.array(ReasoningSegmentSchema).nullable().default(null),
  planContent: z.string(),
  toolResults: z.array(ToolResultSchema),
  tokenUsage: TokenUsageSchema.nullable(),
  modelName: z.string().nullable(),
  costUsd: z.number().nullable(),
  feedbackRating: MessageFeedbackRatingSchema.nullable(),
  // Whole-turn elapsed time, including approval waits. Absent on older turns.
  durationMs: z.number().finite().nonnegative().nullable().optional(),
  projectInstructions: ProjectInstructionsSnapshotSchema.nullable().optional(),
  // Frontend-only field (passthrough): when the user's message was rewritten
  // by the PII detector before the runtime saw it, the SSE stream surfaces a
  // `user_message_replaced` custom event carrying the scan_run_id. The
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
  kind: z.enum(["command_execution", "file_change", "permissions", "mcp_tool"]),
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

// Hard cap on a single user turn's prompt text. This bounds per-request DB
// storage and downstream token cost before quota/rate-limit enforcement even
// runs. 100k chars (~25k tokens) is far above any legitimate hand-typed turn
// while still rejecting paste-bomb / DoS inputs. The HTTP-layer `bodyLimit`
// (app.ts) is the coarse outer guard; this is the precise field-level one.
export const MAX_MESSAGE_TEXT_LENGTH = 100_000;

export const MessagePostRequestSchema = z.object({
  sessionId: z.string().uuid(),
  text: z.string().trim().min(1).max(MAX_MESSAGE_TEXT_LENGTH),
  artifactIds: z.array(z.string().uuid()).max(10).optional(),
  projectFileIds: z.array(z.string().uuid()).max(20).optional(),
  model: z.string().optional(),
  effort: z.enum(EFFORT_LEVELS).optional()
});
export type MessagePostRequest = z.infer<typeof MessagePostRequestSchema>;

export const ApprovalDecisionRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  rememberForTurn: z.boolean().optional()
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

// Shape of `GET /sessions/:id/messages`. `SessionMessagesResponseSchema`
// (schemas/session.ts) extends this with the session envelope rather than
// redeclaring the fields — one endpoint, one source of truth for the payload.
export const MessagesListResponseSchema = z.object({
  messages: z.array(MessageSchema),
  // True when the transcript was clipped to the newest N messages and older
  // turns were withheld (see MessageStore.listBySession). Optional so an older
  // backend, or an in-memory test fake, can omit it.
  hasMore: z.boolean().optional()
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

const TokenUsageMetricsShape = {
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number()
};

export const TokenUsageDayPointSchema = z.object({
  date: z.string(),
  ...TokenUsageMetricsShape
}).passthrough();
export type TokenUsageDayPoint = z.infer<typeof TokenUsageDayPointSchema>;

export const TokenUsageUserBreakdownSchema = z.object({
  userId: z.string(),
  ...TokenUsageMetricsShape
}).passthrough();
export type TokenUsageUserBreakdown = z.infer<typeof TokenUsageUserBreakdownSchema>;

export const TokenUsageModelBreakdownSchema = z.object({
  modelName: z.string(),
  ...TokenUsageMetricsShape
}).passthrough();
export type TokenUsageModelBreakdown = z.infer<typeof TokenUsageModelBreakdownSchema>;

export const TokenUsageTotalsSchema = z.object({
  ...TokenUsageMetricsShape,
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
