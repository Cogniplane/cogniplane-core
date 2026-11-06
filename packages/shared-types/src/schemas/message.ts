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

// Legacy inline resource blocks retained in tool-result history. The runtime
// no longer writes them, and the frontend does not render them; supported
// widgets use McpAppCallSchema. Keep this read contract while retained rows
// need it.
export const UiResourceSchema = z.object({
  uri: z.string(),
  mimeType: z.string(),
  text: z.string().optional(),
  blob: z.string().optional()
}).passthrough();
export type UiResource = z.infer<typeof UiResourceSchema>;

// The most characters that a widget can put in the chat message box with
// `ui/message`. The host refuses more, and the built-in widget shell checks the
// same value before it asks. Change it only with the "Interactive UI" skill text
// (see apps/backend/db/migrations/069_interactive_ui_skill_draft.sql), which
// tells the model the limit.
export const MCP_APP_MESSAGE_MAX_CHARS = 4_000;

export const McpAppCallSchema = z.object({
  resourceUri: z.string().startsWith("ui://"),
  readOnly: z.boolean().optional(),
  turnContext: z.enum(["interactive", "scheduled"]).nullable().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  result: z.object({
    content: z.array(z.object({ type: z.string() }).passthrough()),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    isError: z.boolean().optional()
  }).passthrough()
});
export type McpAppCall = z.infer<typeof McpAppCallSchema>;

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
  // Deprecated legacy inline resources. Read from retained rows only; not
  // written or rendered.
  uiResources: z.array(UiResourceSchema).optional(),
  mcpApp: McpAppCallSchema.optional()
}).passthrough();
export type ToolResult = z.infer<typeof ToolResultSchema>;

// A reasoning burst positioned by its character offset into the assistant text.
export const ReasoningSegmentSchema = z.object({ offset: z.number(), text: z.string() });
export type ReasoningSegment = z.infer<typeof ReasoningSegmentSchema>;

// Why the backend stopped a turn that the user did not stop. The backend sends
// the code on the interrupted RUN_FINISHED and saves it on the assistant row;
// the frontend owns the text that it shows.
// - security_change: the account's security version changed (a password
//   change, sign out everywhere, a factor change, and the like). The
//   replica that made the change stops the turn, and every other replica
//   stops it at its next model call, native tool or approval round.
// - tool_context_ended: the turn's tool access ended for another reason
//   (expired, or its execution ended), found at one of the same points.
export const TurnStopReasonSchema = z.enum(["security_change", "tool_context_ended"]);
export type TurnStopReason = z.infer<typeof TurnStopReasonSchema>;

export const MessageSchema = z.object({
  messageId: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  status: z.enum(["pending", "streaming", "completed", "error", "interrupted"]),
  content: z.string(),
  reasoningContent: z.string(),
  // Reasoning bursts positioned by their character offset into the assistant
  // text, for interleaved reload of AG-UI turns. Null on legacy rows.
  // `reasoningContent` is the flat copy that the admin replay shows. Chat
  // history reads `reasoningSegments`. Remove this default only
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
  // Set on an interrupted turn that the backend stopped. Absent otherwise.
  stopReason: TurnStopReasonSchema.nullable().optional(),
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
  // The tool call that this approval is for: the ID that the server gave the
  // proposed call, the same as the toolCallId of its AG-UI tool call and its
  // saved tool result. Absent when the server could not prove the link (an
  // approval inside delegated work, a repeated model call ID, an older row).
  // The decision route still takes only the approval ID.
  toolCallId: z.string().min(1).optional(),
  kind: z.enum(["command_execution", "file_change", "permissions", "mcp_tool"]),
  title: z.string(),
  summary: z.string(),
  status: z.enum(["pending", "approved", "rejected", "expired"])
}).strip();
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

// The standard UI catalog is larger than a prompt. Bound its schema and current
// surface state before either reaches the policy provider or model.
export const MAX_GENERATIVE_UI_CONTEXT_LENGTH = 256_000;
export const GENERATIVE_UI_CATALOG_ID = "cogniplane/standard@1";
// The one named place outside the transcript where render_ui can show a
// surface. The chat host mounts it beside the transcript. The backend accepts
// only these targets, and a surface keeps the target of its createSurface.
export const GENERATIVE_UI_PANEL_TARGET = "side-panel";
export const GENERATIVE_UI_TARGETS = ["chat", GENERATIVE_UI_PANEL_TARGET] as const;
export type GenerativeUiTarget = (typeof GENERATIVE_UI_TARGETS)[number];
// The props that the model sets on the ArtifactCard component of that catalog.
// Only the id: the browser reads the name, status, size, type and PII label of
// the file from the session's artifact list, never from the model.
export const ArtifactCardPropsSchema = z.object({ artifactId: z.string().uuid() });
// The props of the Checklist component of that catalog. The model sets the
// items, the title, and the start values. `checked` and `notes` are
// writable: the model binds them to data model paths, and the user's edits
// go there. A value over a bound, a duplicate item id, or a `checked` key
// that names no item makes the props invalid, and the component does not render.
export const CHECKLIST_LIMITS = { items: 30, idChars: 64, titleChars: 120, labelChars: 200, descriptionChars: 300, notesChars: 2_000 } as const;
// The ids of every application component are keys of its data, so they stay
// plain, and never a prototype name. A Checklist id is also a segment of the
// data model and of the stored drafts.
const GeneratedUiIdSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .max(CHECKLIST_LIMITS.idChars)
  .refine((id) => id !== "constructor" && id !== "prototype", { message: "Reserved item id" });
const ChecklistItemIdSchema = GeneratedUiIdSchema;
export const ChecklistPropsSchema = z.object({
  title: z.string().trim().min(1).max(CHECKLIST_LIMITS.titleChars).optional(),
  items: z.array(z.object({
    id: ChecklistItemIdSchema,
    label: z.string().trim().min(1).max(CHECKLIST_LIMITS.labelChars),
    description: z.string().trim().max(CHECKLIST_LIMITS.descriptionChars).optional()
  })).min(1).max(CHECKLIST_LIMITS.items),
  checked: z.record(z.string(), z.boolean()).optional(),
  notes: z.string().max(CHECKLIST_LIMITS.notesChars).optional()
}).superRefine((props, context) => {
  const ids = new Set<string>();
  props.items.forEach((item, index) => {
    if (ids.has(item.id)) context.addIssue({ code: "custom", path: ["items", index, "id"], message: `Duplicate item id "${item.id}"` });
    ids.add(item.id);
  });
  for (const key of Object.keys(props.checked ?? {})) {
    if (!ids.has(key)) context.addIssue({ code: "custom", path: ["checked", key], message: `No item has the id "${key}"` });
  }
});
export type ChecklistProps = z.infer<typeof ChecklistPropsSchema>;
// The props of the ComparisonTable component of that catalog: a read-only
// table. The model names the compared items (columns) and the criteria (rows),
// and gives each cell a text, a number, a boolean, or null for "no data". A
// column id that a row leaves out also shows as "no data". The numbers stay
// within +-1e15, so the browser prints each one as it is.
export const COMPARISON_TABLE_LIMITS = {
  minColumns: 2, columns: 8, rows: 30, titleChars: 120, labelChars: 120, cellChars: 300, maxNumber: 1e15
} as const;
const ComparisonCellSchema = z.union([
  z.string().max(COMPARISON_TABLE_LIMITS.cellChars),
  z.number().min(-COMPARISON_TABLE_LIMITS.maxNumber).max(COMPARISON_TABLE_LIMITS.maxNumber),
  z.boolean(),
  z.null()
]);
export const ComparisonTablePropsSchema = z.object({
  title: z.string().trim().min(1).max(COMPARISON_TABLE_LIMITS.titleChars).optional(),
  columns: z.array(z.object({
    id: GeneratedUiIdSchema,
    label: z.string().trim().min(1).max(COMPARISON_TABLE_LIMITS.labelChars)
  })).min(COMPARISON_TABLE_LIMITS.minColumns).max(COMPARISON_TABLE_LIMITS.columns),
  rows: z.array(z.object({
    id: GeneratedUiIdSchema,
    label: z.string().trim().min(1).max(COMPARISON_TABLE_LIMITS.labelChars),
    // The key schema rejects "__proto__" and the like before a cell reaches the table.
    cells: z.record(GeneratedUiIdSchema, ComparisonCellSchema)
  })).min(1).max(COMPARISON_TABLE_LIMITS.rows)
}).superRefine((props, context) => {
  const columnIds = new Set<string>();
  props.columns.forEach((column, index) => {
    if (columnIds.has(column.id)) context.addIssue({ code: "custom", path: ["columns", index, "id"], message: `Duplicate column id "${column.id}"` });
    columnIds.add(column.id);
  });
  const rowIds = new Set<string>();
  props.rows.forEach((row, index) => {
    if (rowIds.has(row.id)) context.addIssue({ code: "custom", path: ["rows", index, "id"], message: `Duplicate row id "${row.id}"` });
    rowIds.add(row.id);
    for (const key of Object.keys(row.cells)) {
      if (!columnIds.has(key)) context.addIssue({ code: "custom", path: ["rows", index, "cells", key], message: `No column has the id "${key}"` });
    }
  });
});
export type ComparisonTableProps = z.infer<typeof ComparisonTablePropsSchema>;
// The props of the StatusSummary component of that catalog: a read-only list of
// phases or items, each with a status label from a fixed list, and optional
// counts. The browser colors a status by its name and never reads the other
// text. A count is a pair from the model's data, and the browser computes no
// count or percentage.
export const STATUS_SUMMARY_LIMITS = { items: 30, titleChars: 120, labelChars: 120, detailChars: 300, maxCount: 1_000_000 } as const;
export const STATUS_SUMMARY_STATUSES = ["not-started", "in-progress", "at-risk", "blocked", "complete"] as const;
export type StatusSummaryStatus = (typeof STATUS_SUMMARY_STATUSES)[number];
const StatusCountSchema = z.number().int().min(0).max(STATUS_SUMMARY_LIMITS.maxCount);
const StatusCountsShape = { completed: StatusCountSchema.optional(), total: StatusCountSchema.optional() };
function refineStatusCounts(counts: { completed?: number; total?: number }, path: (string | number)[], context: z.RefinementCtx): void {
  if ((counts.completed === undefined) !== (counts.total === undefined)) {
    context.addIssue({ code: "custom", path, message: "Set completed and total together, or neither" });
  } else if (counts.completed !== undefined && counts.total !== undefined && counts.completed > counts.total) {
    context.addIssue({ code: "custom", path: [...path, "completed"], message: "completed is larger than total" });
  }
}
export const StatusSummaryPropsSchema = z.object({
  title: z.string().trim().min(1).max(STATUS_SUMMARY_LIMITS.titleChars).optional(),
  ...StatusCountsShape,
  items: z.array(z.object({
    id: GeneratedUiIdSchema,
    label: z.string().trim().min(1).max(STATUS_SUMMARY_LIMITS.labelChars),
    status: z.enum(STATUS_SUMMARY_STATUSES).optional(),
    detail: z.string().trim().max(STATUS_SUMMARY_LIMITS.detailChars).optional(),
    ...StatusCountsShape
  })).max(STATUS_SUMMARY_LIMITS.items)
}).superRefine((props, context) => {
  refineStatusCounts(props, [], context);
  const ids = new Set<string>();
  props.items.forEach((item, index) => {
    if (ids.has(item.id)) context.addIssue({ code: "custom", path: ["items", index, "id"], message: `Duplicate item id "${item.id}"` });
    ids.add(item.id);
    refineStatusCounts(item, ["items", index], context);
  });
});
export type StatusSummaryProps = z.infer<typeof StatusSummaryPropsSchema>;
// Keep accepted tool arguments below the message-list projection's 32k cap.
export const MAX_RENDER_UI_ARGS_CHARS = 30_000;
export const MAX_RENDER_UI_OPERATIONS = 100;

export const MessagePostRequestSchema = z.object({
  sessionId: z.string().uuid(),
  text: z.string().trim().min(1).max(MAX_MESSAGE_TEXT_LENGTH),
  artifactIds: z.array(z.string().uuid()).max(10).optional(),
  projectFileIds: z.array(z.string().uuid()).max(20).optional(),
  model: z.string().optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  generativeUiContext: z.string().trim().min(1).max(MAX_GENERATIVE_UI_CONTEXT_LENGTH).optional(),
  generativeUiTransport: z.literal("tool").optional()
}).refine((input) => input.generativeUiTransport === undefined || Boolean(input.generativeUiContext), {
  message: "Tool UI transport requires browser UI context", path: ["generativeUiTransport"]
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
  days: z.number(),
  // Present only when the request asked for `period=current_month`: the exact
  // UTC calendar month [from, to) that every aggregation covers.
  period: z.literal("current_month").optional(),
  range: z.object({ from: z.string(), to: z.string() }).optional(),
  // Echo of the `userId` filter. A response without it covers all members.
  userId: z.string().optional()
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
