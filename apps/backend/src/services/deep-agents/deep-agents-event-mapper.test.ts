import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../../runtime-contracts.js";
import {
  createDeepAgentsEventMapperState,
  mapDeepAgentsEvent,
  type DeepAgentsEventMapperOptions,
  type DeepAgentsEventMapperState,
  type DeepAgentsStreamEvent
} from "./deep-agents-event-mapper.js";

const RESPONSE_ID = "resp-1";

function map(
  state: DeepAgentsEventMapperState,
  event: DeepAgentsStreamEvent,
  options?: DeepAgentsEventMapperOptions
): RuntimeEvent[] {
  return mapDeepAgentsEvent(state, event, options);
}

function modelStream(content: unknown, metadata: Record<string, unknown> = {}): DeepAgentsStreamEvent {
  return {
    event: "on_chat_model_stream",
    metadata,
    data: { chunk: { content } }
  };
}

function toolStart(
  name: string,
  input: unknown,
  overrides: Partial<Record<"run_id" | "metadata", unknown>> = {}
): DeepAgentsStreamEvent {
  return {
    event: "on_tool_start",
    name,
    run_id: (overrides.run_id as string) ?? "run-1",
    metadata: (overrides.metadata as Record<string, unknown>) ?? {},
    data: { input }
  };
}

function toolEnd(
  name: string,
  output: unknown,
  runId = "run-1"
): DeepAgentsStreamEvent {
  return {
    event: "on_tool_end",
    name,
    run_id: runId,
    metadata: {},
    data: { output }
  };
}

describe("mapDeepAgentsEvent", () => {
  it("maps string chunk content to output_text.delta", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    const events = map(state, modelStream("Hello"));
    expect(events).toEqual([
      { type: "response.output_text.delta", responseId: RESPONSE_ID, delta: "Hello" }
    ]);
  });

  it("maps text content blocks to output_text.delta", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    const events = map(state, modelStream([{ type: "text", text: "chunk" }]));
    expect(events).toEqual([
      { type: "response.output_text.delta", responseId: RESPONSE_ID, delta: "chunk" }
    ]);
  });

  it("maps thinking and reasoning blocks to reasoning_summary.delta", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    const anthropicShape = map(state, modelStream([{ type: "thinking", thinking: "hm" }]));
    const standardShape = map(state, modelStream([{ type: "reasoning", reasoning: "aha" }]));
    expect(anthropicShape).toEqual([
      { type: "framework:reasoning_summary.delta", responseId: RESPONSE_ID, delta: "hm" }
    ]);
    expect(standardShape).toEqual([
      { type: "framework:reasoning_summary.delta", responseId: RESPONSE_ID, delta: "aha" }
    ]);
  });

  it("drops empty chunks and unknown event kinds", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    expect(map(state, modelStream(""))).toEqual([]);
    expect(map(state, { event: "on_chain_start", data: {} })).toEqual([]);
    expect(map(state, { data: {} })).toEqual([]);
  });

  it("accepts root-graph namespaces but ignores nested subagent namespaces", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    // Root node events carry a single-segment namespace.
    const root = { langgraph_checkpoint_ns: "model_request:83a9b55e" };
    expect(map(state, modelStream("root text", root))).toEqual([
      { type: "response.output_text.delta", responseId: RESPONSE_ID, delta: "root text" }
    ]);
    // Subagent events are nested ("|"-joined) — dropped.
    const nested = { langgraph_checkpoint_ns: "tools:abc123|model_request:def456" };
    expect(map(state, modelStream("subagent text", nested))).toEqual([]);
    expect(map(state, toolStart("execute", { command: "ls" }, { metadata: nested }))).toEqual([]);
  });

  it("emits output_item.done on model end only after text was streamed", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    // No text streamed yet (e.g. a pure tool-call model run) — no done event.
    expect(map(state, { event: "on_chat_model_end", metadata: {} })).toEqual([]);

    map(state, modelStream("some text"));
    expect(map(state, { event: "on_chat_model_end", metadata: {} })).toEqual([
      { type: "response.output_item.done", responseId: RESPONSE_ID }
    ]);
    // Flag resets — the next model end without text is silent again.
    expect(map(state, { event: "on_chat_model_end", metadata: {} })).toEqual([]);
  });

  it("maps tool start/end to tool.started + tool.completed with duration", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    const started = map(state, toolStart("read_file", { path: "a.csv" }));
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      type: "response.tool.started",
      responseId: RESPONSE_ID,
      toolCall: {
        itemId: "run-1",
        kind: "command",
        title: "read_file",
        status: "in_progress",
        toolName: "read_file",
        input: JSON.stringify({ path: "a.csv" }),
        output: ""
      }
    });

    const completed = map(state, toolEnd("read_file", "col1,col2"));
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: "response.tool.completed",
      toolCall: {
        itemId: "run-1",
        status: "completed",
        output: "col1,col2"
      }
    });
    const toolCall = (completed[0] as Extract<RuntimeEvent, { type: "response.tool.completed" }>).toolCall;
    expect(toolCall.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("surfaces the shell command for execute-style tools", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    const [event] = map(state, toolStart("execute", { command: "python analyze.py" }));
    expect(event).toMatchObject({
      type: "response.tool.started",
      toolCall: { command: "python analyze.py", kind: "command" }
    });
  });

  it("classifies configured MCP tools as mcp kind with server attribution from the load-time map", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    const [event] = map(state, toolStart("memory_search", { query: "x" }), {
      mcpToolNames: new Set(["memory_search"]),
      mcpToolServers: new Map([["memory_search", "managed-session-context"]])
    });
    expect(event).toMatchObject({
      type: "response.tool.started",
      toolCall: {
        kind: "mcp",
        title: "Tool: memory_search",
        server: "managed-session-context",
        command: null
      }
    });
  });

  it("falls back to server:null for an MCP tool missing from the attribution map (no undefined, no throw)", () => {
    // The adapter defaults mcpToolServers to an empty map, and per-server load
    // degradation drops entries — so an MCP tool can be in mcpToolNames without a
    // matching server entry. That must yield server:null (a valid wire value),
    // NOT undefined and NOT a throw at tool-start.
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    const [event] = map(state, toolStart("memory_search", { query: "x" }), {
      mcpToolNames: new Set(["memory_search"])
      // mcpToolServers intentionally omitted
    });
    expect(event).toMatchObject({
      type: "response.tool.started",
      toolCall: { kind: "mcp", server: null }
    });
    // Explicitly null (present), not undefined.
    const started = event as Extract<RuntimeEvent, { type: "response.tool.started" }>;
    expect(started.toolCall.server).toBeNull();
  });

  it("unwraps ToolMessage outputs and marks error status as failed", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    map(state, toolStart("execute", { command: "boom" }));
    const [event] = map(
      state,
      toolEnd("execute", { content: [{ type: "text", text: "stack trace" }], status: "error" })
    );
    expect(event).toMatchObject({
      type: "response.tool.completed",
      toolCall: { status: "failed", output: "stack trace" }
    });
  });

  it("surfaces ui:// MCP resource blocks as uiResources and keeps text output", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    map(state, toolStart("show_widget", { query: "x" }), {
      mcpToolNames: new Set(["show_widget"])
    });
    const [event] = map(
      state,
      toolEnd("show_widget", {
        content: [
          { type: "text", text: "Query: x" },
          {
            type: "resource",
            resource: { uri: "ui://widget/1", mimeType: "text/html;profile=mcp-app", text: "<h1>W</h1>" }
          },
          // Non-ui:// embedded resource stays on the text path (ignored here).
          { type: "resource", resource: { uri: "file://readme.md", mimeType: "text/plain", text: "hi" } }
        ]
      })
    );
    const toolCall = (event as Extract<RuntimeEvent, { type: "response.tool.completed" }>).toolCall;
    expect(toolCall.output).toBe("Query: x");
    expect(toolCall.uiResources).toEqual([
      { uri: "ui://widget/1", mimeType: "text/html;profile=mcp-app", text: "<h1>W</h1>" }
    ]);
  });

  it("persists a readable marker in output for a UI-only tool result (no text block)", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    map(state, toolStart("show_widget", { query: "x" }), { mcpToolNames: new Set(["show_widget"]) });
    const [event] = map(
      state,
      toolEnd("show_widget", {
        content: [
          {
            type: "resource",
            resource: { uri: "ui://widget/2", mimeType: "text/html;profile=mcp-app", text: "<h1>W</h1>" }
          }
        ]
      })
    );
    const toolCall = (event as Extract<RuntimeEvent, { type: "response.tool.completed" }>).toolCall;
    // uiResources ride the live payload; output carries the persisted fallback.
    expect(toolCall.output).toBe("[interactive UI: ui://widget/2]");
    expect(toolCall.uiResources).toHaveLength(1);
  });

  it("replaces NUL bytes in tool output so persistence survives binary content", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    map(state, toolStart("read_file", { file_path: "chart.png" }));
    const [event] = map(state, toolEnd("read_file", "PNG\u0000\u0000header"));
    expect(event).toMatchObject({
      type: "response.tool.completed",
      toolCall: { output: "PNG\uFFFD\uFFFDheader" }
    });
  });

  it("parses JSON-stringified wrapped tool input (LangGraph tool-node shape)", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    // Real deepagents streams wrap args as {"input":"<json string>"}.
    const [event] = map(
      state,
      toolStart("write_file", { input: JSON.stringify({ file_path: "hello.txt", content: "hi" }) })
    );
    expect(event).toMatchObject({
      type: "response.tool.started",
      toolCall: { input: JSON.stringify({ file_path: "hello.txt", content: "hi" }) }
    });
  });

  it("extracts ToolMessage content from serialized Command outputs", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    map(state, toolStart("write_file", { input: '{"file_path":"hello.txt"}' }));
    const [event] = map(
      state,
      toolEnd("write_file", {
        lg_name: "Command",
        update: {
          files: { "hello.txt": {} },
          messages: [
            {
              lc: 1,
              type: "constructor",
              id: ["langchain_core", "messages", "ToolMessage"],
              kwargs: { content: "Updated file hello.txt", tool_call_id: "t1" }
            }
          ]
        }
      })
    );
    expect(event).toMatchObject({
      type: "response.tool.completed",
      toolCall: { status: "completed", output: "Updated file hello.txt" }
    });
  });

  it("marks a serialized Command output as failed when its inner ToolMessage status is error", () => {
    // write_file/edit_file return a LangGraph Command whose failure lands in the
    // inner ToolMessage kwargs.status, NOT on the outer record — a denied write
    // must render as a failed card, not a green "completed" one.
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    map(state, toolStart("write_file", { input: '{"file_path":"secret.txt"}' }));
    const [event] = map(
      state,
      toolEnd("write_file", {
        lg_name: "Command",
        update: {
          messages: [
            {
              lc: 1,
              type: "constructor",
              id: ["langchain_core", "messages", "ToolMessage"],
              kwargs: { content: "permission denied", status: "error", tool_call_id: "t1" }
            }
          ]
        }
      })
    );
    expect(event).toMatchObject({
      type: "response.tool.completed",
      toolCall: { status: "failed", output: "permission denied" }
    });
  });

  it("renders write_todos plan deltas from the JSON-stringified input shape", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    const events = map(
      state,
      toolStart("write_todos", {
        input: JSON.stringify({ todos: [{ content: "First task", status: "pending" }] })
      })
    );
    expect(events).toEqual([
      { type: "framework:plan.delta", responseId: RESPONSE_ID, delta: "- [ ] First task" }
    ]);
  });

  it("ignores a tool end without a matching pending start", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    expect(map(state, toolEnd("read_file", "orphan"))).toEqual([]);
  });

  it("renders write_todos as plan deltas instead of tool cards", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    const events = map(
      state,
      toolStart("write_todos", {
        todos: [
          { content: "Load the CSV", status: "in_progress" },
          { content: "Chart revenue", status: "pending" }
        ]
      })
    );
    expect(events).toEqual([
      {
        type: "framework:plan.delta",
        responseId: RESPONSE_ID,
        delta: "- [ ] Load the CSV _(in progress)_\n- [ ] Chart revenue"
      }
    ]);
    // The paired tool end must not produce a tool card either.
    expect(map(state, toolEnd("write_todos", "ok"))).toEqual([]);
  });

  it("emits only the extension when a plan re-render extends the previous one", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    map(state, toolStart("write_todos", { todos: [{ content: "Step 1", status: "pending" }] }));
    const events = map(
      state,
      toolStart("write_todos", {
        todos: [
          { content: "Step 1", status: "pending" },
          { content: "Step 2", status: "pending" }
        ]
      })
    );
    expect(events).toEqual([
      { type: "framework:plan.delta", responseId: RESPONSE_ID, delta: "\n- [ ] Step 2" }
    ]);
  });

  it("emits a separated full re-render when statuses change", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    map(state, toolStart("write_todos", { todos: [{ content: "Step 1", status: "pending" }] }));
    const events = map(
      state,
      toolStart("write_todos", { todos: [{ content: "Step 1", status: "completed" }] })
    );
    expect(events).toEqual([
      { type: "framework:plan.delta", responseId: RESPONSE_ID, delta: "\n\n- [x] Step 1" }
    ]);
  });

  it("suppresses duplicate identical plan renders", () => {
    const state = createDeepAgentsEventMapperState(RESPONSE_ID);
    const todos = { todos: [{ content: "Step 1", status: "pending" }] };
    map(state, toolStart("write_todos", todos));
    expect(map(state, toolStart("write_todos", todos))).toEqual([]);
  });
});
