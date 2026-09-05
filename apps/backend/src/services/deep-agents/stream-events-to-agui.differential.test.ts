import { EventSchemas, EventType, type BaseEvent } from "@ag-ui/client";
import { CogniplaneCustomEventSchema } from "@cogniplane/shared-types";
import { describe, expect, it, vi } from "vitest";

import {
  createStreamEventsToAGUIState,
  flushOpenAGUIMessages,
  streamEventsToAGUI,
  type DeepAgentsStreamEvent
} from "./stream-events-to-agui.js";

const options = {
  mcpToolNames: new Set(["show_widget"]),
  mcpToolServers: new Map([["show_widget", "analytics"]])
};

const capturedEnvelopes: DeepAgentsStreamEvent[] = [
  {
    event: "on_chat_model_stream",
    metadata: { langgraph_checkpoint_ns: "model_request:root" },
    data: { chunk: { content: [{ type: "thinking", thinking: "I should inspect it." }] } }
  },
  {
    event: "on_chat_model_stream",
    metadata: { langgraph_checkpoint_ns: "model_request:root" },
    data: { chunk: { content: "Checking now." } }
  },
  {
    event: "on_tool_start",
    name: "execute",
    run_id: "tool-execute",
    metadata: { langgraph_checkpoint_ns: "tools:root" },
    data: { input: { input: JSON.stringify({ command: "printf ok" }) } }
  },
  {
    event: "on_tool_end",
    name: "execute",
    run_id: "tool-execute",
    metadata: { langgraph_checkpoint_ns: "tools:root" },
    data: {
      output: {
        lg_name: "Command",
        update: { messages: [{ kwargs: { content: "ok\u0000", status: "error" } }] }
      }
    }
  },
  {
    event: "on_tool_start",
    name: "show_widget",
    run_id: "tool-mcp",
    metadata: {},
    data: { input: { query: "sales" } }
  },
  {
    event: "on_tool_end",
    name: "show_widget",
    run_id: "tool-mcp",
    metadata: {},
    data: {
      output: {
        content: [
          { type: "text", text: "Sales" },
          {
            type: "resource",
            resource: { uri: "ui://sales/chart", mimeType: "text/html", text: "<p>chart</p>" }
          }
        ]
      }
    }
  },
  {
    event: "on_tool_start",
    name: "write_todos",
    run_id: "plan-1",
    metadata: {},
    data: { input: { todos: [{ content: "Inspect data", status: "in_progress" }] } }
  },
  {
    event: "on_tool_start",
    name: "write_todos",
    run_id: "plan-2",
    metadata: {},
    data: { input: { todos: [{ content: "Inspect data", status: "completed" }] } }
  },
  {
    event: "on_chat_model_stream",
    metadata: { langgraph_checkpoint_ns: "tools:parent|model_request:child" },
    data: { chunk: { content: "hidden subagent text" } }
  },
  {
    event: "on_chat_model_stream",
    metadata: {},
    data: { chunk: { content: [{ type: "reasoning", reasoning: "Done." }] } }
  },
  {
    event: "on_chat_model_stream",
    metadata: {},
    data: { chunk: { content: [{ type: "text", text: "Finished." }] } }
  },
  { event: "on_chat_model_end", metadata: {}, data: {} }
];

function normalizeGeneratedIds(events: BaseEvent[]): unknown[] {
  const ids = new Map<string, string>();
  let nextId = 1;
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if ((key === "messageId" || key === "parentMessageId") && typeof item === "string") {
          if (!ids.has(item)) ids.set(item, `generated-${nextId++}`);
          return [key, ids.get(item)];
        }
        return [key, normalize(item)];
      })
    );
  };
  return events.map(normalize);
}

describe("streamEventsToAGUI", () => {
  it("maps the captured streamEvents corpus directly to valid AG-UI events", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const directState = createStreamEventsToAGUIState();
    const directEvents = capturedEnvelopes.flatMap((envelope) =>
      streamEventsToAGUI(directState, envelope, options)
    );
    directEvents.push(...flushOpenAGUIMessages(directState));

    for (const event of directEvents) {
      expect(EventSchemas.safeParse(event).success).toBe(true);
      if (event.type === EventType.CUSTOM) {
        expect(CogniplaneCustomEventSchema.safeParse(event).success).toBe(true);
      }
    }
    expect(normalizeGeneratedIds(directEvents)).toMatchSnapshot();
    expect(directEvents.map((event) => event.type)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.CUSTOM,
      EventType.TOOL_CALL_RESULT,
      EventType.CUSTOM,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.CUSTOM,
      EventType.TOOL_CALL_RESULT,
      EventType.CUSTOM,
      EventType.STATE_DELTA,
      EventType.STATE_DELTA,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END
    ]);

    const customs = directEvents.filter((event) => event.type === EventType.CUSTOM) as Array<
      BaseEvent & { name: string; value: Record<string, unknown> }
    >;
    expect(customs.map((event) => event.name)).toEqual([
      "tool_meta",
      "tool_status",
      "tool_meta",
      "tool_ui_resources"
    ]);
    expect(customs[0]?.value).toMatchObject({
      toolCallId: "tool-execute",
      kind: "command",
      command: "printf ok"
    });
    expect(customs[1]?.value).toMatchObject({
      toolCallId: "tool-execute",
      status: "failed",
      durationMs: 0
    });
    expect(customs[2]?.value).toMatchObject({
      toolCallId: "tool-mcp",
      kind: "mcp",
      server: "analytics"
    });
    expect(customs[3]?.value).toMatchObject({
      toolCallId: "tool-mcp",
      uiResources: [{ uri: "ui://sales/chart", mimeType: "text/html", text: "<p>chart</p>" }]
    });

    const results = directEvents.filter((event) => event.type === EventType.TOOL_CALL_RESULT) as Array<
      BaseEvent & { toolCallId: string; content: string }
    >;
    expect(results.map(({ toolCallId, content }) => ({ toolCallId, content }))).toEqual([
      { toolCallId: "tool-execute", content: "ok\uFFFD" },
      { toolCallId: "tool-mcp", content: "Sales" }
    ]);

    const plans = directEvents.filter((event) => event.type === EventType.STATE_DELTA) as Array<
      BaseEvent & { delta: Array<{ value: string }> }
    >;
    expect(plans.map((event) => event.delta[0]?.value)).toEqual([
      "- [ ] Inspect data _(in progress)_",
      "- [ ] Inspect data _(in progress)_\n\n- [x] Inspect data"
    ]);
    expect(directEvents.some((event) => JSON.stringify(event).includes("hidden subagent"))).toBe(false);
  });
});
