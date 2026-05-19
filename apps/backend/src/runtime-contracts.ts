import { SseFrameSchemas, type SseEventType } from "@cogniplane/shared-types";
import type { EffortLevel } from "@cogniplane/shared-types";
import type { ResolvedRuntimePolicy } from "./services/admin-config-records.js";

export type RuntimeSessionRef = {
  sessionId: string;
  runtimeId: string;
  runtimePolicy: ResolvedRuntimePolicy;
};

export type RuntimeToolKind = "command" | "mcp";
export type RuntimeToolStatus = "in_progress" | "completed" | "failed" | "declined";

export type RuntimeToolCall = {
  itemId: string;
  kind: RuntimeToolKind;
  title: string;
  status: RuntimeToolStatus;
  command: string | null;
  cwd: string | null;
  server: string | null;
  toolName: string | null;
  input: string;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
};

export type RuntimeApprovalKind = "command_execution" | "file_change" | "permissions";
export type RuntimeApprovalDecision = "approve" | "reject";
export type RuntimeReasoningEffort = EffortLevel;
export type RuntimeUserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export type RuntimeEvent =
  | { type: "response.created"; responseId: string }
  | { type: "response.output_text.delta"; responseId: string; delta: string }
  | { type: "framework:reasoning_text.delta"; responseId: string; delta: string }
  | { type: "framework:reasoning_summary.delta"; responseId: string; delta: string }
  | { type: "framework:plan.delta"; responseId: string; delta: string }
  | { type: "response.output_item.done"; responseId: string }
  | {
      type: "response.tool.started";
      responseId: string;
      toolCall: RuntimeToolCall;
    }
  | {
      type: "response.tool.output.delta";
      responseId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "response.tool.completed";
      responseId: string;
      toolCall: RuntimeToolCall;
    }
  | {
      type: "framework:approval_required";
      responseId: string;
      approvalId: string;
      itemId: string;
      kind: RuntimeApprovalKind;
      title: string;
      summary: string;
      availableDecisions: RuntimeApprovalDecision[];
      command: string | null;
      cwd: string | null;
    }
  | {
      type: "framework:runtime_notice";
      responseId: string;
      noticeId: string;
      level: "info" | "warning" | "error";
      title: string;
      message: string;
      createdAt: string;
    }
  | {
      type: "response.completed";
      responseId: string;
      /**
       * Terminal disposition. Defaults to "completed". `"interrupted"` is set
       * when the user clicks Stop mid-turn — the partial assistant text is
       * persisted and the UI renders an in-bubble "Stopped" badge instead of
       * a red error.
       *
       * Token usage + cost are NOT carried on this event. The LLM proxy
       * persists them directly to `messages.cost_usd` / `messages.input_tokens`
       * / etc., and the frontend reads them from the messages row.
       */
      interrupted?: boolean;
    }
  | { type: "response.failed"; responseId: string; message: string }
  | {
      type: "framework:mcp_server_status";
      serverName: string;
      status: "starting" | "ready" | "failed" | "cancelled";
      error?: string;
    };

// ---------------------------------------------------------------------------
// Wire format: RuntimeEvent → SSE frame
//
// Pure mapping from the internal event union to the {event, data} pair emitted
// on the browser-facing SSE stream. Kept here so mappers, the stream writer,
// and any future transport share one source of truth.
// ---------------------------------------------------------------------------

export type SSEFrame = { event: string; data: Record<string, unknown> };

type ToolResultPayload = {
  toolResultId: string;
  kind: RuntimeToolKind;
  title: string;
  status: RuntimeToolStatus;
  command: string | null;
  cwd: string | null;
  server: string | null;
  toolName: string | null;
  input: string;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
};

function toolResultPayload(
  toolCall: RuntimeToolCall,
  overrides?: { output?: string; exitCode?: number | null; durationMs?: number | null }
): ToolResultPayload {
  return {
    toolResultId: toolCall.itemId,
    kind: toolCall.kind,
    title: toolCall.title,
    status: toolCall.status,
    command: toolCall.command,
    cwd: toolCall.cwd,
    server: toolCall.server,
    toolName: toolCall.toolName,
    input: toolCall.input,
    output: overrides?.output ?? toolCall.output,
    exitCode: overrides?.exitCode !== undefined ? overrides.exitCode : toolCall.exitCode,
    durationMs: overrides?.durationMs !== undefined ? overrides.durationMs : toolCall.durationMs
  };
}

export function sseFrame(event: string, data: unknown): string {
  // Validate emit-side against the shared SSE schema. Drift between this
  // mapper and the frontend's `.parse()` becomes a contract-violation
  // throw in tests rather than a silent UI corruption.
  if (event in SseFrameSchemas) {
    const schema = SseFrameSchemas[event as SseEventType];
    const result = schema.safeParse(data);
    if (!result.success) {
      const summary = result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      if (process.env.NODE_ENV !== "production") {
        console.error(`[sse-frame] contract violation on "${event}": ${summary}`);
      }
      throw new Error(`SSE frame "${event}" does not match contract: ${summary}`);
    }
  }
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// `itemId` is the assistant message id for text/reasoning/plan/notice events,
// and the tool call's itemId for tool events. Callers that don't have an
// assistant message id yet (e.g. mcp_server_status) pass null.
export function runtimeEventToSSEFrame(
  event: RuntimeEvent,
  itemId: string | null
): SSEFrame {
  switch (event.type) {
    case "framework:mcp_server_status":
      return {
        event: event.type,
        data: {
          type: event.type,
          server_name: event.serverName,
          status: event.status,
          error: event.error ?? null
        }
      };

    case "response.created":
      return {
        event: event.type,
        data: { type: event.type, response: { id: event.responseId, status: "in_progress" } }
      };

    case "response.output_text.delta":
    case "framework:reasoning_text.delta":
    case "framework:reasoning_summary.delta":
    case "framework:plan.delta":
      return {
        event: event.type,
        data: {
          type: event.type,
          response_id: event.responseId,
          item_id: itemId,
          delta: event.delta
        }
      };

    case "response.output_item.done":
      return {
        event: event.type,
        data: { type: event.type, response_id: event.responseId, item_id: itemId }
      };

    case "response.tool.started":
    case "response.tool.completed": {
      const payload =
        event.type === "response.tool.started"
          ? toolResultPayload(event.toolCall, { output: "", exitCode: null, durationMs: null })
          : toolResultPayload(event.toolCall);
      return {
        event: event.type,
        data: {
          type: event.type,
          response_id: event.responseId,
          item_id: event.toolCall.itemId,
          tool_result: payload
        }
      };
    }

    case "response.tool.output.delta":
      return {
        event: event.type,
        data: {
          type: event.type,
          response_id: event.responseId,
          item_id: event.itemId,
          delta: event.delta
        }
      };

    case "framework:approval_required":
      return {
        event: event.type,
        data: {
          type: event.type,
          response_id: event.responseId,
          approval: {
            approvalId: event.approvalId,
            itemId: event.itemId,
            kind: event.kind,
            title: event.title,
            summary: event.summary,
            availableDecisions: event.availableDecisions,
            command: event.command,
            cwd: event.cwd
          }
        }
      };

    case "framework:runtime_notice":
      return {
        event: event.type,
        data: {
          type: event.type,
          response_id: event.responseId,
          item_id: itemId,
          notice: {
            noticeId: event.noticeId,
            level: event.level,
            title: event.title,
            message: event.message,
            createdAt: event.createdAt
          }
        }
      };

    case "response.completed":
      return {
        event: event.type,
        data: {
          type: event.type,
          response: {
            id: event.responseId,
            status: event.interrupted ? "interrupted" : "completed"
          }
        }
      };

    case "response.failed":
      return {
        event: event.type,
        data: {
          type: event.type,
          response: { id: event.responseId, status: "failed" },
          error: { message: event.message }
        }
      };
  }
}

export function extractToolResultPayload(
  toolCall: RuntimeToolCall,
  overrides?: { output?: string; exitCode?: number | null; durationMs?: number | null }
): ToolResultPayload {
  return toolResultPayload(toolCall, overrides);
}

export interface RuntimeAdapter {
  readonly id: string;
  hasActiveTurn(sessionId: string): boolean;
  /**
   * Returns true when this adapter currently holds in-memory state for the
   * given session (e.g. a live child process or SDK query). Used by routes
   * that must route session-level actions to the owning adapter instead of
   * fanning out to every registered runtime.
   */
  hasSession?(sessionId: string): boolean;
  /**
   * Returns true when this adapter owns the specific runtime instance for the
   * given session. This is stricter than `hasSession` and lets the framework
   * disambiguate when multiple providers have live state for the same
   * conversation.
   */
  hasRuntime?(sessionId: string, runtimeId: string): boolean;
  createSession(input: { tenantId: string; sessionId: string; userId: string }): Promise<RuntimeSessionRef>;
  runMessage(
    session: RuntimeSessionRef,
    input: {
      prompt: string;
      userInputs?: RuntimeUserInput[];
      runtimePolicyId: string;
      toolContextId: string | null;
      assistantMessageId?: string | null;
      model?: string;
      effort?: RuntimeReasoningEffort;
      onBeforeTurn?: () => Promise<void>;
    }
  ): AsyncIterable<RuntimeEvent>;
  abortSession(input: { tenantId: string; sessionId: string; userId: string }): Promise<void>;
  /**
   * Stop the in-flight turn for `sessionId` while keeping the session warm.
   * Returns `"interrupted"` when an active turn was signalled, `"no_active_turn"`
   * when there was nothing to stop. Implementations must:
   *   - emit a terminal `response.completed` RuntimeEvent with `interrupted: true`
   *     so any partial assistant text is persisted with status `"interrupted"`,
   *   - leave the runtime/session itself alive (do NOT shut the process down) so
   *     the user can immediately send a follow-up message in the same context.
   */
  interruptTurn?(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<"interrupted" | "no_active_turn">;
  readRuntimeFile?(sessionId: string, filePath: string): Promise<Uint8Array>;
  writeRuntimeFile?(sessionId: string, filePath: string, data: Uint8Array | ArrayBuffer | string): Promise<string>;
  /**
   * Forward an approval decision to whichever in-flight turn is waiting on it.
   * Returns `"resolved"` when this adapter owned the approval, `"missing"`
   * when it didn't (the route falls through to the next adapter). Optional:
   * adapters that have no approval flow omit it.
   */
  resolveApproval?(input: {
    tenantId: string;
    approvalId: string;
    userId: string;
    decision: RuntimeApprovalDecision;
    rememberForTurn?: boolean;
  }): Promise<"resolved" | "missing">;
  /**
   * Tear down every active runtime owned by this adapter for `tenantId` after
   * an admin flips an integration toggle. The next turn rebuilds with the new
   * tool catalog. Returns the session ids that were invalidated. Optional:
   * adapters with no integration coupling omit it.
   */
  invalidateIntegrationRuntimesForTenant?(
    tenantId: string,
    integrationId: string
  ): Promise<string[]>;
  close?(): Promise<void>;
}
