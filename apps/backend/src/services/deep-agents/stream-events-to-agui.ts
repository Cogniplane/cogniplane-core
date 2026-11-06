import { EventType, type BaseEvent } from "@ag-ui/client";
import type { McpAppCall } from "@cogniplane/shared-types";

import { EXECUTE_RESULT_EVENT } from "./execute-result-event.js";
import { GENERATIVE_UI_RENDER_TOOL } from "./render-ui.js";
import { RenderUiStream } from "./render-ui-stream.js";

import { uuidv7 } from "../../lib/uuid.js";
import { customEvent } from "./agui-events.js";
import { withoutPolicyApprovalMetadata } from "../policy/policy-approval-proof.js";
import { redactAppData, redactSecrets } from "../redact-secrets.js";

export type DeepAgentsStreamEvent = Record<string, unknown>;

type ToolKind = "command" | "mcp";
type ToolStatus = "in_progress" | "completed" | "failed" | "declined";

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
  mcpApp?: McpAppCall;
  startedAt: number;
};

/**
 * A tool call that the main agent's latest model message proposes. Models
 * repeat call IDs, across messages and turns, so the server gives each
 * proposed call its own ID (`cardId`). The card, the result, the saved tool
 * result and the approval all use it.
 */
type ProposedCall = {
  cardId: string;
  name: string;
  /** Set once the call shows: at its approval, or when it starts. */
  card: PendingToolCall | null;
  started: boolean;
  settled: boolean;
  /** Why an approved call will not run: another call of its step was not approved. */
  notRun?: string;
};

export type StreamEventsToAGUIState = {
  /** Cards of running tools, by the run ID of the tool. */
  pendingToolCalls: Map<string, PendingToolCall>;
  /**
   * The calls of the main agent's latest model message, by the model's call
   * ID. A call ID that the message repeats is left out: its calls keep a card
   * per tool run and get no approval link.
   */
  proposals: Map<string, ProposedCall>;
  /**
   * Exit codes that the sandbox reported for tool runs, by run ID. A run takes
   * its code when it ends. See `execute-result-event.ts`.
   */
  exitCodes: Map<string, number>;
  renderUi?: RenderUiStream;
  planMarkdown: string;
  emittedTextThisRun: boolean;
  textMessageId: string | null;
  reasoningMessageId: string | null;
};

export type StreamEventsToAGUIOptions = {
  assistantMessageId?: string;
  mcpToolNames?: ReadonlySet<string>;
  mcpToolServers?: ReadonlyMap<string, string>;
  /** The model's call ID of a tool run (from the tool-start callback). */
  modelCallIdOf?: (runId: string) => string | undefined;
};

export function createStreamEventsToAGUIState(): StreamEventsToAGUIState {
  return {
    pendingToolCalls: new Map(),
    proposals: new Map(),
    exitCodes: new Map(),
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

  if (options.assistantMessageId && !state.renderUi) state.renderUi = new RenderUiStream(options.assistantMessageId);
  switch (kind) {
    case "on_chat_model_start":
      // The step of the previous message is over. A call of it that showed
      // and never started did not run.
      return settleUnstartedCalls(state);
    case "on_chat_model_stream":
      return mapModelStreamChunk(state, event);
    case "on_chat_model_end":
      recordProposals(state, event);
      return mapModelRunEnd(state);
    case "on_tool_start":
      return mapToolStart(state, event, options);
    case "on_tool_end":
      return mapToolEnd(state, event);
    case "on_custom_event":
      return recordExitCode(state, event);
    default:
      return [];
  }
}

export function flushOpenAGUIMessages(state: StreamEventsToAGUIState, finishUi = true): BaseEvent[] {
  return [...closeText(state), ...closeReasoning(state), ...(finishUi ? state.renderUi?.finish() ?? [] : [])];
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

  if (Array.isArray(chunk.tool_call_chunks) && state.renderUi) {
    const snapshots = state.renderUi.push(String(event.run_id ?? "model"), chunk.tool_call_chunks);
    if (snapshots.length > 0) events.push(...closeText(state), ...closeReasoning(state), ...snapshots);
  }
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

// The result of a shown call that did not run. The status says why, and the
// card shows the text.
const NOT_RUN_SIBLING = "This action did not run: another action in the same step was not approved.";
const NOT_RUN = "This action did not run.";

function recordProposals(state: StreamEventsToAGUIState, event: DeepAgentsStreamEvent): void {
  const output = (event.data as { output?: { tool_calls?: unknown } } | undefined)?.output;
  const calls = (Array.isArray(output?.tool_calls) ? output.tool_calls : [])
    .filter((call): call is { id: string; name: string } =>
      typeof call?.id === "string" && call.id !== "" && typeof call.name === "string");
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.id, (counts.get(call.id) ?? 0) + 1);
  state.proposals = new Map(calls.filter((call) => counts.get(call.id) === 1).map((call): [string, ProposedCall] => [call.id,
    { cardId: uuidv7(), name: call.name, card: null, started: false, settled: false }]));
}

function newCard(id: string, name: string, input: Record<string, unknown> | null, options: StreamEventsToAGUIOptions): PendingToolCall {
  const isMcp = options.mcpToolNames?.has(name) ?? false;
  return {
    itemId: id,
    kind: isMcp ? "mcp" : "command",
    title: isMcp ? `Tool: ${name}` : name,
    status: "in_progress",
    command: extractShellCommand(name, input),
    server: isMcp ? (options.mcpToolServers?.get(name) ?? null) : null,
    toolName: name,
    input: JSON.stringify(isMcp ? redactAppData(input ?? {}) : input ?? {}),
    output: "",
    durationMs: null,
    startedAt: Date.now()
  };
}

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

  // The callback gives the model's call ID of this run. Within the latest
  // message, it names one proposed call, so the run takes that call's card.
  const modelCallId = typeof event.run_id === "string" ? options.modelCallIdOf?.(event.run_id) : undefined;
  const found = modelCallId ? state.proposals.get(modelCallId) : undefined;
  // A settled card already says that the call did not run, so a run of it gets a card of its own.
  const proposal = found?.name === name && !found.settled ? found : undefined;
  if (proposal?.card) {
    // Shown at its approval, or a delegation that runs again after an approval inside it.
    if (!proposal.started) proposal.card.startedAt = Date.now();
    proposal.started = true;
    state.pendingToolCalls.set(runId, proposal.card);
    return [];
  }

  const call = newCard(proposal?.cardId ?? runId, name, input, options);
  if (proposal) {
    proposal.card = call;
    proposal.started = true;
  }
  state.pendingToolCalls.set(runId, call);
  const surfaces = name === GENERATIVE_UI_RENDER_TOOL ? state.renderUi?.start(call.itemId, call.input) ?? [] : [];
  return surfaces.length > 0
    ? [...closeText(state), ...closeReasoning(state), ...surfaces, ...startTool(state, call)]
    : startTool(state, call);
}

/**
 * Shows the card of each pending approval of the main agent before the
 * approval is asked, and returns the server ID of each action's call. Only an
 * action whose model call ID names one call of the latest message gets an ID.
 * Delegated work and repeated call IDs get none: their approvals stay in the
 * notification list.
 */
export function showApprovalCalls(
  state: StreamEventsToAGUIState,
  actions: ReadonlyArray<{ name: string; args: Record<string, unknown>; modelCallId?: string }>,
  options: StreamEventsToAGUIOptions = {}
): { events: BaseEvent[]; toolCallIds: Array<string | undefined> } {
  const counts = new Map<string, number>();
  for (const { modelCallId } of actions) if (modelCallId) counts.set(modelCallId, (counts.get(modelCallId) ?? 0) + 1);
  const events: BaseEvent[] = [];
  const toolCallIds = actions.map((action) => {
    if (!action.modelCallId || counts.get(action.modelCallId) !== 1) return undefined;
    const proposal = state.proposals.get(action.modelCallId);
    if (!proposal || proposal.name !== action.name || proposal.started || proposal.settled) return undefined;
    if (!proposal.card) {
      proposal.card = newCard(proposal.cardId, action.name, withoutPolicyApprovalMetadata(action.args), options);
      events.push(...startTool(state, proposal.card));
    }
    return proposal.cardId;
  });
  return { events, toolCallIds };
}

/**
 * Settles the cards of the approvals that did not approve their call: the
 * result is the message that the model gets. When the main agent's step has a
 * call that was not approved, LangChain's HITL middleware runs none of the
 * step's other calls, so an approved call of that step gets a reason that the
 * card shows if it does not start.
 */
export function settleApprovalCalls(
  state: StreamEventsToAGUIState,
  actions: ReadonlyArray<{ modelCallId?: string; toolCallId?: string }>,
  decisions: ReadonlyArray<{ type: "approve" } | { type: "reject"; message?: string }>
): BaseEvent[] {
  const byCard = new Map([...state.proposals.values()].map((proposal) => [proposal.cardId, proposal]));
  const events: BaseEvent[] = [];
  let stepNotApproved = false;
  actions.forEach((action, index) => {
    const decision = decisions[index];
    if (decision?.type !== "reject") return;
    if (action.modelCallId) stepNotApproved = true;
    const proposal = action.toolCallId ? byCard.get(action.toolCallId) : undefined;
    if (proposal) events.push(...settleCall(proposal, "declined", decision.message ?? "Declined."));
  });
  if (stepNotApproved) {
    actions.forEach((action, index) => {
      const proposal = action.toolCallId ? byCard.get(action.toolCallId) : undefined;
      if (proposal && decisions[index]?.type === "approve") proposal.notRun = NOT_RUN_SIBLING;
    });
  }
  return events;
}

/** Settles each shown call of the latest message that never started: it did not run. */
export function settleUnstartedCalls(state: StreamEventsToAGUIState): BaseEvent[] {
  return [...state.proposals.values()].flatMap((proposal) => proposal.card && !proposal.started && !proposal.settled
    ? settleCall(proposal, proposal.notRun ? "declined" : "failed", proposal.notRun ?? NOT_RUN)
    : []);
}

function settleCall(proposal: ProposedCall, status: "declined" | "failed", output: string): BaseEvent[] {
  const call = proposal.card;
  if (!call || proposal.started || proposal.settled) return [];
  proposal.settled = true;
  call.status = status;
  call.output = output;
  return completeTool(call);
}

/**
 * Keeps the exit code that the sandbox reported to a tool run. Only the
 * sandbox dispatches this event: it comes from the structured response of the
 * command, not from the text that the tool returns. Any other event name, and
 * a value that is not an integer, records nothing.
 */
function recordExitCode(state: StreamEventsToAGUIState, event: DeepAgentsStreamEvent): BaseEvent[] {
  if (event.name !== EXECUTE_RESULT_EVENT || typeof event.run_id !== "string") return [];
  const exitCode = (event.data as { exitCode?: unknown } | undefined)?.exitCode;
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) state.exitCodes.set(event.run_id, exitCode);
  return [];
}

function mapToolEnd(state: StreamEventsToAGUIState, event: DeepAgentsStreamEvent): BaseEvent[] {
  const name = typeof event.name === "string" ? event.name : "tool";
  if (name === PLAN_TOOL_NAME) return [];

  const runId = typeof event.run_id === "string" ? event.run_id : null;
  if (!runId) return [];
  const exitCode = state.exitCodes.get(runId);
  state.exitCodes.delete(runId);
  const call = state.pendingToolCalls.get(runId);
  if (!call) return [];
  state.pendingToolCalls.delete(runId);

  const data = event.data as Record<string, unknown> | undefined;
  const { output, isError, mcpApp } = extractToolOutput(data?.output, call.kind === "mcp");
  // The SDK returns the result of a failed command as a successful message, so
  // the exit code of the sandbox decides. Other tools report through their
  // message status. A derived file tool (grep with no match) exits non-zero as a normal result.
  const commandFailed = call.kind === "command" && call.toolName === "execute" && exitCode !== undefined && exitCode !== 0;
  call.status = isError || commandFailed ? "failed" : "completed";
  call.output = output;
  call.durationMs = Math.max(0, Date.now() - call.startedAt);
  if (mcpApp && call.kind === "mcp" && !isError) {
    call.mcpApp = { ...mcpApp, input: JSON.parse(call.input) as Record<string, unknown>,
      result: redactAppData(mcpApp.result) };
  }
  return [
    ...(name === GENERATIVE_UI_RENDER_TOOL ? state.renderUi?.end(call.itemId, isError, output) ?? [] : []),
    ...completeTool(call)
  ];
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
  if (call.status === "failed" || call.status === "declined") {
    events.push(
      customEvent("tool_status", {
        toolCallId: call.itemId,
        toolName: call.toolName,
        status: call.status,
        durationMs: call.durationMs
      })
    );
  }
  if (call.status === "completed" && call.mcpApp) {
    events.push(customEvent("tool_mcp_app", { toolCallId: call.itemId, app: call.mcpApp }));
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

type ExtractedOutput = { output: string; isError: boolean; mcpApp?: McpAppCall };

function extractToolOutput(raw: unknown, isMcp: boolean): ExtractedOutput {
  const result = extractToolOutputUnsanitized(raw, isMcp);
  return result.output.includes("\u0000")
    ? { ...result, output: result.output.replaceAll("\u0000", "\uFFFD") }
    : result;
}

// Embedded resource blocks have no renderer; MCP Apps use gateway resource
// metadata instead. A raw MCP result keeps these blocks in `content`. The
// LangChain MCP adapter moves them to the ToolMessage `artifact` and can leave
// the content empty. When a result has no other text, name each resource so the
// tool card says what the tool returned. Never copy its text or blob.
function describeResourceBlocks(...lists: unknown[]): string {
  const lines: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const block of list) {
      if (typeof block !== "object" || block === null) continue;
      const item = block as Record<string, unknown>;
      if (item.type !== "resource" || typeof item.resource !== "object" || item.resource === null) continue;
      const { uri, mimeType } = item.resource as Record<string, unknown>;
      if (typeof uri !== "string") continue;
      const type = typeof mimeType === "string" ? ` (${mimeType})` : "";
      lines.push(`[Embedded resource not displayed: ${uri}${type}]`);
    }
  }
  return lines.join("\n");
}

function extractToolOutputUnsanitized(raw: unknown, isMcp: boolean): ExtractedOutput {
  if (raw === undefined || raw === null) return { output: "", isError: false };
  if (typeof raw === "string") return { output: raw, isError: false };
  if (typeof raw !== "object") return { output: String(raw), isError: false };

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
      isError
    };
  }

  const isError = record.status === "error";
  const content = "content" in record ? record.content : record;
  const app = isMcp && !isError ? extractMcpApp(record, content, isError) : null;
  if (typeof content === "string") {
    return { output: content || describeResourceBlocks(record.artifact), isError, ...(app ? { mcpApp: app } : {}) };
  }
  if (!Array.isArray(content)) {
    const output = isMcp && app && typeof content === "object" && content !== null && typeof (content as { text?: unknown }).text === "string"
      ? (content as { text: string }).text
      : safeJsonStringify(content);
    return { output, isError, ...(app ? { mcpApp: app } : {}) };
  }

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (typeof block === "object" && block !== null) {
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (item.type === "image") parts.push("[image]");
    }
  }
  const output = parts.join("") || describeResourceBlocks(content, record.artifact);
  return { output, isError, ...(app ? { mcpApp: app } : {}) };
}

function extractMcpApp(record: Record<string, unknown>, content: unknown, isError: boolean): McpAppCall | null {
  const contentRecord = content && typeof content === "object" && !Array.isArray(content)
    ? content as Record<string, unknown> : null;
  const artifacts = Array.isArray(record.artifact) ? record.artifact as Array<Record<string, unknown>> : [];
  const metaArtifact = artifacts.find((entry) => entry?.type === "mcp_meta")?.data;
  const meta = [contentRecord?.meta, metaArtifact, record.meta].find(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).cogniplaneAppResourceUri === "string"
  );
  const resourceUri = meta?.cogniplaneAppResourceUri;
  if (typeof resourceUri !== "string" || !resourceUri.startsWith("ui://") || redactSecrets(resourceUri) !== resourceUri) return null;
  const structuredArtifact = artifacts.find((entry) => entry?.type === "mcp_structured_content")?.data;
  const structuredContent = [contentRecord?.structuredContent, structuredArtifact, record.structuredContent].find(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
  );
  const blocks = Array.isArray(content)
    ? content.filter((block): block is { type: string; [key: string]: unknown } =>
        typeof block === "object" && block !== null && typeof block.type === "string")
    : contentRecord?.type === "text" && typeof contentRecord.text === "string"
      ? [{ type: "text", text: contentRecord.text }]
      : typeof content === "string" ? [{ type: "text", text: content }] : [];
  return {
    resourceUri,
    readOnly: meta?.cogniplaneAppReadOnly === true,
    turnContext: meta?.cogniplaneAppTurnContext === "interactive" || meta?.cogniplaneAppTurnContext === "scheduled"
      ? meta.cogniplaneAppTurnContext : null,
    result: {
      content: blocks,
      ...(structuredContent ? { structuredContent } : {}),
      ...(isError ? { isError: true } : {})
    }
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
