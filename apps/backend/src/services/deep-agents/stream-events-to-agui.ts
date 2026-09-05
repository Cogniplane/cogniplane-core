import { EventType, type BaseEvent } from "@ag-ui/client";
import type { UiResource } from "@cogniplane/shared-types";

import { uuidv7 } from "../../lib/uuid.js";
import { customEvent } from "./agui-events.js";
import { withoutPolicyApprovalMetadata } from "../policy/policy-approval-proof.js";

export type DeepAgentsStreamEvent = Record<string, unknown>;

type ToolKind = "command" | "mcp";
type ToolStatus = "in_progress" | "completed" | "failed";

type PendingToolCall = {
  itemId: string;
  kind: ToolKind;
  title: string;
  status: ToolStatus;
  command: string | null;
  server: string | null;
  toolName: string;
  input: string;
  output: string;
  durationMs: number | null;
  uiResources?: UiResource[];
  startedAt: number;
};

export type StreamEventsToAGUIState = {
  pendingToolCalls: Map<string, PendingToolCall>;
  planMarkdown: string;
  emittedTextThisRun: boolean;
  textMessageId: string | null;
  reasoningMessageId: string | null;
};

export type StreamEventsToAGUIOptions = {
  mcpToolNames?: ReadonlySet<string>;
  mcpToolServers?: ReadonlyMap<string, string>;
};

export function createStreamEventsToAGUIState(): StreamEventsToAGUIState {
  return {
    pendingToolCalls: new Map(),
    planMarkdown: "",
    emittedTextThisRun: false,
    textMessageId: null,
    reasoningMessageId: null
  };
}

export function streamEventsToAGUI(
  state: StreamEventsToAGUIState,
  event: DeepAgentsStreamEvent,
  options: StreamEventsToAGUIOptions = {}
): BaseEvent[] {
  const kind = typeof event.event === "string" ? event.event : undefined;
  if (!kind || !isRootNamespace(event)) return [];

  switch (kind) {
    case "on_chat_model_stream":
      return mapModelStreamChunk(state, event);
    case "on_chat_model_end":
      return mapModelRunEnd(state);
    case "on_tool_start":
      return mapToolStart(state, event, options);
    case "on_tool_end":
      return mapToolEnd(state, event);
    default:
      return [];
  }
}

export function flushOpenAGUIMessages(state: StreamEventsToAGUIState): BaseEvent[] {
  return closeText(state).concat(closeReasoning(state));
}

function isRootNamespace(event: DeepAgentsStreamEvent): boolean {
  const metadata = event.metadata as Record<string, unknown> | undefined;
  const namespace = metadata?.langgraph_checkpoint_ns;
  if (namespace === undefined || namespace === null || namespace === "") return true;
  return typeof namespace === "string" && !namespace.includes("|");
}

function mapModelStreamChunk(
  state: StreamEventsToAGUIState,
  event: DeepAgentsStreamEvent
): BaseEvent[] {
  const data = event.data as Record<string, unknown> | undefined;
  const chunk = data?.chunk as Record<string, unknown> | undefined;
  if (!chunk) return [];

  const events: BaseEvent[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    state.emittedTextThisRun = true;
    events.push(...openText(state, text));
  };
  const pushReasoning = (text: string) => {
    if (text) events.push(...openReasoning(state, text));
  };

  if (typeof chunk.content === "string") {
    pushText(chunk.content);
    return events;
  }
  if (!Array.isArray(chunk.content)) return events;

  for (const block of chunk.content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      pushText(record.text);
    } else if (record.type === "thinking" && typeof record.thinking === "string") {
      pushReasoning(record.thinking);
    } else if (record.type === "reasoning" && typeof record.reasoning === "string") {
      pushReasoning(record.reasoning);
    }
  }
  return events;
}

function mapModelRunEnd(state: StreamEventsToAGUIState): BaseEvent[] {
  if (!state.emittedTextThisRun) return [];
  state.emittedTextThisRun = false;
  return closeText(state);
}

const PLAN_TOOL_NAME = "write_todos";

function mapToolStart(
  state: StreamEventsToAGUIState,
  event: DeepAgentsStreamEvent,
  options: StreamEventsToAGUIOptions
): BaseEvent[] {
  const name = typeof event.name === "string" ? event.name : "tool";
  const runId = typeof event.run_id === "string" ? event.run_id : uuidv7();
  const data = event.data as Record<string, unknown> | undefined;
  const extractedInput = extractToolInput(data?.input);
  const input = extractedInput ? withoutPolicyApprovalMetadata(extractedInput) : null;

  if (name === PLAN_TOOL_NAME) return emitPlanDelta(state, input);

  const isMcp = options.mcpToolNames?.has(name) ?? false;
  const call: PendingToolCall = {
    itemId: runId,
    kind: isMcp ? "mcp" : "command",
    title: isMcp ? `Tool: ${name}` : name,
    status: "in_progress",
    command: extractShellCommand(name, input),
    server: isMcp ? (options.mcpToolServers?.get(name) ?? null) : null,
    toolName: name,
    input: JSON.stringify(input ?? {}),
    output: "",
    durationMs: null,
    startedAt: Date.now()
  };
  state.pendingToolCalls.set(runId, call);
  return startTool(state, call);
}

function mapToolEnd(state: StreamEventsToAGUIState, event: DeepAgentsStreamEvent): BaseEvent[] {
  const name = typeof event.name === "string" ? event.name : "tool";
  if (name === PLAN_TOOL_NAME) return [];

  const runId = typeof event.run_id === "string" ? event.run_id : null;
  if (!runId) return [];
  const call = state.pendingToolCalls.get(runId);
  if (!call) return [];
  state.pendingToolCalls.delete(runId);

  const data = event.data as Record<string, unknown> | undefined;
  const { output, isError, uiResources } = extractToolOutput(data?.output);
  call.status = isError ? "failed" : "completed";
  call.output =
    output ||
    (uiResources.length > 0
      ? uiResources.map((resource) => `[interactive UI: ${resource.uri}]`).join("\n")
      : "");
  call.durationMs = Math.max(0, Date.now() - call.startedAt);
  if (uiResources.length > 0) call.uiResources = uiResources;
  return completeTool(call);
}

function openText(state: StreamEventsToAGUIState, delta: string): BaseEvent[] {
  if (!delta) return [];
  const events = closeReasoning(state);
  if (state.textMessageId === null) {
    state.textMessageId = uuidv7();
    events.push({
      type: EventType.TEXT_MESSAGE_START,
      messageId: state.textMessageId,
      role: "assistant"
    } as BaseEvent);
  }
  events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: state.textMessageId, delta } as BaseEvent);
  return events;
}

function closeText(state: StreamEventsToAGUIState): BaseEvent[] {
  if (state.textMessageId === null) return [];
  const messageId = state.textMessageId;
  state.textMessageId = null;
  return [{ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent];
}

function openReasoning(state: StreamEventsToAGUIState, delta: string): BaseEvent[] {
  if (!delta) return [];
  const events: BaseEvent[] = [];
  if (state.reasoningMessageId === null) {
    state.reasoningMessageId = uuidv7();
    events.push({
      type: EventType.REASONING_MESSAGE_START,
      messageId: state.reasoningMessageId,
      role: "reasoning"
    } as BaseEvent);
  }
  events.push({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: state.reasoningMessageId,
    delta
  } as BaseEvent);
  return events;
}

function closeReasoning(state: StreamEventsToAGUIState): BaseEvent[] {
  if (state.reasoningMessageId === null) return [];
  const messageId = state.reasoningMessageId;
  state.reasoningMessageId = null;
  return [{ type: EventType.REASONING_MESSAGE_END, messageId } as BaseEvent];
}

function startTool(state: StreamEventsToAGUIState, call: PendingToolCall): BaseEvent[] {
  const parentMessageId = state.textMessageId;
  const events = closeText(state).concat(closeReasoning(state));
  events.push({
    type: EventType.TOOL_CALL_START,
    toolCallId: call.itemId,
    toolCallName: call.toolName,
    ...(parentMessageId ? { parentMessageId } : {})
  } as BaseEvent);
  events.push({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: call.itemId,
    delta: call.input
  } as BaseEvent);
  events.push({ type: EventType.TOOL_CALL_END, toolCallId: call.itemId } as BaseEvent);
  if (call.server || call.command || call.kind === "mcp") {
    events.push(
      customEvent("tool_meta", {
        toolCallId: call.itemId,
        kind: call.kind,
        server: call.server,
        command: call.command
      })
    );
  }
  return events;
}

function completeTool(call: PendingToolCall): BaseEvent[] {
  const events: BaseEvent[] = [
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: uuidv7(),
      toolCallId: call.itemId,
      content: call.output,
      role: "tool"
    } as BaseEvent
  ];
  if (call.status === "failed") {
    events.push(
      customEvent("tool_status", {
        toolCallId: call.itemId,
        toolName: call.toolName,
        status: call.status,
        durationMs: call.durationMs
      })
    );
  }
  if (call.uiResources && call.uiResources.length > 0) {
    events.push(
      customEvent("tool_ui_resources", {
        toolCallId: call.itemId,
        uiResources: call.uiResources
      })
    );
  }
  return events;
}

type TodoEntry = { content: string; status: string };

function emitPlanDelta(
  state: StreamEventsToAGUIState,
  input: Record<string, unknown> | null
): BaseEvent[] {
  const todos = extractTodos(input);
  if (todos.length === 0) return [];
  const rendered = todos
    .map((todo) => {
      const box = todo.status === "completed" ? "[x]" : "[ ]";
      const suffix = todo.status === "in_progress" ? " _(in progress)_" : "";
      return `- ${box} ${todo.content}${suffix}`;
    })
    .join("\n");

  let delta: string;
  if (state.planMarkdown === "") delta = rendered;
  else if (rendered.startsWith(state.planMarkdown)) delta = rendered.slice(state.planMarkdown.length);
  else delta = `\n\n${rendered}`;
  if (!delta) return [];

  state.planMarkdown += delta;
  return [
    {
      type: EventType.STATE_DELTA,
      delta: [{ op: "add", path: "/plan", value: state.planMarkdown }]
    } as BaseEvent
  ];
}

function extractTodos(input: Record<string, unknown> | null): TodoEntry[] {
  if (!Array.isArray(input?.todos)) return [];
  const entries: TodoEntry[] = [];
  for (const todo of input.todos) {
    if (typeof todo !== "object" || todo === null) continue;
    const record = todo as Record<string, unknown>;
    if (typeof record.content !== "string") continue;
    entries.push({
      content: record.content,
      status: typeof record.status === "string" ? record.status : "pending"
    });
  }
  return entries;
}

function extractToolInput(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if ("input" in record && Object.keys(record).length === 1) {
    if (typeof record.input === "object" && record.input !== null) {
      return record.input as Record<string, unknown>;
    }
    if (typeof record.input === "string") {
      try {
        const parsed = JSON.parse(record.input) as unknown;
        if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
      } catch {
        // Keep the wrapper when the inner string is not JSON.
      }
    }
  }
  return record;
}

function extractShellCommand(name: string, input: Record<string, unknown> | null): string | null {
  const lowered = name.toLowerCase();
  if (lowered !== "execute" && lowered !== "bash" && lowered !== "shell") return null;
  const command = input?.command;
  return typeof command === "string" && command.trim() ? command : null;
}

type ExtractedOutput = { output: string; isError: boolean; uiResources: UiResource[] };

function extractToolOutput(raw: unknown): ExtractedOutput {
  const result = extractToolOutputUnsanitized(raw);
  return result.output.includes("\u0000")
    ? { ...result, output: result.output.replaceAll("\u0000", "\uFFFD") }
    : result;
}

function toUiResource(block: Record<string, unknown>): UiResource | null {
  const resource = block.resource;
  if (typeof resource !== "object" || resource === null) return null;
  const record = resource as Record<string, unknown>;
  if (typeof record.uri !== "string" || !record.uri.startsWith("ui://")) return null;
  if (typeof record.mimeType !== "string") return null;
  return {
    uri: record.uri,
    mimeType: record.mimeType,
    ...(typeof record.text === "string" ? { text: record.text } : {}),
    ...(typeof record.blob === "string" ? { blob: record.blob } : {})
  };
}

function extractToolOutputUnsanitized(raw: unknown): ExtractedOutput {
  if (raw === undefined || raw === null) return { output: "", isError: false, uiResources: [] };
  if (typeof raw === "string") return { output: raw, isError: false, uiResources: [] };
  if (typeof raw !== "object") return { output: String(raw), isError: false, uiResources: [] };

  const record = raw as Record<string, unknown>;
  if (record.lg_name === "Command" || (record.update && typeof record.update === "object")) {
    const update = record.update as Record<string, unknown> | undefined;
    const messages = Array.isArray(update?.messages) ? update.messages : [];
    const parts: string[] = [];
    let isError = false;
    for (const message of messages) {
      if (typeof message !== "object" || message === null) continue;
      const kwargs = (message as Record<string, unknown>).kwargs;
      if (typeof kwargs !== "object" || kwargs === null) continue;
      const values = kwargs as Record<string, unknown>;
      if (values.status === "error") isError = true;
      if (typeof values.content === "string" && values.content) parts.push(values.content);
    }
    return {
      output: parts.length > 0 ? parts.join("\n") : safeJsonStringify(update ?? record),
      isError,
      uiResources: []
    };
  }

  const isError = record.status === "error";
  const content = "content" in record ? record.content : record;
  if (typeof content === "string") return { output: content, isError, uiResources: [] };
  if (!Array.isArray(content)) {
    return { output: safeJsonStringify(content), isError, uiResources: [] };
  }

  const parts: string[] = [];
  const uiResources: UiResource[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (typeof block === "object" && block !== null) {
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (item.type === "image") parts.push("[image]");
      else if (item.type === "resource") {
        const resource = toUiResource(item);
        if (resource) uiResources.push(resource);
      }
    }
  }
  return { output: parts.join(""), isError, uiResources };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
