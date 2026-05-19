import { z } from "zod";

import { ApprovalSchema, TokenUsageSchema, ToolResultSchema } from "./message.js";

// ---------------------------------------------------------------------------
// SSE wire schemas — one per `event:` type on POST /messages.
//
// These describe the JSON shape carried in each SSE `data:` line. They mirror
// `runtimeEventToSSEFrame` in apps/backend/src/runtime-contracts.ts, which
// produces these payloads. The shared schemas let backend `serialize(...)`
// catch emit-side drift and let the frontend `.parse(...)` catch consume-side
// drift against the same source of truth.
//
// Field naming is snake_case to match the backend wire output. Domain
// schemas (camelCase) are reused for nested objects whose shape is already
// canonical (ToolResult, Approval, TokenUsage).
// ---------------------------------------------------------------------------

const ResponseStatusInProgressSchema = z.object({
  id: z.string(),
  status: z.literal("in_progress")
}).passthrough();

const ResponseStatusFailedSchema = z.object({
  id: z.string().nullable(),
  status: z.literal("failed")
}).passthrough();

// `response.completed` is the terminal frame for any turn — including
// failures that bypassed `response.failed` (e.g. runtime threw before
// emitting `response.created`, so there's no responseId yet) and PII
// blocks (where the runtime never starts at all). The frontend maps
// `status === "failed" | "blocked"` to the error completion path.
const ResponseStatusTerminalSchema = z.object({
  id: z.string().nullable(),
  status: z.enum(["completed", "interrupted", "failed", "blocked"])
}).passthrough();

export const SseResponseCreatedSchema = z.object({
  type: z.literal("response.created"),
  response: ResponseStatusInProgressSchema
}).passthrough();

const DeltaFrameBase = {
  response_id: z.string(),
  item_id: z.string().nullable(),
  delta: z.string()
};

export const SseOutputTextDeltaSchema = z.object({
  type: z.literal("response.output_text.delta"),
  ...DeltaFrameBase
}).passthrough();

export const SseReasoningTextDeltaSchema = z.object({
  type: z.literal("framework:reasoning_text.delta"),
  ...DeltaFrameBase
}).passthrough();

export const SseReasoningSummaryDeltaSchema = z.object({
  type: z.literal("framework:reasoning_summary.delta"),
  ...DeltaFrameBase
}).passthrough();

export const SsePlanDeltaSchema = z.object({
  type: z.literal("framework:plan.delta"),
  ...DeltaFrameBase
}).passthrough();

export const SseOutputItemDoneSchema = z.object({
  type: z.literal("response.output_item.done"),
  response_id: z.string(),
  item_id: z.string().nullable()
}).passthrough();

export const SseToolStartedSchema = z.object({
  type: z.literal("response.tool.started"),
  response_id: z.string(),
  item_id: z.string(),
  tool_result: ToolResultSchema
}).passthrough();

export const SseToolOutputDeltaSchema = z.object({
  type: z.literal("response.tool.output.delta"),
  response_id: z.string(),
  item_id: z.string(),
  delta: z.string()
}).passthrough();

export const SseToolCompletedSchema = z.object({
  type: z.literal("response.tool.completed"),
  response_id: z.string(),
  item_id: z.string(),
  tool_result: ToolResultSchema
}).passthrough();

// `framework:approval_required` carries an Approval-shaped object plus the
// runtime-coordinator's `availableDecisions`/command/cwd context. The base
// ApprovalSchema in message.ts intentionally does not include those last
// three fields because they're only meaningful at request time, not for
// the persisted approval row.
export const SseApprovalRequiredSchema = z.object({
  type: z.literal("framework:approval_required"),
  response_id: z.string(),
  approval: z.object({
    approvalId: z.string(),
    itemId: z.string(),
    kind: z.string(),
    title: z.string(),
    summary: z.string(),
    availableDecisions: z.array(z.string()),
    command: z.string().nullable().optional(),
    cwd: z.string().nullable().optional()
  }).passthrough()
}).passthrough();

export const SseRuntimeNoticeSchema = z.object({
  type: z.literal("framework:runtime_notice"),
  response_id: z.string(),
  item_id: z.string().nullable(),
  notice: z.object({
    noticeId: z.string(),
    level: z.enum(["info", "warning", "error"]),
    title: z.string(),
    message: z.string(),
    createdAt: z.string()
  }).passthrough()
}).passthrough();

export const SseMcpServerStatusSchema = z.object({
  type: z.literal("framework:mcp_server_status"),
  server_name: z.string(),
  status: z.enum(["starting", "ready", "failed", "cancelled"]),
  error: z.string().nullable()
}).passthrough();

export const SseUserMessageReplacedSchema = z.object({
  type: z.literal("runtime.user_message_replaced"),
  message_id: z.string(),
  text: z.string(),
  scan_run_id: z.string().nullable()
}).passthrough();

export const SseMessageBlockedSchema = z.object({
  type: z.literal("framework:message_blocked"),
  reason: z.string(),
  block_reason: z.string(),
  scan_run_id: z.string().nullable(),
  message: z.string()
}).passthrough();

export const SseFailedSchema = z.object({
  type: z.literal("response.failed"),
  response: ResponseStatusFailedSchema,
  error: z.object({
    message: z.string()
  }).passthrough()
}).passthrough();

// `token_usage`, `cost_usd`, `model_name` are only present when the turn
// produced any usage at all (tool-only turns may not). Optional matches the
// emitter, which conditionally adds them.
export const SseCompletedSchema = z.object({
  type: z.literal("response.completed"),
  response: ResponseStatusTerminalSchema,
  token_usage: TokenUsageSchema.optional(),
  model_name: z.string().nullable().optional(),
  cost_usd: z.number().nullable().optional()
}).passthrough();

// Suppress unused-import warning when ApprovalSchema isn't referenced inside
// SseApprovalRequiredSchema (we open-coded the shape above to capture the
// runtime-coordinator extras). Keep the import so future authors discover the
// alignment with the persisted approval row schema.
void ApprovalSchema;

export const SseFrameSchemas = {
  "response.created": SseResponseCreatedSchema,
  "response.output_text.delta": SseOutputTextDeltaSchema,
  "framework:reasoning_text.delta": SseReasoningTextDeltaSchema,
  "framework:reasoning_summary.delta": SseReasoningSummaryDeltaSchema,
  "framework:plan.delta": SsePlanDeltaSchema,
  "response.output_item.done": SseOutputItemDoneSchema,
  "response.tool.started": SseToolStartedSchema,
  "response.tool.output.delta": SseToolOutputDeltaSchema,
  "response.tool.completed": SseToolCompletedSchema,
  "framework:approval_required": SseApprovalRequiredSchema,
  "framework:runtime_notice": SseRuntimeNoticeSchema,
  "framework:mcp_server_status": SseMcpServerStatusSchema,
  "runtime.user_message_replaced": SseUserMessageReplacedSchema,
  "framework:message_blocked": SseMessageBlockedSchema,
  "response.failed": SseFailedSchema,
  "response.completed": SseCompletedSchema
} as const;

export type SseEventType = keyof typeof SseFrameSchemas;

export type SseFramePayloads = {
  [K in SseEventType]: z.infer<(typeof SseFrameSchemas)[K]>;
};
