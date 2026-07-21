import type { BaseEvent } from "@ag-ui/client";

import { SseFrameSchemas, type SseEventType } from "@cogniplane/shared-types";
import type { EffortLevel, UiResource } from "@cogniplane/shared-types";
import type { ResolvedRuntimePolicy } from "./services/admin-config-records.js";

export type RuntimeSessionRef = {
  sessionId: string;
  runtimeId: string;
  runtimePolicy: ResolvedRuntimePolicy;
};

// Thrown by an adapter's runMessage when the session already has a turn in
// flight. Lives here (not in an adapter module) because both adapters throw it
// and the slot must be reserved synchronously inside each adapter — the route
// registry is per-process and the scheduler bypasses it entirely.
export class SessionBusyError extends Error {
  constructor(sessionId: string) {
    super(`A turn is already running for session ${sessionId}.`);
  }
}

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
  // MCP Apps UI resource blocks returned by the tool, if any.
  uiResources?: UiResource[];
};

// `mcp_tool` is distinct from `command_execution` on purpose: the adapter's
// HITL interceptor gates ALL tool kinds, so an MCP tool call and a shell
// command must not share a "remember for this turn" bucket — otherwise
// approving one benign shell command would silently auto-approve every MCP
// write for the rest of the turn.
export type RuntimeApprovalKind = "command_execution" | "file_change" | "permissions" | "mcp_tool";
export type RuntimeApprovalDecision = "approve" | "reject";

// How a Policy Center–routed tool-call approval resolved: a human decision or a
// TTL expiry. Shared by the gateway router and every adapter's approval method.
export type PolicyApprovalDisposition = "approve" | "reject" | "expired";

// The request the MCP gateway hands to the session-owning adapter to route a
// Policy Center `require_approval`. One shape, reused at every hop (the gateway
// router type, the adapter method, and the per-adapter coordinator) so the call
// isn't re-described field-by-field at each boundary.
export type PolicyApprovalRouteInput = {
  tenantId: string;
  sessionId: string;
  userId: string;
  runtimeId: string | null;
  toolName: string;
  serverId: string | null;
  kind: RuntimeApprovalKind;
  explanation: string;
  /**
   * Aborts when the gateway's held HTTP response dies before a decision lands
   * (the runtime's HTTP client timed out or the sandbox went away). The
   * coordinator releases the hold and expires the approval so a late human
   * approve can't dispatch a tool call nobody is waiting for.
   */
  signal?: AbortSignal;
};
export type RuntimeReasoningEffort = EffortLevel;
export type RuntimeUserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export type RuntimeEvent =
  | { type: "response.created"; responseId: string }
  | { type: "response.output_text.delta"; responseId: string; delta: string }
  // Whole-text replacement of the assistant text streamed so far this turn.
  // Emitted when the runtime retracts already-streamed content (Claude model
  // refusal fallback); consumers overwrite their accumulated buffer.
  | { type: "response.output_text.replace"; responseId: string; text: string }
  // Same retraction semantics for the reasoning pane: refused-leg thinking
  // must not survive alongside the fallback's reasoning.
  | { type: "framework:reasoning_summary.replace"; responseId: string; text: string }
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
  // Tool events emitted under a since-retracted message (Claude refusal
  // fallback): downstream deletes the persisted rows and removes the cards.
  | { type: "response.tool.retracted"; responseId: string; itemIds: string[] }
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
       * Token usage + cost are NOT carried on this event. The in-process
       * runtime adapter persists them directly to `messages.cost_usd` /
       * `messages.input_tokens` / etc., and the frontend reads them from the
       * messages row.
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
  uiResources?: UiResource[];
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
    durationMs: overrides?.durationMs !== undefined ? overrides.durationMs : toolCall.durationMs,
    ...(toolCall.uiResources && toolCall.uiResources.length > 0
      ? { uiResources: toolCall.uiResources }
      : {})
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

    case "response.output_text.replace":
    case "framework:reasoning_summary.replace":
      return {
        event: event.type,
        data: {
          type: event.type,
          response_id: event.responseId,
          item_id: itemId,
          text: event.text
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

    case "response.tool.retracted":
      return {
        event: event.type,
        data: {
          type: event.type,
          response_id: event.responseId,
          item_id: itemId,
          item_ids: event.itemIds
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

// Deep Agents is the sole runtime adapter (the Codex/Claude-Code adapters and
// their registry were retired in 2026-06/07). The methods below are therefore
// all required — the optional `?.`-guarded surface that once let the framework
// fan actions across multiple providers is gone.
export interface RuntimeAdapter {
  readonly id: string;
  hasActiveTurn(sessionId: string): boolean;
  /**
   * True when this adapter holds live in-memory state for the session. Used to
   * route file-op managed tools only to a runtime that owns the active turn's
   * workspace (see resolveOwningFileAdapter).
   */
  hasSession(sessionId: string): boolean;
  /**
   * True when this adapter owns the specific runtime instance for the session —
   * stricter than `hasSession`, used to disambiguate a stale workspace from the
   * live one.
   */
  hasRuntime(sessionId: string, runtimeId: string): boolean;
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
  /**
   * AG-UI counterpart to {@link runMessage}: drives one turn and yields AG-UI
   * `BaseEvent`s (the wire CopilotKit consumes) instead of `RuntimeEvent`s.
   * Same session/tenant/toolContext/approval plane; only the emitted vocabulary
   * differs. Declared here so the `?format=agui` route passes the adapter to
   * `streamAssistantReplyAGUI` without a cast — signature drift is a type error.
   */
  runMessageAGUI(
    session: RuntimeSessionRef,
    input: {
      prompt: string;
      userInputs?: RuntimeUserInput[];
      toolContextId: string | null;
      assistantMessageId?: string | null;
      model?: string;
      effort?: RuntimeReasoningEffort;
      onBeforeTurn?: () => Promise<void>;
    }
  ): AsyncIterable<BaseEvent>;
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
  interruptTurn(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<"interrupted" | "no_active_turn">;
  readRuntimeFile(sessionId: string, filePath: string): Promise<Uint8Array>;
  /**
   * Size of a workspace file without reading it. Used to reject oversized
   * `write_artifact` filePath inputs before buffering the bytes.
   */
  statRuntimeFile(sessionId: string, filePath: string): Promise<{ sizeBytes: number }>;
  writeRuntimeFile(sessionId: string, filePath: string, data: Uint8Array | ArrayBuffer | string): Promise<string>;
  /**
   * Forward an approval decision to the in-flight turn waiting on it. Returns
   * `"resolved"` when the approval was owned, `"missing"` when no matching
   * pending approval exists.
   */
  resolveApproval(input: {
    tenantId: string;
    approvalId: string;
    userId: string;
    decision: RuntimeApprovalDecision;
    rememberForTurn?: boolean;
  }): Promise<"resolved" | "missing">;
  /**
   * Route a Policy Center approval for an MCP tool call and resolve when the
   * human decides (or the TTL expires). Unlike the runtime's native approvals
   * (shell/file actions, which the runtime itself initiates over JSON-RPC),
   * this is driven by the MCP gateway holding its HTTP response open: the
   * adapter emits the `framework:approval_required` SSE event to its active
   * turn, persists the approval row, and the existing
   * `POST /approvals/:id/decision` → {@link resolveApproval} path settles it.
   *
   * Returns the disposition the gateway uses to allow or refuse the tool call.
   * With no active turn to host the prompt, the gateway degrades an
   * enforce-mode require_approval to a deny.
   */
  requestPolicyApproval(input: PolicyApprovalRouteInput): Promise<PolicyApprovalDisposition>;
  /**
   * Delete durable per-session runtime data (e.g. checkpointer threads) after
   * the session row itself is deleted. Unlike {@link abortSession} — which
   * also fires on idle teardown and config invalidation and must NOT destroy
   * conversation state — this is called only from session deletion. Idempotent.
   */
  purgeSessionData(input: {
    tenantId: string;
    sessionId: string;
    userId: string;
  }): Promise<void>;
  /**
   * Tear down every active runtime for `tenantId` after tenant settings that
   * are snapshotted into runtime config change (also covers admin integration
   * toggles). The next turn rebuilds with the new policy/tool settings. Returns
   * the invalidated session ids.
   */
  invalidateTenantRuntimes(tenantId: string): Promise<string[]>;
  /**
   * Tear down every active runtime for a specific user after they (re)connect
   * or disconnect an integration (the credentials in their live sandbox are now
   * stale). User-scoped counterpart to {@link invalidateTenantRuntimes}.
   */
  invalidateRuntimesForIntegration(
    tenantId: string,
    userId: string,
    integrationId: string
  ): Promise<string[]>;
  close(): Promise<void>;
}
