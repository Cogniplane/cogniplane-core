// Maps LangGraph `streamEvents` (v2) envelopes emitted by a deepagentsjs agent
// to the platform RuntimeEvent union. Fidelity here is what keeps
// sse-stream-writer and the frontend timeline untouched — the third runtime
// must be indistinguishable on the wire from Codex/Claude.
//
// A pure state machine over loose records, so unit tests can drive it with
// hand-built envelopes and the adapter can spread the result into its event
// queue.

import type { UiResource } from "@cogniplane/shared-types";

import { uuidv7 } from "../../lib/uuid.js";

import type { RuntimeEvent, RuntimeToolCall } from "../../runtime-contracts.js";

/** LangGraph StreamEvent envelope, kept loose for the same reason the Claude
 *  mapper accepts `Record<string, unknown>`: resilience to library drift. */
export type DeepAgentsStreamEvent = Record<string, unknown>;

type PendingToolCall = {
  toolCall: RuntimeToolCall;
  startedAt: number;
};

export type DeepAgentsEventMapperState = {
  responseId: string;
  /** Pending tool calls keyed by the tool run's `run_id`. */
  pendingToolCalls: Map<string, PendingToolCall>;
  /** Full plan text already emitted via framework:plan.delta (the stream
   *  writer accumulates deltas with `+=`, so re-renders must diff). */
  planTextEmitted: string;
  /** True once any output_text.delta was emitted for the current model run —
   *  used to emit output_item.done only for runs that produced output. */
  emittedTextThisRun: boolean;
};

export type DeepAgentsEventMapperOptions = {
  /** Tool names that route through the MCP gateway (rendered as MCP cards). */
  mcpToolNames?: ReadonlySet<string>;
  /**
   * Tool name → gateway server id, recorded when the MCP tools were loaded.
   * Stream events carry no server attribution (@langchain/mcp-adapters puts
   * nothing about the server on the tool), so this map is the only source
   * for the MCP card's `server` label.
   */
  mcpToolServers?: ReadonlyMap<string, string>;
};

export function createDeepAgentsEventMapperState(responseId: string): DeepAgentsEventMapperState {
  return {
    responseId,
    pendingToolCalls: new Map(),
    planTextEmitted: "",
    emittedTextThisRun: false
  };
}

/**
 * True when the envelope belongs to the root agent run. Root-graph node events
 * carry a single-segment `langgraph_checkpoint_ns` ("model_request:<uuid>",
 * "tools:<uuid>"); events from declared subagents run inside a NESTED
 * namespace, which LangGraph joins with "|" ("tools:<id>|model_request:<id>").
 * Streaming subagent text into the main answer would corrupt the reply, and
 * subagent tool activity is already represented by the parent `task` tool
 * card — so multi-segment namespaces are dropped. (Verified against
 * deepagents 1.10.5 / langgraph 1.x real streams.)
 */
function isRootNamespace(event: DeepAgentsStreamEvent): boolean {
  const metadata = event.metadata as Record<string, unknown> | undefined;
  const ns = metadata?.langgraph_checkpoint_ns;
  if (ns === undefined || ns === null || ns === "") return true;
  return typeof ns === "string" && !ns.includes("|");
}

export function mapDeepAgentsEvent(
  state: DeepAgentsEventMapperState,
  event: DeepAgentsStreamEvent,
  options: DeepAgentsEventMapperOptions = {}
): RuntimeEvent[] {
  const kind = typeof event.event === "string" ? event.event : undefined;
  if (!kind) return [];
  if (!isRootNamespace(event)) return [];

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

// ─── model stream chunks ─────────────────────────────────────────────────────

function mapModelStreamChunk(
  state: DeepAgentsEventMapperState,
  event: DeepAgentsStreamEvent
): RuntimeEvent[] {
  const data = event.data as Record<string, unknown> | undefined;
  const chunk = data?.chunk as Record<string, unknown> | undefined;
  if (!chunk) return [];

  const content = chunk.content;
  const events: RuntimeEvent[] = [];

  const pushText = (text: string) => {
    if (!text) return;
    state.emittedTextThisRun = true;
    events.push({
      type: "response.output_text.delta",
      responseId: state.responseId,
      delta: text
    });
  };
  const pushReasoning = (text: string) => {
    if (!text) return;
    events.push({
      type: "framework:reasoning_summary.delta",
      responseId: state.responseId,
      delta: text
    });
  };

  if (typeof content === "string") {
    pushText(content);
    return events;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block as Record<string, unknown>;
      // Anthropic-shaped blocks ({type:"text"|"thinking"}) and LangChain v1
      // standard blocks ({type:"reasoning"}) both occur depending on the
      // provider/content-block mode — accept either.
      if (record.type === "text" && typeof record.text === "string") {
        pushText(record.text);
      } else if (record.type === "thinking" && typeof record.thinking === "string") {
        pushReasoning(record.thinking);
      } else if (record.type === "reasoning" && typeof record.reasoning === "string") {
        pushReasoning(record.reasoning);
      }
    }
  }

  return events;
}

function mapModelRunEnd(state: DeepAgentsEventMapperState): RuntimeEvent[] {
  if (!state.emittedTextThisRun) return [];
  state.emittedTextThisRun = false;
  return [{ type: "response.output_item.done", responseId: state.responseId }];
}

// ─── tool events ─────────────────────────────────────────────────────────────

/** Deep Agents' planning tool — surfaced as the plan pane, not a tool card. */
const PLAN_TOOL_NAME = "write_todos";

function mapToolStart(
  state: DeepAgentsEventMapperState,
  event: DeepAgentsStreamEvent,
  options: DeepAgentsEventMapperOptions
): RuntimeEvent[] {
  const name = typeof event.name === "string" ? event.name : "tool";
  const runId = typeof event.run_id === "string" ? event.run_id : uuidv7();
  const data = event.data as Record<string, unknown> | undefined;
  const input = extractToolInput(data?.input);

  if (name === PLAN_TOOL_NAME) {
    return emitPlanDelta(state, input);
  }

  const isMcp = options.mcpToolNames?.has(name) ?? false;
  const toolCall: RuntimeToolCall = {
    itemId: runId,
    kind: isMcp ? "mcp" : "command",
    title: isMcp ? `Tool: ${name}` : name,
    status: "in_progress",
    command: extractShellCommand(name, input),
    cwd: null,
    server: isMcp ? (options.mcpToolServers?.get(name) ?? null) : null,
    toolName: name,
    input: JSON.stringify(input ?? {}),
    output: "",
    exitCode: null,
    durationMs: null
  };
  state.pendingToolCalls.set(runId, { toolCall, startedAt: Date.now() });

  return [
    {
      type: "response.tool.started",
      responseId: state.responseId,
      toolCall: { ...toolCall }
    }
  ];
}

function mapToolEnd(
  state: DeepAgentsEventMapperState,
  event: DeepAgentsStreamEvent
): RuntimeEvent[] {
  const name = typeof event.name === "string" ? event.name : "tool";
  if (name === PLAN_TOOL_NAME) return [];

  const runId = typeof event.run_id === "string" ? event.run_id : null;
  if (!runId) return [];
  const pending = state.pendingToolCalls.get(runId);
  if (!pending) return [];
  state.pendingToolCalls.delete(runId);

  const data = event.data as Record<string, unknown> | undefined;
  const { output, isError, uiResources } = extractToolOutput(data?.output);

  pending.toolCall.status = isError ? "failed" : "completed";
  // `uiResources` now persist as a jsonb column on the tool result (slice 2),
  // so the iframe card rehydrates on reload. We still stash a readable marker
  // in `output` for a UI-only result: it's the fallback when the MCP Apps flag
  // is off, and keeps the text card non-blank either way.
  pending.toolCall.output =
    output || (uiResources.length > 0 ? uiResources.map((r) => `[interactive UI: ${r.uri}]`).join("\n") : "");
  pending.toolCall.durationMs = Math.max(0, Date.now() - pending.startedAt);
  if (uiResources.length > 0) pending.toolCall.uiResources = uiResources;

  return [
    {
      type: "response.tool.completed",
      responseId: state.responseId,
      toolCall: { ...pending.toolCall }
    }
  ];
}

// ─── plan (write_todos → framework:plan.delta) ───────────────────────────────

type TodoEntry = { content: string; status: string };

function extractTodos(input: Record<string, unknown> | null): TodoEntry[] {
  const todos = input?.todos;
  if (!Array.isArray(todos)) return [];
  const entries: TodoEntry[] = [];
  for (const todo of todos) {
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

function renderPlanMarkdown(todos: TodoEntry[]): string {
  return todos
    .map((todo) => {
      const box = todo.status === "completed" ? "[x]" : "[ ]";
      const suffix = todo.status === "in_progress" ? " _(in progress)_" : "";
      return `- ${box} ${todo.content}${suffix}`;
    })
    .join("\n");
}

/**
 * The stream writer accumulates plan deltas with `+=`, so each write_todos
 * re-render must emit only what extends the already-emitted text. When the new
 * render is not a pure extension (statuses flipped, items reworded), emit a
 * separator + the full new list — the pane then shows the latest list last,
 * which matches how Codex streams successive plan revisions.
 */
function emitPlanDelta(
  state: DeepAgentsEventMapperState,
  input: Record<string, unknown> | null
): RuntimeEvent[] {
  const todos = extractTodos(input);
  if (todos.length === 0) return [];
  const rendered = renderPlanMarkdown(todos);

  let delta: string;
  if (state.planTextEmitted === "") {
    delta = rendered;
  } else if (rendered.startsWith(state.planTextEmitted)) {
    delta = rendered.slice(state.planTextEmitted.length);
  } else {
    delta = `\n\n${rendered}`;
  }
  if (!delta) return [];
  state.planTextEmitted += delta;

  return [
    {
      type: "framework:plan.delta",
      responseId: state.responseId,
      delta
    }
  ];
}

// ─── extraction helpers ──────────────────────────────────────────────────────

function extractToolInput(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  // LangGraph wraps tool input as { input: <args> } — and for tool nodes the
  // args arrive as a JSON-stringified string ({"input":"{\"todos\":[…]}"};
  // verified against deepagents 1.10.5 streams).
  const record = raw as Record<string, unknown>;
  if ("input" in record && Object.keys(record).length === 1) {
    const inner = record.input;
    if (typeof inner === "object" && inner !== null) {
      return inner as Record<string, unknown>;
    }
    if (typeof inner === "string") {
      try {
        const parsed = JSON.parse(inner) as unknown;
        if (typeof parsed === "object" && parsed !== null) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Not JSON — fall through to the wrapper record.
      }
    }
  }
  return record;
}

/** Surface the actual shell command for execute-style tools (matches the
 *  Codex/Claude card rendering, where `command` shows the command line). */
function extractShellCommand(name: string, input: Record<string, unknown> | null): string | null {
  const lowered = name.toLowerCase();
  if (lowered !== "execute" && lowered !== "bash" && lowered !== "shell") return null;
  const command = input?.command;
  return typeof command === "string" && command.trim() ? command : null;
}

type ExtractedOutput = { output: string; isError: boolean; uiResources: UiResource[] };

function extractToolOutput(raw: unknown): ExtractedOutput {
  const result = extractToolOutputUnsanitized(raw);
  // Postgres text columns reject NUL bytes (22021) — a tool that surfaces
  // binary content (e.g. cat on an image) must not kill the whole turn at
  // the persist step.
  return result.output.includes("\u0000")
    ? { ...result, output: result.output.replaceAll("\u0000", "\uFFFD") }
    : result;
}

/** An MCP-UI / MCP Apps resource block ({type:"resource", resource:{uri,…}}) —
 *  surfaced to the frontend for sandboxed-iframe rendering instead of being
 *  flattened into the text output. `ui://` scheme only; other embedded
 *  resources are left to the text path. */
function toUiResource(block: Record<string, unknown>): UiResource | null {
  const resource = block.resource;
  if (typeof resource !== "object" || resource === null) return null;
  const r = resource as Record<string, unknown>;
  if (typeof r.uri !== "string" || !r.uri.startsWith("ui://")) return null;
  if (typeof r.mimeType !== "string") return null;
  return {
    uri: r.uri,
    mimeType: r.mimeType,
    ...(typeof r.text === "string" ? { text: r.text } : {}),
    ...(typeof r.blob === "string" ? { blob: r.blob } : {})
  };
}

function extractToolOutputUnsanitized(raw: unknown): ExtractedOutput {
  if (raw === undefined || raw === null) return { output: "", isError: false, uiResources: [] };
  if (typeof raw === "string") return { output: raw, isError: false, uiResources: [] };

  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    // State-mutating Deep Agents tools return a LangGraph Command whose
    // ToolMessages sit under update.messages as serialized constructors
    // ({ kwargs: { content } }). Surface those instead of the raw Command
    // blob so the tool card shows the human-readable result.
    if (record.lg_name === "Command" || (record.update && typeof record.update === "object")) {
      const update = record.update as Record<string, unknown> | undefined;
      const messages = Array.isArray(update?.messages) ? update.messages : [];
      const parts: string[] = [];
      let isError = false;
      for (const message of messages) {
        if (typeof message !== "object" || message === null) continue;
        const kwargs = (message as Record<string, unknown>).kwargs;
        if (typeof kwargs !== "object" || kwargs === null) continue;
        const kwargsRecord = kwargs as Record<string, unknown>;
        if (kwargsRecord.status === "error") isError = true;
        const content = kwargsRecord.content;
        if (typeof content === "string" && content) parts.push(content);
      }
      if (parts.length > 0) return { output: parts.join("\n"), isError, uiResources: [] };
      return { output: safeJsonStringify(update ?? record), isError, uiResources: [] };
    }
    // ToolMessage: { content, status? } — status "error" marks a failed call.
    const isError = record.status === "error";
    const content = "content" in record ? record.content : record;
    if (typeof content === "string") return { output: content, isError, uiResources: [] };
    if (Array.isArray(content)) {
      const parts: string[] = [];
      const uiResources: UiResource[] = [];
      for (const block of content) {
        if (typeof block === "string") {
          parts.push(block);
        } else if (typeof block === "object" && block !== null) {
          const blockRecord = block as Record<string, unknown>;
          if (blockRecord.type === "text" && typeof blockRecord.text === "string") {
            parts.push(blockRecord.text);
          } else if (blockRecord.type === "image") {
            parts.push("[image]");
          } else if (blockRecord.type === "resource") {
            const ui = toUiResource(blockRecord);
            if (ui) uiResources.push(ui);
          }
        }
      }
      return { output: parts.join(""), isError, uiResources };
    }
    return { output: safeJsonStringify(content), isError, uiResources: [] };
  }

  return { output: String(raw), isError: false, uiResources: [] };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
