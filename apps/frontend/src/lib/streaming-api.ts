import { SseFrameSchemas, type SseEventType, type SseFramePayloads } from "@cogniplane/shared-types";

import { buildApiUrl, buildErrorMessage, createApiHeaders } from "./api-client";

import type { Approval, EffortLevel, MessagePostRequest, Message, TokenUsage, ToolResult } from "@cogniplane/shared-types";

export type McpServerStatusEvent = {
  serverName: string;
  status: "starting" | "ready" | "failed" | "cancelled";
  error: string | null;
};

export type UserMessageReplacedEvent = {
  messageId: string;
  text: string;
  scanRunId: string | null;
};

export type MessageBlockedEvent = {
  reason: string;
  blockReason: string;
  scanRunId: string | null;
  message: string;
};

export type RuntimeNoticeEvent = {
  noticeId: string;
  level: "info" | "warning" | "error";
  title: string;
  message: string;
  createdAt: string;
};

export type StreamMessageHandlers = {
  onCreated?: () => void;
  onStatusChange?: (status: Message["status"]) => void;
  onDelta: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onReasoningSummaryDelta?: (delta: string) => void;
  onPlanDelta?: (delta: string) => void;
  onToolStarted?: (toolResult: ToolResult) => void;
  onToolDelta?: (toolResultId: string, delta: string) => void;
  onToolCompleted?: (toolResult: ToolResult) => void;
  onApprovalRequired?: (approval: Approval) => void;
  onMcpServerStatus?: (event: McpServerStatusEvent) => void;
  onRuntimeNotice?: (event: RuntimeNoticeEvent) => void;
  onUserMessageReplaced?: (event: UserMessageReplacedEvent) => void;
  onMessageBlocked?: (event: MessageBlockedEvent) => void;
  onFailed?: (message: string) => void;
  onComplete: (status: Extract<Message["status"], "completed" | "error" | "interrupted">, tokenUsage?: TokenUsage, costUsd?: number | null, modelName?: string | null) => void;
};

type DispatchContext = {
  sessionId: string;
  handlers: StreamMessageHandlers;
  markTerminal: () => void;
};

type EventDispatch = {
  [K in SseEventType]: (payload: SseFramePayloads[K], ctx: DispatchContext) => void;
};

// `framework:runtime_notice` is emitted by the backend (e.g. for approval
// expiry) and surfaced to the activity timeline via onRuntimeNotice. The
// schema parse still runs as a guard against wire drift.
const eventDispatch: EventDispatch = {
  "response.created": (_payload, { handlers }) => {
    handlers.onCreated?.();
    handlers.onStatusChange?.("pending");
  },
  "response.output_text.delta": (payload, { handlers }) => {
    if (payload.delta) {
      handlers.onStatusChange?.("streaming");
      handlers.onDelta(payload.delta);
    }
  },
  "framework:reasoning_text.delta": (payload, { handlers }) => {
    if (payload.delta) {
      handlers.onReasoningDelta?.(payload.delta);
    }
  },
  "framework:reasoning_summary.delta": (payload, { handlers }) => {
    if (payload.delta) {
      handlers.onReasoningSummaryDelta?.(payload.delta);
    }
  },
  "framework:plan.delta": (payload, { handlers }) => {
    if (payload.delta) {
      handlers.onPlanDelta?.(payload.delta);
    }
  },
  // `output_item.done` is per-block, not per-turn. Claude can emit it before
  // the overall response is finished, so keep the UI in the in-progress state
  // until the terminal `response.completed` frame.
  "response.output_item.done": (_payload, { handlers }) => {
    handlers.onStatusChange?.("streaming");
  },
  "response.tool.started": (payload, { handlers }) => {
    handlers.onToolStarted?.(payload.tool_result);
  },
  "response.tool.output.delta": (payload, { handlers }) => {
    handlers.onToolDelta?.(payload.item_id, payload.delta);
  },
  "response.tool.completed": (payload, { handlers }) => {
    handlers.onToolCompleted?.(payload.tool_result);
  },
  "framework:approval_required": (payload, { sessionId, handlers }) => {
    // Wire payload omits sessionId and status — synthesize them from context.
    // The persisted Approval row carries both; the SSE-side notification is
    // a slimmer shape because the frontend already knows the session and the
    // approval is by definition pending at request time.
    const approval: Approval = {
      approvalId: payload.approval.approvalId,
      sessionId,
      itemId: payload.approval.itemId,
      kind: payload.approval.kind as Approval["kind"],
      title: payload.approval.title,
      summary: payload.approval.summary,
      status: "pending"
    };
    handlers.onApprovalRequired?.(approval);
  },
  "framework:runtime_notice": (payload, { handlers }) => {
    handlers.onRuntimeNotice?.({
      noticeId: payload.notice.noticeId,
      level: payload.notice.level,
      title: payload.notice.title,
      message: payload.notice.message,
      createdAt: payload.notice.createdAt
    });
  },
  "framework:mcp_server_status": (payload, { handlers }) => {
    handlers.onMcpServerStatus?.({
      serverName: payload.server_name,
      status: payload.status,
      error: payload.error
    });
  },
  "runtime.user_message_replaced": (payload, { handlers }) => {
    handlers.onUserMessageReplaced?.({
      messageId: payload.message_id,
      text: payload.text,
      scanRunId: payload.scan_run_id
    });
  },
  "framework:message_blocked": (payload, { handlers }) => {
    handlers.onMessageBlocked?.({
      reason: payload.reason,
      blockReason: payload.block_reason,
      scanRunId: payload.scan_run_id,
      message: payload.message
    });
  },
  "response.failed": (payload, { handlers, markTerminal }) => {
    markTerminal();
    handlers.onStatusChange?.("error");
    handlers.onFailed?.(payload.error.message);
  },
  "response.completed": (payload, { handlers, markTerminal }) => {
    markTerminal();
    const wireStatus = payload.response.status;
    const status =
      wireStatus === "failed" || wireStatus === "blocked"
        ? "error"
        : wireStatus === "interrupted"
          ? "interrupted"
          : "completed";
    handlers.onComplete(
      status,
      payload.token_usage,
      payload.cost_usd ?? null,
      payload.model_name ?? null
    );
  }
};

function isKnownEventType(event: string): event is SseEventType {
  return Object.prototype.hasOwnProperty.call(eventDispatch, event);
}

// Generic dispatch helper that ties the schema's output type to the matching
// handler input. The function-level generic K eliminates the post-parse
// narrowing cast at the call site — TS knows that for a given K, both
// `SseFrameSchemas[K]` and `eventDispatch[K]` agree on `SseFramePayloads[K]`.
function dispatchFrame<K extends SseEventType>(
  event: K,
  raw: unknown,
  ctx: DispatchContext
): void {
  const schema = SseFrameSchemas[event];
  const parsed = schema.parse(raw) as SseFramePayloads[K];
  eventDispatch[event](parsed, ctx);
}

export async function streamMessage(input: {
  sessionId: string;
  text: string;
  artifactIds?: string[];
  model?: string;
  effort?: EffortLevel;
  signal?: AbortSignal;
} & StreamMessageHandlers): Promise<void> {
  const requestBody: MessagePostRequest = {
    sessionId: input.sessionId,
    text: input.text
  };
  if (input.artifactIds !== undefined) {
    requestBody.artifactIds = input.artifactIds;
  }
  if (input.model !== undefined) {
    requestBody.model = input.model;
  }
  if (input.effort !== undefined) {
    requestBody.effort = input.effort;
  }

  const body = JSON.stringify(requestBody);

  const response = await fetch(buildApiUrl("/messages"), {
    method: "POST",
    headers: createApiHeaders(undefined, body),
    credentials: "include",
    body,
    signal: input.signal
  });

  if (!response.ok || !response.body) {
    throw new Error(await buildErrorMessage(response));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let receivedTerminalEvent = false;
  const ctx: DispatchContext = {
    sessionId: input.sessionId,
    handlers: input,
    markTerminal: () => {
      receivedTerminalEvent = true;
    }
  };

  // Cancel the reader on abort so the read loop below exits promptly.
  const abortListener = () => {
    reader.cancel().catch(() => {
      // The reader may already be closed — ignore.
    });
  };
  if (input.signal) {
    if (input.signal.aborted) {
      abortListener();
    } else {
      input.signal.addEventListener("abort", abortListener, { once: true });
    }
  }

  // Validate-then-dispatch one SSE frame. Schema mismatches throw out of
  // here; the read loop catches and surfaces them via onFailed/onComplete so
  // the UI re-enables the textbox instead of hanging.
  const processFrame = (frame: string) => {
    let event: string | undefined;
    let dataLine: string | undefined;
    for (const line of frame.split("\n")) {
      if (!event && line.startsWith("event: ")) event = line.slice(7);
      else if (!dataLine && line.startsWith("data: ")) dataLine = line;
      if (event && dataLine) break;
    }
    if (!event || !dataLine) return;
    if (!isKnownEventType(event)) return;

    const raw: unknown = JSON.parse(dataLine.slice(6));
    dispatchFrame(event, raw, ctx);
  };

  let parseError: Error | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        try {
          processFrame(frame);
        } catch (err) {
          parseError = err instanceof Error ? err : new Error(String(err));
          break;
        }
      }

      if (parseError) {
        await reader.cancel().catch(() => {
          // The reader may already be closed — ignore.
        });
        break;
      }

      // Once a terminal event has been dispatched, stop awaiting more reads.
      // Node's chunked-encoded close can lag the final data chunk in the
      // browser fetch reader on tool-call turns, leaving the loop hung on
      // reader.read() and the caller's `await streamMessage(...)` unresolved
      // (textbox stays disabled). The terminal event is authoritative.
      if (receivedTerminalEvent) {
        await reader.cancel().catch(() => {
          // The reader may already be closed — ignore.
        });
        break;
      }
    }

    if (!parseError && buffer.trim()) {
      try {
        processFrame(buffer.trim());
      } catch (err) {
        parseError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (parseError) {
      input.onFailed?.(parseError.message);
      input.onComplete("error");
    } else if (!receivedTerminalEvent && !input.signal?.aborted) {
      input.onFailed?.("Connection closed unexpectedly");
      input.onComplete("error");
    }
  } finally {
    input.signal?.removeEventListener("abort", abortListener);
  }
}
