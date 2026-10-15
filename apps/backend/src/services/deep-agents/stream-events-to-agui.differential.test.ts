import { EventType, type BaseEvent } from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import { CogniplaneCustomEventSchema } from "@cogniplane/shared-types";
import { loadMcpTools } from "@langchain/mcp-adapters";
import { describe, expect, it, vi } from "vitest";

import {
  createStreamEventsToAGUIState,
  flushOpenAGUIMessages,
  streamEventsToAGUI,
  type DeepAgentsStreamEvent
} from "./stream-events-to-agui.js";
import { AguiTurnAccumulator } from "../agui-turn-accumulator.js";

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
  it("does not mount an app for a failed MCP call", () => {
    const state = createStreamEventsToAGUIState();
    const options = { mcpToolNames: new Set(["show_quote_picker"]), mcpToolServers: new Map([["show_quote_picker", "quote-server"]]) };
    streamEventsToAGUI(state, { event: "on_tool_start", name: "show_quote_picker", run_id: "failed", metadata: {}, data: { input: {} } }, options);
    const events = streamEventsToAGUI(state, { event: "on_tool_end", name: "show_quote_picker", run_id: "failed", metadata: {},
      data: { output: { status: "error", content: { type: "text", text: "Tool failed",
        meta: { cogniplaneAppResourceUri: "ui://quote-picker/app.html" } } } } }, options);
    expect(events.some((event) => event.type === EventType.CUSTOM && event.name === "tool_mcp_app")).toBe(false);
  });

  it("keeps object output from a non-MCP tool intact", () => {
    const state = createStreamEventsToAGUIState();
    streamEventsToAGUI(state, { event: "on_tool_start", name: "read_table", run_id: "table", metadata: {}, data: { input: {} } });
    const events = streamEventsToAGUI(state, { event: "on_tool_end", name: "read_table", run_id: "table", metadata: {},
      data: { output: { content: { text: "Summary", rows: [1, 2], status: "ok" } } } });
    expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
      content: JSON.stringify({ text: "Summary", rows: [1, 2], status: "ok" })
    });
  });

  it("carries a linked MCP App result through the live event and saved tool row", () => {
    const state = createStreamEventsToAGUIState();
    const options = { mcpToolNames: new Set(["show_quote_picker"]), mcpToolServers: new Map([["show_quote_picker", "quote-server"]]) };
    const start = streamEventsToAGUI(state, {
      event: "on_tool_start", name: "show_quote_picker", run_id: "call-1", metadata: {},
      data: { input: { seats: 80, token: "private-token", nextPageToken: "cursor-2" } }
    }, options);
    const end = streamEventsToAGUI(state, {
      event: "on_tool_end", name: "show_quote_picker", run_id: "call-1", metadata: {},
      data: { output: {
        content: { type: "text", text: "Three quotes", structuredContent: { quotes: [1, 2, 3] },
          meta: { cogniplaneAppResourceUri: "ui://quote-picker/app.html", cogniplaneAppReadOnly: true,
            cogniplaneAppTurnContext: "scheduled" } },
        artifact: [
          { type: "mcp_structured_content", data: { quotes: [1, 2, 3] } },
          { type: "mcp_meta", data: { cogniplaneAppResourceUri: "ui://quote-picker/app.html", cogniplaneAppReadOnly: true } }
        ]
      } }
    }, options);
    const event = end.find((item) => item.type === EventType.CUSTOM && item.name === "tool_mcp_app");
    expect(JSON.stringify(start)).not.toContain("private-token");
    expect(event).toMatchObject({ value: { toolCallId: "call-1", app: {
      resourceUri: "ui://quote-picker/app.html",
      readOnly: true,
      turnContext: "scheduled",
      input: { seats: 80, token: "[REDACTED]", nextPageToken: "cursor-2" },
      result: { content: [{ type: "text", text: "Three quotes" }], structuredContent: { quotes: [1, 2, 3] } }
    } } });
    const turn = new AguiTurnAccumulator();
    for (const item of [...start, ...end]) turn.apply(item);
    expect(turn.toolResults()[0]).toMatchObject({
      toolResultId: "call-1", kind: "mcp", server: "quote-server", status: "completed",
      mcpApp: { resourceUri: "ui://quote-picker/app.html", input: { seats: 80, token: "[REDACTED]", nextPageToken: "cursor-2" } }
    });
  });

  describe("embedded resource blocks", () => {
    // No quotes, so a JSON-serialized copy still contains this exact text.
    const html = "<button>legacy-inline-html</button>";
    const blob = "PGI+YmxvYjwvYj4=";
    const mcpOptions = { mcpToolNames: new Set(["legacy_widget"]), mcpToolServers: new Map([["legacy_widget", "legacy"]]) };
    const resourceBlocks = [
      { type: "resource", resource: { uri: "ui://legacy/verification", mimeType: "text/html", text: html } },
      { type: "resource", resource: { uri: "file:///report.bin", mimeType: "application/octet-stream", blob } }
    ];
    const fallback = "[Embedded resource not displayed: ui://legacy/verification (text/html)]\n" +
      "[Embedded resource not displayed: file:///report.bin (application/octet-stream)]";

    function mapResult(output: unknown) {
      const state = createStreamEventsToAGUIState();
      const events = [
        ...streamEventsToAGUI(state, { event: "on_tool_start", name: "legacy_widget", run_id: "call-1", metadata: {}, data: { input: {} } }, mcpOptions),
        ...streamEventsToAGUI(state, { event: "on_tool_end", name: "legacy_widget", run_id: "call-1", metadata: {}, data: { output } }, mcpOptions)
      ];
      const turn = new AguiTurnAccumulator();
      for (const event of events) turn.apply(event);
      const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT) as BaseEvent & { content: string };
      return { events, result, saved: turn.toolResults()[0]! };
    }

    function expectNoLegacyResources(events: BaseEvent[], saved: object) {
      expect(events.filter((event) => event.type === EventType.CUSTOM).map((event) => (event as { name?: string }).name))
        .toEqual(["tool_meta"]);
      expect(JSON.stringify(events)).not.toContain(html);
      expect(JSON.stringify(events)).not.toContain(blob);
      expect(saved).not.toHaveProperty("uiResources");
      expect(saved).not.toHaveProperty("mcpApp");
    }

    it("names raw content resource blocks without a legacy event or their body", () => {
      const { events, result, saved } = mapResult({ content: resourceBlocks });
      expect(result.content).toBe(fallback);
      expect(saved).toMatchObject({ status: "completed", output: fallback });
      expectNoLegacyResources(events, saved);
    });

    it("names resource blocks that the MCP adapter moved to the artifact", async () => {
      // The installed adapter converts a real tools/call result. Inline
      // resources go to the ToolMessage artifact and the content stays empty.
      const client = {
        listTools: async () => ({ tools: [{ name: "legacy_widget", inputSchema: { type: "object", properties: {} } }] }),
        callTool: async () => ({ content: resourceBlocks })
      };
      const [tool] = await loadMcpTools("legacy", client as unknown as Parameters<typeof loadMcpTools>[1]);
      const message = await tool!.invoke({ type: "tool_call", id: "call-1", name: "legacy_widget", args: {} });
      expect(message.content).toEqual([]);
      expect(JSON.stringify(message.artifact)).toContain(html);

      const { events, result, saved } = mapResult(message);
      expect(result.content).toBe(fallback);
      expect(saved).toMatchObject({ status: "completed", output: fallback });
      expectNoLegacyResources(events, saved);

      const fromString = mapResult({ content: "", artifact: resourceBlocks });
      expect(fromString.result.content).toBe(fallback);
    });

    it("keeps tool text and images ahead of the resource fallback", () => {
      expect(mapResult({ content: [{ type: "text", text: "Sales" }, ...resourceBlocks] }).result.content).toBe("Sales");
      expect(mapResult({ content: [{ type: "image", data: "aW1n", mimeType: "image/png" }], artifact: resourceBlocks }).result.content)
        .toBe("[image]");
      expect(mapResult({ content: "Done", artifact: resourceBlocks }).result.content).toBe("Done");
    });

    it("keeps a failed result failed and names its resources", () => {
      const { events, result, saved } = mapResult({ status: "error", content: resourceBlocks });
      expect(result.content).toBe(fallback);
      expect(events).toContainEqual(expect.objectContaining({ type: EventType.CUSTOM, name: "tool_status",
        value: expect.objectContaining({ toolCallId: "call-1", status: "failed" }) }));
      expect(saved).toMatchObject({ status: "failed", output: fallback });
      expect(JSON.stringify(events)).not.toContain(html);
    });

    it("neutralizes NUL bytes in a resource name", () => {
      const { result } = mapResult({ content: [{ type: "resource", resource: { uri: "ui://a\u0000b", mimeType: "text/html", text: html } }] });
      expect(result.content).toBe("[Embedded resource not displayed: ui://a\uFFFDb (text/html)]");
    });

    it("keeps the app call and the fallback separate for an MCP App result", () => {
      const { events, result, saved } = mapResult({
        content: [],
        artifact: [...resourceBlocks, { type: "mcp_meta", data: { cogniplaneAppResourceUri: "ui://quote-picker/app.html" } }]
      });
      expect(result.content).toBe(fallback);
      expect(saved.mcpApp).toEqual({ resourceUri: "ui://quote-picker/app.html", readOnly: false, turnContext: null,
        input: {}, result: { content: [] } });
      expect(events.map((event) => (event as { name?: string }).name).filter(Boolean)).toEqual(["tool_meta", "tool_mcp_app"]);
      expect(JSON.stringify(events)).not.toContain(html);
    });

    it("does not accept the retired event in the browser contract", () => {
      expect(CogniplaneCustomEventSchema.safeParse({ type: EventType.CUSTOM, name: "tool_ui_resources",
        value: { toolCallId: "call-1", uiResources: [{ uri: "ui://card", mimeType: "text/html", text: html }] } }).success)
        .toBe(false);
    });
  });

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
      "tool_meta"
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
    expect(JSON.stringify(directEvents)).not.toContain("<p>chart</p>");

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
