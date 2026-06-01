
import type { RuntimeEvent, RuntimeToolCall } from "../../runtime-contracts.js";
import { uuidv7 } from "../../lib/uuid.js";

type JsonRpcNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type ActiveTurnSnapshot = {
  responseId: string | null;
  outputItemDone: boolean;
};

// Discriminated union for all item shapes received from the runtime process.
// A single cast to this union replaces the two-step "check type, re-cast payload" pattern.
type CommandExecutionItem = {
  type: "commandExecution";
  id: string;
  command?: string | null;
  cwd?: string | null;
  status?: string | null;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
};

type McpToolCallItem = {
  type: "mcpToolCall";
  id: string;
  server?: string | null;
  tool?: string | null;
  status?: string | null;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  durationMs?: number | null;
};

type FileChangeItem = {
  type: "fileChange";
  id: string;
  filePath?: string | null;
  status?: string | null;
  aggregatedOutput?: string | null;
  durationMs?: number | null;
};

type AgentMessageItem = {
  type: "agentMessage";
  id?: string;
};

// Codex emits a `webSearch` thread item when native web search runs (config
// key `web_search`). Shape per WebSearchThreadItem in the v2 app-server schema:
// { id, query, type: "webSearch", action?: WebSearchAction | null }. There is
// no status field — Codex reports the item once the search resolves.
type WebSearchItem = {
  type: "webSearch";
  id: string;
  query?: string | null;
  action?: unknown;
};

type RuntimeItem =
  | CommandExecutionItem
  | McpToolCallItem
  | FileChangeItem
  | AgentMessageItem
  | WebSearchItem
  | { type: string; id?: string };

type NotificationMapping =
  | { kind: "none" }
  | { kind: "events"; events: RuntimeEvent[] }
  | {
      kind: "tool";
      events: RuntimeEvent[];
      toolCall: RuntimeToolCall;
      phase: "started" | "completed" | "failed";
    }
  | { kind: "runtime-error"; message: string; retrying: boolean }
  | { kind: "turn-completed"; completed: boolean; failureMessage: string }
  | {
      kind: "mcp-server-status";
      serverName: string;
      status: "starting" | "ready" | "failed" | "cancelled";
      error?: string;
    };

function mapCommandExecutionStatus(status: unknown): "in_progress" | "completed" | "failed" | "declined" {
  switch (status) {
    case "completed":
    case "failed":
    case "declined":
      return status;
    default:
      return "in_progress";
  }
}

function mapMcpStatus(status: unknown): "in_progress" | "completed" | "failed" {
  switch (status) {
    case "completed":
    case "failed":
      return status;
    default:
      return "in_progress";
  }
}

function buildCommandToolCall(item: {
  id: string;
  command?: string | null;
  cwd?: string | null;
  status?: string | null;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}): RuntimeToolCall {
  return {
    itemId: item.id,
    kind: "command",
    title: "Shell command",
    status: mapCommandExecutionStatus(item.status),
    command: item.command ?? null,
    cwd: item.cwd ?? null,
    server: null,
    toolName: null,
    input: item.command ?? "",
    output: item.aggregatedOutput ?? "",
    exitCode: item.exitCode ?? null,
    durationMs: item.durationMs ?? null
  };
}

function buildMcpToolCall(item: {
  id: string;
  server?: string | null;
  tool?: string | null;
  status?: string | null;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  durationMs?: number | null;
}): RuntimeToolCall {
  const output =
    item.error != null ? JSON.stringify(item.error) : item.result != null ? JSON.stringify(item.result) : "";

  return {
    itemId: item.id,
    kind: "mcp",
    title: item.tool ? `Tool: ${item.tool}` : "MCP tool call",
    status: mapMcpStatus(item.status),
    command: null,
    cwd: null,
    server: item.server ?? null,
    toolName: item.tool ?? null,
    input: item.arguments != null ? JSON.stringify(item.arguments) : "",
    output,
    exitCode: null,
    durationMs: item.durationMs ?? null
  };
}

function buildFileChangeToolCall(item: {
  id: string;
  filePath?: string | null;
  status?: string | null;
  aggregatedOutput?: string | null;
  durationMs?: number | null;
}): RuntimeToolCall {
  return {
    itemId: item.id,
    kind: "command",
    title: item.filePath ? `File: ${item.filePath}` : "File change",
    status: mapCommandExecutionStatus(item.status),
    command: item.filePath ?? null,
    cwd: null,
    server: null,
    toolName: null,
    input: item.filePath ?? "",
    output: item.aggregatedOutput ?? "",
    exitCode: null,
    durationMs: item.durationMs ?? null
  };
}

function buildWebSearchToolCall(
  item: { id: string; query?: string | null; action?: unknown },
  status: "in_progress" | "completed"
): RuntimeToolCall {
  const query = item.query ?? "";
  // Reuse the "mcp" tool kind so the activity renders through the existing
  // tool-call timeline/admin paths. `toolName: "web_search"` + a null server
  // is enough for the frontend to classify it as a generic tool call.
  return {
    itemId: item.id,
    kind: "mcp",
    title: query ? `Web search: ${query}` : "Web search",
    status,
    command: null,
    cwd: null,
    server: null,
    toolName: "web_search",
    input: query,
    output: item.action != null ? JSON.stringify(item.action) : "",
    exitCode: null,
    durationMs: null
  };
}

function getNotificationErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }

  return fallback;
}

export function mapRuntimeNotification(
  activeTurn: ActiveTurnSnapshot,
  notification: JsonRpcNotification
): NotificationMapping {
  switch (notification.method) {
    case "item/agentMessage/delta": {
      const delta = notification.params?.delta;
      if (typeof delta !== "string") {
        return { kind: "none" };
      }

      return {
        kind: "events",
        events: [
          {
            type: "response.output_text.delta",
            responseId: activeTurn.responseId ?? uuidv7(),
            delta
          }
        ]
      };
    }

    case "item/reasoning/textDelta": {
      const delta = notification.params?.delta;
      if (typeof delta !== "string") {
        return { kind: "none" };
      }

      return {
        kind: "events",
        events: [
          {
            type: "framework:reasoning_text.delta",
            responseId: activeTurn.responseId ?? uuidv7(),
            delta
          }
        ]
      };
    }

    case "item/reasoning/summaryTextDelta": {
      const delta = notification.params?.delta;
      if (typeof delta !== "string") {
        return { kind: "none" };
      }

      return {
        kind: "events",
        events: [
          {
            type: "framework:reasoning_summary.delta",
            responseId: activeTurn.responseId ?? uuidv7(),
            delta
          }
        ]
      };
    }

    case "item/completed": {
      const item = notification.params?.item as RuntimeItem | undefined;

      if (item?.type === "commandExecution") {
        if (!item.id) {
          return { kind: "none" };
        }
        const cmdItem = item as CommandExecutionItem;
        const toolCall = buildCommandToolCall(cmdItem);
        return {
          kind: "tool",
          events: [
            {
              type: "response.tool.completed",
              responseId: activeTurn.responseId ?? uuidv7(),
              toolCall
            }
          ],
          toolCall,
          phase: "completed"
        };
      }

      if (item?.type === "mcpToolCall") {
        if (!item.id) {
          return { kind: "none" };
        }
        const mcpItem = item as McpToolCallItem;
        const toolCall = buildMcpToolCall(mcpItem);
        return {
          kind: "tool",
          events: [
            {
              type: "response.tool.completed",
              responseId: activeTurn.responseId ?? uuidv7(),
              toolCall
            }
          ],
          toolCall,
          phase: toolCall.status === "failed" ? "failed" : "completed"
        };
      }

      if (item?.type === "fileChange") {
        if (!item.id) {
          return { kind: "none" };
        }
        const fileItem = item as FileChangeItem;
        const toolCall = buildFileChangeToolCall(fileItem);
        return {
          kind: "tool",
          events: [
            {
              type: "response.tool.completed",
              responseId: activeTurn.responseId ?? uuidv7(),
              toolCall
            }
          ],
          toolCall,
          phase: toolCall.status === "failed" ? "failed" : "completed"
        };
      }

      if (item?.type === "webSearch") {
        if (!item.id) {
          return { kind: "none" };
        }
        const toolCall = buildWebSearchToolCall(item as WebSearchItem, "completed");
        return {
          kind: "tool",
          events: [
            {
              type: "response.tool.completed",
              responseId: activeTurn.responseId ?? uuidv7(),
              toolCall
            }
          ],
          toolCall,
          phase: "completed"
        };
      }

      if (item?.type === "agentMessage" && !activeTurn.outputItemDone) {
        return {
          kind: "events",
          events: [
            {
              type: "response.output_item.done",
              responseId: activeTurn.responseId ?? uuidv7()
            }
          ]
        };
      }

      return { kind: "none" };
    }

    case "item/started": {
      const item = notification.params?.item as RuntimeItem | undefined;

      if (item?.type === "commandExecution" && item.id) {
        const cmdItem = item as CommandExecutionItem;
        const toolCall = buildCommandToolCall(cmdItem);
        return {
          kind: "tool",
          events: [
            {
              type: "response.tool.started",
              responseId: activeTurn.responseId ?? uuidv7(),
              toolCall
            }
          ],
          toolCall,
          phase: "started"
        };
      }

      if (item?.type === "mcpToolCall" && item.id) {
        const mcpItem = item as McpToolCallItem;
        const toolCall = buildMcpToolCall(mcpItem);
        return {
          kind: "tool",
          events: [
            {
              type: "response.tool.started",
              responseId: activeTurn.responseId ?? uuidv7(),
              toolCall
            }
          ],
          toolCall,
          phase: "started"
        };
      }

      if (item?.type === "fileChange" && item.id) {
        const fileItem = item as FileChangeItem;
        const toolCall = buildFileChangeToolCall(fileItem);
        return {
          kind: "tool",
          events: [
            {
              type: "response.tool.started",
              responseId: activeTurn.responseId ?? uuidv7(),
              toolCall
            }
          ],
          toolCall,
          phase: "started"
        };
      }

      if (item?.type === "webSearch" && item.id) {
        const toolCall = buildWebSearchToolCall(item as WebSearchItem, "in_progress");
        return {
          kind: "tool",
          events: [
            {
              type: "response.tool.started",
              responseId: activeTurn.responseId ?? uuidv7(),
              toolCall
            }
          ],
          toolCall,
          phase: "started"
        };
      }

      return { kind: "none" };
    }

    case "item/commandExecution/outputDelta": {
      const itemId = notification.params?.itemId;
      const delta = notification.params?.delta;
      if (typeof itemId !== "string" || typeof delta !== "string") {
        return { kind: "none" };
      }

      return {
        kind: "events",
        events: [
          {
            type: "response.tool.output.delta",
            responseId: activeTurn.responseId ?? uuidv7(),
            itemId,
            delta
          }
        ]
      };
    }

    case "item/fileChange/outputDelta": {
      const itemId = notification.params?.itemId;
      const delta = notification.params?.delta;
      if (typeof itemId !== "string" || typeof delta !== "string") {
        return { kind: "none" };
      }

      return {
        kind: "events",
        events: [
          {
            type: "response.tool.output.delta",
            responseId: activeTurn.responseId ?? uuidv7(),
            itemId,
            delta
          }
        ]
      };
    }

    case "item/plan/delta": {
      const delta = notification.params?.delta;
      if (typeof delta !== "string") {
        return { kind: "none" };
      }

      return {
        kind: "events",
        events: [
          {
            type: "framework:plan.delta",
            responseId: activeTurn.responseId ?? uuidv7(),
            delta
          }
        ]
      };
    }

    case "item/mcpToolCall/progress": {
      const itemId = notification.params?.itemId;
      const delta = notification.params?.message;
      if (typeof itemId !== "string" || typeof delta !== "string") {
        return { kind: "none" };
      }

      return {
        kind: "events",
        events: [
          {
            type: "response.tool.output.delta",
            responseId: activeTurn.responseId ?? uuidv7(),
            itemId,
            delta: `${delta}
`
          }
        ]
      };
    }

    case "thread/tokenUsage/updated":
      // Token usage is captured by the LLM proxy now (single source of
      // truth, sandbox-tamper-resistant). Drop the Codex-reported usage
      // notification.
      return { kind: "none" };

    case "error":
      return {
        kind: "runtime-error",
        message: getNotificationErrorMessage(notification.params?.error, "Runtime error"),
        retrying: notification.params?.willRetry === true
      };

    case "codex/event/stream_error":
      return {
        kind: "runtime-error",
        message: getNotificationErrorMessage(
          notification.params?.msg ?? notification.params?.error,
          "Runtime stream error"
        ),
        retrying: true
      };

    case "codex/event/error":
      return {
        kind: "runtime-error",
        message: getNotificationErrorMessage(
          notification.params?.msg ?? notification.params?.error,
          "Runtime error"
        ),
        retrying: false
      };

    case "mcpServer/startupStatus/updated": {
      const name = notification.params?.name;
      const status = notification.params?.status;
      if (typeof name !== "string" || typeof status !== "string") {
        return { kind: "none" };
      }
      const validStatus = status as "starting" | "ready" | "failed" | "cancelled";
      const error = typeof notification.params?.error === "string" ? notification.params.error : undefined;
      return { kind: "mcp-server-status", serverName: name, status: validStatus, error };
    }

    case "turn/completed": {
      const turn = notification.params?.turn as
        | {
            status?: string;
            error?: { message?: string | null } | null;
          }
        | undefined;

      return {
        kind: "turn-completed",
        completed: turn?.status === "completed",
        failureMessage: turn?.error?.message ?? "Turn failed"
      };
    }

    default:
      return { kind: "none" };
  }
}
