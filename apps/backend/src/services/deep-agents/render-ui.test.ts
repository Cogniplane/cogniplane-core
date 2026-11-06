import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";
import { GENERATIVE_UI_PANEL_TARGET, MAX_RENDER_UI_ARGS_CHARS, MAX_RENDER_UI_OPERATIONS } from "@cogniplane/shared-types";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createAgent, FakeToolCallingModel } from "langchain";
import { AguiTurnAccumulator } from "../agui-turn-accumulator.js";
import { toAguiMessages } from "../agui-history.js";
import { LIST_TOOL_TEXT_MAX_CHARS } from "../message-store.js";
import { GENERATIVE_UI_RENDER_TOOL, RENDER_UI_TRANSPORT_DISABLED, RenderUiTurn, renderUiArgsSchema } from "./render-ui.js";
import { createStreamEventsToAGUIState, flushOpenAGUIMessages, streamEventsToAGUI } from "./stream-events-to-agui.js";
import { renderUiTool } from "./render-ui-tool.js";
import { generativeUiContextMiddleware } from "./generative-ui-context-middleware.js";

const create = (surfaceId = "s") => ({ version: "v1.0", createSurface: {
  surfaceId, components: [{ id: "root", component: "Text", text: "Plan" }]
} });
const update = (surfaceId = "s") => ({ version: "v1.0", updateDataModel: { surfaceId, path: "/seats", value: 4 } });
const args = (...operations: unknown[]) => ({ target: "chat", operations });

describe("render_ui protocol and reply scope", () => {
  it("updates and deletes a surface across calls in one turn, and scopes its activity id to the reply", () => {
    const turn = new RenderUiTurn("a1");
    turn.set({ id: "one", input: args(create()), status: "ready" });
    turn.set({ id: "two", input: args(update()), status: "ready" });
    const activity = turn.activities()[0]!;
    expect(activity.id).toBe("genui:turn:a1:s");
    expect(activity.content.operations).toHaveLength(2);
    expect(activity.content.operations[1]).toEqual({ version: "v1.0", updateDataModel: { surfaceId: "turn:a1:s", path: "/seats", value: 4 } });
    expect(turn.result("two")).toEqual({ rendered: ["s"], rejected: [] });
    turn.set({ id: "three", input: args({ version: "v1.0", deleteSurface: { surfaceId: "s" } }), status: "ready" });
    turn.set({ id: "four", input: args(create()), status: "ready" });
    expect(turn.result("four").rejected[0]!.reason).toContain("already used");
    const next = new RenderUiTurn("a2");
    next.set({ id: "five", input: args(update()), status: "ready" });
    expect(next.result("five").rejected[0]!.reason).toContain("current turn");
    next.set({ id: "six", input: args(create()), status: "ready" });
    expect(next.activities().at(-1)!.id).toBe("genui:turn:a2:s");
  });

  it.each([
    ["version", args({ ...create(), version: "v0.9" })],
    ["two kinds", args({ ...create(), deleteSurface: { surfaceId: "s" } })],
    ["renderer function", args({ version: "v1.0", callRendererFunction: { functionCallId: "x", callFunction: { "@call": "openUrl" } } })],
    ["target", { ...args(create()), target: "sidebar" }],
    ["page element target", { ...args(create()), target: "#main" }],
    ["target list", { ...args(create()), target: ["chat", GENERATIVE_UI_PANEL_TARGET] }],
    ["catalog", args({ version: "v1.0", createSurface: { surfaceId: "s", catalogId: "other" } })],
    ["operations count", args(...Array.from({ length: MAX_RENDER_UI_OPERATIONS + 1 }, () => create()))],
    ["size", args({ version: "v1.0", createSurface: { surfaceId: "s", dataModel: { value: "x".repeat(MAX_RENDER_UI_ARGS_CHARS) } } })],
    ["truncated input", '{"target":"chat","operations":['],
    ["empty", args()]
  ])("rejects %s without throwing or accepting operations", (_, input) => {
    const turn = new RenderUiTurn("a1");
    turn.set({ id: "bad", input, status: "ready" });
    expect(turn.result("bad").rejected).not.toHaveLength(0);
    expect(turn.activities()[0]!.content).toMatchObject({ status: "error", operations: [] });
  });

  it("renders into the side panel and keeps the target of each surface across calls", () => {
    const turn = new RenderUiTurn("a1");
    turn.set({ id: "panel", input: { target: GENERATIVE_UI_PANEL_TARGET, operations: [create("p")] }, status: "ready" });
    turn.set({ id: "chat", input: args(create("c")), status: "ready" });
    turn.set({ id: "panel-update", input: { target: GENERATIVE_UI_PANEL_TARGET, operations: [update("p")] }, status: "ready" });
    expect(turn.result("panel-update")).toEqual({ rendered: ["p"], rejected: [] });
    // Moving either surface to the other target is refused per operation.
    turn.set({ id: "move", input: { target: "chat", operations: [update("p"), update("c")] }, status: "ready" });
    expect(turn.result("move").rendered).toEqual(["c"]);
    expect(turn.result("move").rejected).toEqual([{ index: 0, reason: expect.stringContaining(`target "${GENERATIVE_UI_PANEL_TARGET}"`) }]);
    turn.set({ id: "delete", input: { target: "chat", operations: [{ version: "v1.0", deleteSurface: { surfaceId: "p" } }] }, status: "ready" });
    expect(turn.result("delete").rejected[0]!.reason).toContain("Keep its target");
    // The panel keeps its view. The refusal goes to the surfaces that the
    // refused call rendered, or to a chat error when it rendered none.
    const [panel, chat, error] = turn.activities();
    expect(panel).toMatchObject({ id: "genui:turn:a1:p", content: { target: GENERATIVE_UI_PANEL_TARGET, status: "ready", rejected: [] } });
    expect(panel!.content.operations).toHaveLength(2);
    expect(chat).toMatchObject({ id: "genui:turn:a1:c", content: { target: "chat", status: "error" } });
    expect(chat!.content.operations).toHaveLength(2);
    expect(error).toMatchObject({ id: "genui:error:turn:a1:delete", content: { target: "chat", status: "error" } });
  });

  it("leaves the target names to the browser guide, so a tab without the panel is not offered one", () => {
    expect(renderUiTool.description).toContain("browser guide");
    expect(renderUiTool.description).not.toContain(GENERATIVE_UI_PANEL_TARGET);
    expect(renderUiArgsSchema.shape.target.description).toContain("browser guide");
    expect(renderUiArgsSchema.shape.target.description).not.toContain(GENERATIVE_UI_PANEL_TARGET);
  });

  it("keeps the error of a rejected side-panel call in the chat", () => {
    const turn = new RenderUiTurn("a1");
    turn.set({ id: "bad", input: { target: GENERATIVE_UI_PANEL_TARGET, operations: [update("missing")] }, status: "ready" });
    expect(turn.activities()).toEqual([expect.objectContaining({ content: expect.objectContaining({
      target: "chat", status: "error", operations: [], rejected: [expect.objectContaining({ reason: expect.stringContaining("current turn") })]
    }) })]);
  });

  it("keeps accepted arguments below the list projection's truncation limit", () => {
    expect(MAX_RENDER_UI_ARGS_CHARS).toBeLessThan(LIST_TOOL_TEXT_MAX_CHARS);
  });
});

describe("render_ui in the actual LangChain tool loop", () => {
  it.each([args(create(), 42), { target: "chat" }, { target: 42, operations: [create()] }, { target: "chat", operations: 42 },
    { ...args(create()), extra: "x".repeat(MAX_RENDER_UI_ARGS_CHARS) }])(
    "persists malformed arguments through normal tool start and end events: %j", async (input) => {
      const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[
        { name: GENERATIVE_UI_RENDER_TOOL, id: "bad", args: input }
      ], []] }), middleware: [generativeUiContextMiddleware] });
      const events = [];
      for await (const event of agent.streamEvents({ messages: [new HumanMessage("Show it")] }, {
        version: "v2", context: { generativeUiTransport: "tool", generativeUiContext: "Standard components" }
      })) events.push(event);
      const started = events.filter((event) => event.event === "on_tool_start" && event.name === GENERATIVE_UI_RENDER_TOOL);
      const ended = events.filter((event) => event.event === "on_tool_end" && event.name === GENERATIVE_UI_RENDER_TOOL);
      expect(started).toHaveLength(1);
      expect(ended).toHaveLength(1);
      const result = ended[0]!.data.output as ToolMessage;
      expect(result.status).toBe("error");
      expect(JSON.parse(result.content as string).rejected.length).toBeGreaterThan(0);
    }
  );

  it("does not reserve ids from an earlier batch that failed before the UI tool ran", async () => {
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[
      { name: GENERATIVE_UI_RENDER_TOOL, id: "retry", args: args(create()) }
    ], []] }), middleware: [generativeUiContextMiddleware] });
    const result = await agent.invoke({ messages: [new HumanMessage("Show it"),
      new AIMessage({ content: "", tool_calls: [{ name: GENERATIVE_UI_RENDER_TOOL, id: "bad", args: args(create()) }] }),
      new ToolMessage({ tool_call_id: "bad", status: "error", content: "Tool argument parsing failed" })
    ] }, { context: { generativeUiTransport: "tool", generativeUiContext: "Standard components" } });
    const retry = result.messages.find((message) => message instanceof ToolMessage && message.tool_call_id === "retry") as ToolMessage;
    expect(retry.status).toBe("success");
    expect(JSON.parse(retry.content as string)).toEqual({ rendered: ["s"], rejected: [] });
  });

  it.each([true, false])("executes with browser capability %s and returns a model-visible result", async (enabled) => {
    const calls = [{ name: GENERATIVE_UI_RENDER_TOOL, id: "call", args: args(create()) }];
    const model = new FakeToolCallingModel({ toolCalls: [calls, []] });
    const agent = createAgent({ model, middleware: [generativeUiContextMiddleware] });
    const result = await agent.invoke({ messages: [new HumanMessage("Show the plan")] }, {
      context: enabled ? { generativeUiTransport: "tool", generativeUiContext: "Standard components" } : {}
    });
    const response = result.messages.find((message) => message instanceof ToolMessage) as ToolMessage;
    expect(response).toBeDefined();
    expect(response.status).toBe(enabled ? "success" : "error");
    if (enabled) expect(JSON.parse(response.content as string)).toEqual({ rendered: ["s"], rejected: [] });
    else expect(response.content).toContain("not enabled");
  });

  it.each([true, false])("shows in the stream and in history only the calls that the tool checked, with browser capability %s", async (enabled) => {
    // A model can call render_ui when the turn did not offer it. The tool then refuses each call.
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [
      [{ name: GENERATIVE_UI_RENDER_TOOL, id: "one", args: args(create()) }],
      [{ name: GENERATIVE_UI_RENDER_TOOL, id: "two", args: args(create()) }], []] }), middleware: [generativeUiContextMiddleware] });
    const state = createStreamEventsToAGUIState();
    const events: BaseEvent[] = [];
    const results: string[] = [];
    for await (const event of agent.streamEvents({ messages: [new HumanMessage("Show it")] }, {
      version: "v2", context: enabled ? { generativeUiTransport: "tool", generativeUiContext: "Standard components" } : {}
    })) {
      if (event.event === "on_tool_end") results.push(String((event.data.output as ToolMessage).content));
      events.push(...streamEventsToAGUI(state, event as unknown as Record<string, unknown>, { assistantMessageId: "a1" }));
    }
    events.push(...flushOpenAGUIMessages(state));
    const latest = new Map(events.filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT).map((event) => {
      const { messageId, content } = event as BaseEvent & { messageId: string; content: { operations: object[]; rejected: object[] } };
      return [messageId, content];
    }));
    const shown = [...latest].filter(([, content]) => !content.operations.some((operation) => "deleteSurface" in operation));

    if (enabled) {
      expect(results.map((result) => JSON.parse(result))).toEqual([
        { rendered: ["s"], rejected: [] }, { rendered: [], rejected: [{ index: 0, reason: "Surface id already used in this turn" }] }
      ]);
      expect(shown.map(([, content]) => content.rejected)).toEqual([[], [{ index: 0, reason: "Surface id already used in this turn" }]]);
    } else {
      expect(results).toEqual([RENDER_UI_TRANSPORT_DISABLED, RENDER_UI_TRANSPORT_DISABLED]);
      // No surface, and each call shows the reason that the model got.
      expect(shown.map(([id, content]) => [id.startsWith("genui:error:"), content])).toEqual([0, 1].map(() => [true,
        expect.objectContaining({ target: "chat", status: "error", operations: [], rejected: [{ index: 0, reason: RENDER_UI_TRANSPORT_DISABLED }] })]));
    }
    const accumulator = new AguiTurnAccumulator();
    events.forEach((event) => accumulator.apply(event));
    const history = toAguiMessages([{ messageId: "a1", role: "assistant", status: "completed", content: "",
      toolResults: accumulator.toolResults() }]);
    expect(new Map(shown)).toEqual(new Map(history.filter((message) => message.role === "activity")
      .map((message) => [message.id, message.content])));
  });

  it("checks earlier calls in model order and rejects duplicate parallel creates", async () => {
    const calls = ["one", "two"].map((id) => ({ name: GENERATIVE_UI_RENDER_TOOL, id, args: args(create()) }));
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [calls, []] }), middleware: [generativeUiContextMiddleware] });
    const result = await agent.invoke({ messages: [new HumanMessage("Show it")] }, {
      context: { generativeUiTransport: "tool", generativeUiContext: "Standard components" }
    });
    const responses = result.messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
    expect(responses.map((m) => m.status)).toEqual(["success", "error"]);
    expect(result.messages.some((m) => m instanceof AIMessage && m.tool_calls?.length === 2)).toBe(true);
  });
});
