import { EventType, type BaseEvent } from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import { GENERATIVE_UI_PANEL_TARGET, MAX_RENDER_UI_ARGS_CHARS } from "@cogniplane/shared-types";
import { describe, expect, it, vi } from "vitest";
import { AguiTurnAccumulator } from "../agui-turn-accumulator.js";
import { toAguiMessages } from "../agui-history.js";
import { createStreamEventsToAGUIState, flushOpenAGUIMessages, streamEventsToAGUI } from "./stream-events-to-agui.js";
import { RenderUiStream } from "./render-ui-stream.js";
import { RenderUiTurn } from "./render-ui.js";

const create = (surfaceId = "s", text = "Plan") => ({ version: "v1.0", createSurface: {
  surfaceId, components: [{ id: "root", component: "Text", text }]
} });
const args = (...operations: unknown[]) => ({ target: "chat", operations });
const start = (run_id: string, input: unknown) => ({ event: "on_tool_start", name: "render_ui", run_id, data: { input } });
const end = (run_id: string, status = "success") => ({ event: "on_tool_end", name: "render_ui", run_id, data: { output: { status, content: "Rendered" } } });
const chunk = (args: string, index = 0, name?: string, run_id = "model") => ({
  event: "on_chat_model_stream", run_id,
  data: { chunk: { content: "", tool_call_chunks: [{ index, args, ...(name ? { name } : {}) }] } }
});
const surfaces = (events: BaseEvent[]) => events.filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT) as Array<BaseEvent & { messageId: string; content: Record<string, unknown> }>;
const mapper = () => {
  const state = createStreamEventsToAGUIState();
  return (event: Record<string, unknown>) => streamEventsToAGUI(state, event, { assistantMessageId: "a1" });
};

describe("render_ui streamed operations and history", () => {
  it("shows whole operations before the tool starts, closes text first and restores the same surfaces from saved rows", () => {
    const map = mapper();
    const events: BaseEvent[] = [];
    events.push(...map({ event: "on_chat_model_stream", data: { chunk: { content: "Here is the plan." } } }));
    const input = args(create(), { version: "v1.0", updateDataModel: { surfaceId: "s", value: { seats: 3 } } });
    const text = JSON.stringify(input);
    const boundary = text.indexOf(',{"version":', 50);
    const first = map(chunk(text.slice(0, boundary), 0, "render_ui"));
    expect(first[0]!.type).toBe(EventType.TEXT_MESSAGE_END);
    expect(surfaces(first)[0]!.content).toMatchObject({ status: "streaming", operations: [expect.anything()] });
    events.push(...first, ...map(chunk(text.slice(boundary))));
    events.push(...map(start("call1", input)), ...map(end("call1")));
    events.push(...map(start("call2", args({ version: "v1.0", updateComponents: {
      surfaceId: "s", components: [{ id: "root", component: "Text", text: "Updated plan" }]
    } }))), ...map(end("call2")));
    const activityEvents = surfaces(events);
    expect(activityEvents.at(-1)!.content).toMatchObject({ status: "ready", operations: expect.any(Array) });
    expect(activityEvents.at(-1)!.content.operations).toHaveLength(3);
    events.forEach((event) => expect(EventSchemas.safeParse(event).success, JSON.stringify(event)).toBe(true));
    const accumulator = new AguiTurnAccumulator();
    events.forEach((event) => accumulator.apply(event));
    expect(accumulator.toolResults()).toHaveLength(2);
    expect(accumulator.toolResults()[0]!.input).toBe(text);
    const history = toAguiMessages([{
      messageId: "a1", role: "assistant", status: "completed", content: accumulator.assistantText,
      toolResults: accumulator.toolResults()
    }]);
    const restored = history.filter((message) => message.role === "activity");
    expect(restored).toEqual([{
      id: activityEvents.at(-1)!.messageId, role: "activity", activityType: "generative-ui-surface",
      content: activityEvents.at(-1)!.content
    }]);
    expect(history.map((message) => message.role)).toEqual(["assistant", "activity", "assistant", "tool", "assistant", "tool"]);
  });

  it("streams a side-panel surface, refuses a move to the chat, and restores the same targets from saved rows", () => {
    const state = createStreamEventsToAGUIState();
    const map = (event: Record<string, unknown>) => streamEventsToAGUI(state, event, { assistantMessageId: "a1" });
    const panel = (...operations: unknown[]) => ({ target: GENERATIVE_UI_PANEL_TARGET, operations });
    const updatePanel = { version: "v1.0", updateComponents: { surfaceId: "p", components: [{ id: "root", component: "Text", text: "Panel v2" }] } };
    const calls = [
      ["one", panel(create("p", "Panel v1"))],
      ["move", args(updatePanel)],
      ["two", panel(updatePanel)]
    ] as const;
    const events: BaseEvent[] = [];
    const preview = map(chunk(JSON.stringify(calls[0][1]), 0, "render_ui"));
    expect(surfaces(preview)[0]!.content).toMatchObject({ target: GENERATIVE_UI_PANEL_TARGET, status: "streaming" });
    events.push(...preview);
    for (const [id, input] of calls) {
      events.push(...map(start(id, input)), ...map(end(id, id === "move" ? "error" : "success")));
    }
    events.push(...flushOpenAGUIMessages(state));
    const latest = new Map(surfaces(events).map((event) => [event.messageId, event.content]));
    expect(latest.get("genui:turn:a1:p")).toMatchObject({ target: GENERATIVE_UI_PANEL_TARGET, status: "ready" });
    expect((latest.get("genui:turn:a1:p")!.operations as unknown[])).toHaveLength(2);
    // The refused move has no surface, so its error shows in the chat.
    expect(latest.get("genui:error:turn:a1:move")).toMatchObject({ target: "chat", status: "error", operations: [] });
    const accumulator = new AguiTurnAccumulator();
    events.forEach((event) => accumulator.apply(event));
    const history = toAguiMessages([{ messageId: "a1", role: "assistant", status: "completed", content: "",
      toolResults: accumulator.toolResults() }]);
    const restored = history.filter((message) => message.role === "activity");
    expect(new Map(restored.map((message) => [message.id, message.content]))).toEqual(latest);
  });

  it("deletes the preview error of a refused call when its tool starts, so no empty card shows, and ends equal to history", () => {
    const state = createStreamEventsToAGUIState();
    const events: BaseEvent[] = [];
    const step = (out: BaseEvent[]) => { events.push(...out); return surfaces(out); };
    const map = (event: Record<string, unknown>) => step(streamEventsToAGUI(state, event, { assistantMessageId: "a1" }));
    const input = args({ version: "v1.0", updateComponents: {
      surfaceId: "missing", components: [{ id: "root", component: "Text", text: "Updated" }]
    } });
    const refused = { index: 0, reason: "Create this surface in the current turn first" };

    const preview = map(chunk(JSON.stringify(input), 0, "render_ui"));
    expect(preview.map((event) => event.content)).toEqual([expect.objectContaining({
      target: "chat", status: "error", operations: [], rejected: [refused] })]);
    const previewId = preview[0]!.messageId;
    // The tool run id replaces the preview id, so the error moves to a new activity.
    const started = new Map(map(start("call1", input)).map((event) => [event.messageId, event.content]));
    expect(started.get("genui:error:turn:a1:call1")).toMatchObject({ status: "error", operations: [], rejected: [refused] });
    expect(started.get(previewId)).toMatchObject({ status: "ready", rejected: [],
      operations: [{ version: "v1.0", deleteSurface: { surfaceId: expect.stringMatching(/^error:turn:a1:/) } }] });
    map(end("call1", "error"));
    step(flushOpenAGUIMessages(state));

    expect(surfaces(events).filter((event) =>
      (event.content.operations as unknown[]).length === 0 && (event.content.rejected as unknown[]).length === 0)).toEqual([]);
    const latest = new Map(surfaces(events).map((event) => [event.messageId, event.content]));
    const shown = [...latest].filter(([, content]) =>
      !(content.operations as object[]).some((operation) => "deleteSurface" in operation));
    const accumulator = new AguiTurnAccumulator();
    events.forEach((event) => accumulator.apply(event));
    const history = toAguiMessages([{ messageId: "a1", role: "assistant", status: "completed", content: "",
      toolResults: accumulator.toolResults() }]);
    expect(new Map(shown)).toEqual(new Map(history.filter((message) => message.role === "activity")
      .map((message) => [message.id, message.content])));
  });

  it("shows the error of a call again when an earlier parallel call takes the surface that it rendered", () => {
    const stream = new RenderUiStream("a1");
    const errorId = "genui:error:turn:a1:model:index:1";
    const update = { version: "v1.0", updateComponents: { surfaceId: "a", components: [{ id: "root", component: "Text", text: "x" }] } };
    const text = JSON.stringify(args(update, create("b")));
    const boundary = text.indexOf(',{"version":', 30);
    const byId = (events: BaseEvent[]) => new Map(surfaces(events).map((event) => [event.messageId, event.content]));

    expect(byId(stream.push("model", [{ index: 1, name: "render_ui", args: text.slice(0, boundary) }])).get(errorId))
      .toMatchObject({ operations: [], rejected: [{ index: 0 }] });
    // The call now renders surface b, so its error activity goes.
    expect(byId(stream.push("model", [{ index: 1, args: text.slice(boundary) }])).get(errorId))
      .toMatchObject({ operations: [{ deleteSurface: { surfaceId: "error:turn:a1:model:index:1" } }] });
    // Call 0 comes first and creates b, so call 1 renders nothing again.
    expect(byId(stream.push("model", [{ index: 0, name: "render_ui", args: JSON.stringify(args(create("b"))) }])).get(errorId))
      .toMatchObject({ status: "error", operations: [], rejected: [{ index: 0 }, { index: 1, reason: "Surface id already used in this turn" }] });
  });

  it("previews no surface for a target outside the allowlist, and reports the rejection in the chat", () => {
    const map = mapper();
    const input = { target: "#main", operations: [create("x")] };
    expect(surfaces(map(chunk(JSON.stringify(input), 0, "render_ui")))).toEqual([]);
    const final = surfaces([...map(start("bad", input)), ...map(end("bad", "error"))]);
    expect(final.at(-1)!.content).toMatchObject({ target: "chat", status: "error", operations: [],
      rejected: [{ index: 0, reason: expect.stringContaining(GENERATIVE_UI_PANEL_TARGET) }] });
  });

  it("withdraws an oversized side-panel preview without a delete, so a retry with the same id renders, and deletes it at run end", () => {
    const id = "genui:turn:a1:s";
    const panelPreview = () => {
      const state = createStreamEventsToAGUIState();
      const map = (event: Record<string, unknown>) => streamEventsToAGUI(state, event, { assistantMessageId: "a1" });
      const head = JSON.stringify({ target: GENERATIVE_UI_PANEL_TARGET, operations: [create("s", "Panel preview")] }).slice(0, -2) + ",";
      expect(surfaces(map(chunk(head, 0, "render_ui")))[0]!.content).toMatchObject({ target: GENERATIVE_UI_PANEL_TARGET, status: "streaming" });
      const withdrawn = surfaces(map(chunk(" ".repeat(MAX_RENDER_UI_ARGS_CHARS))));
      // The browser reads a panel activity with no operations as withdrawn. A
      // delete here would burn the id for the rest of the turn.
      expect(withdrawn.find((event) => event.messageId === id)!.content)
        .toMatchObject({ target: GENERATIVE_UI_PANEL_TARGET, status: "error", operations: [] });
      expect(withdrawn.find((event) => event.messageId !== id)!.content).toMatchObject({ target: "chat", status: "error" });
      return { state, map };
    };

    const retried = panelPreview();
    const retry = { target: GENERATIVE_UI_PANEL_TARGET, operations: [create("s", "Smaller panel")] };
    expect(surfaces([...retried.map(start("retry", retry)), ...retried.map(end("retry"))]).at(-1)).toMatchObject({
      messageId: id, content: { target: GENERATIVE_UI_PANEL_TARGET, status: "ready", operations: [expect.anything()] }
    });
    expect(surfaces(flushOpenAGUIMessages(retried.state)).filter((event) => event.messageId === id)).toEqual([]);

    const abandoned = panelPreview();
    expect(surfaces(flushOpenAGUIMessages(abandoned.state)).find((event) => event.messageId === id)!.content).toMatchObject({
      target: GENERATIVE_UI_PANEL_TARGET, operations: [{ version: "v1.0", deleteSurface: { surfaceId: "turn:a1:s" } }]
    });
  });

  it("restores side-panel surfaces of several replies in reply order", () => {
    const tool = (surfaceId: string) => ({ toolResultId: `call-${surfaceId}`, toolName: "render_ui", title: "render_ui", status: "completed" as const,
      input: JSON.stringify({ target: GENERATIVE_UI_PANEL_TARGET, operations: [create(surfaceId)] }), output: "" });
    const history = toAguiMessages([
      { messageId: "a1", role: "assistant", status: "completed", content: "First", toolResults: [tool("p")] },
      { messageId: "a2", role: "assistant", status: "completed", content: "Second", toolResults: [tool("p")] }
    ]);
    expect(history.filter((message) => message.role === "activity").map((message) => [message.id, message.content.target]))
      .toEqual([["genui:turn:a1:p", GENERATIVE_UI_PANEL_TARGET], ["genui:turn:a2:p", GENERATIVE_UI_PANEL_TARGET]]);
  });

  it("handles interleaved parallel indexes and a later model run without mixing calls", () => {
    const map = mapper();
    const a = JSON.stringify(args(create("a")));
    const b = JSON.stringify(args(create("b")));
    map(chunk(a.slice(0, 40), 0, "render_ui"));
    map(chunk(b, 1, "render_ui"));
    map(chunk(a.slice(40), 0));
    const events = [...map(start("a", JSON.parse(a))), ...map(start("b", JSON.parse(b))), ...map(end("b")), ...map(end("a"))];
    expect(new Set(surfaces(events).map((event) => event.messageId))).toEqual(new Set(["genui:turn:a1:a", "genui:turn:a1:b"]));
    const second = JSON.stringify(args(create("c")));
    expect(surfaces(map(chunk(second, 0, "render_ui", "model2")))).toHaveLength(1);
  });

  it("buffers argument chunks whose name arrives later", () => {
    const map = mapper();
    expect(map(chunk(JSON.stringify(args(create()))))).toEqual([]);
    expect(surfaces(map(chunk("", 0, "render_ui")))[0]!.content.operations).toHaveLength(1);
  });

  it.each([false, true])("keeps provider call IDs separate when indexes are reused: %s", (withIndex) => {
    const stream = new RenderUiStream("a1");
    const inputs = [args(create("a")), args(create("b"))];
    const events = inputs.flatMap((input, index) => stream.push("model", [{
      id: `gemini-${index}`, ...(withIndex ? { index: 0 } : {}), name: "render_ui", args: JSON.stringify(input)
    }]));
    inputs.forEach((input, index) => events.push(...stream.start(`tool-${index}`, JSON.stringify(input)), ...stream.end(`tool-${index}`, false)));
    events.push(...stream.finish());
    const latest = new Map(surfaces(events).map((event) => [event.messageId, event.content]));
    expect([...latest.keys()]).toEqual(["genui:turn:a1:a", "genui:turn:a1:b"]);
    expect([...latest.values()]).toEqual(["a", "b"].map((surfaceId) => ({
      surfaceId: `turn:a1:${surfaceId}`, target: "chat", catalogId: "cogniplane/standard@1",
      operations: [create(`turn:a1:${surfaceId}`)], status: "ready", rejected: []
    })));
  });

  it("does not replay the turn for chunks without a complete new operation", () => {
    const stream = new RenderUiStream("a1");
    stream.push("model", [{ index: 0, name: "render_ui", args: JSON.stringify(args(create())).slice(0, -2) }]);
    const rebuild = vi.spyOn(RenderUiTurn.prototype, "activities");
    try {
      for (let i = 0; i < 100; i++) stream.push("model", [{ index: 0, args: " " }]);
      expect(rebuild).not.toHaveBeenCalled();
    } finally { rebuild.mockRestore(); }
  });

  it.each(["truncated", "guard failure"])("withdraws an unclaimed %s preview at run end", (failure) => {
    const state = createStreamEventsToAGUIState();
    const input = JSON.stringify(args(create()));
    const preview = streamEventsToAGUI(state, chunk(failure === "truncated" ? input.slice(0, -2) : input, 0, "render_ui"), { assistantMessageId: "a1" });
    expect(surfaces(preview)[0]!.content.status).toBe("streaming");
    expect(flushOpenAGUIMessages(state, false)).toEqual([]);
    const withdrawn = surfaces(flushOpenAGUIMessages(state));
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]!.content).toMatchObject({ status: "ready", rejected: [], operations: [
      expect.anything(), { version: "v1.0", deleteSurface: { surfaceId: "turn:a1:s" } }
    ] });
    expect(flushOpenAGUIMessages(state)).toEqual([]);
  });

  it("settles a started call without a result as the same error activity as history", () => {
    const stream = new RenderUiStream("a1");
    stream.start("one", JSON.stringify(args(create())));
    const final = surfaces(stream.finish())[0]!;
    const history = toAguiMessages([{ messageId: "a1", role: "assistant", status: "interrupted", content: "",
      toolResults: [{ toolResultId: "one", toolName: "render_ui", title: "render_ui", status: "in_progress", input: JSON.stringify(args(create())), output: "" }] }]);
    expect(history.find((message) => message.role === "activity")).toEqual({
      id: final.messageId, role: "activity", activityType: "generative-ui-surface", content: final.content
    });
  });

  it("leaves legacy MCP tools named render_ui as ordinary history", () => {
    const history = toAguiMessages([{ messageId: "a1", role: "assistant", status: "completed", content: "",
      toolResults: [{ toolResultId: "old", toolName: "render_ui", title: "Tool: render_ui", status: "completed", input: JSON.stringify(args(create())), output: "legacy" }] }]);
    expect(history.some((message) => message.role === "activity")).toBe(false);
    expect(history.find((message) => message.role === "tool")).toMatchObject({ content: "legacy" });
  });

  it("supports providers that deliver arguments only at tool start", () => {
    const map = mapper();
    expect(surfaces(map(start("one", args(create()))))[0]!.content.status).toBe("streaming");
    expect(surfaces(map(end("one")))[0]!.content.status).toBe("ready");
  });

  it("stops oversized argument streams, reports failed results and ignores subagent UI", () => {
    const map = mapper();
    const oversized = map(chunk('{' + ' '.repeat(MAX_RENDER_UI_ARGS_CHARS + 20), 0, "render_ui"));
    expect(surfaces(oversized)[0]!.content.status).toBe("error");
    expect(map(chunk("more"))).toEqual([]);
    expect(map({ ...chunk(JSON.stringify(args(create())), 0, "render_ui"), metadata: { langgraph_checkpoint_ns: "tools:parent|model:child" } })).toEqual([]);
    map(start("fail", args(create("failed"))));
    expect(surfaces(map(end("fail", "error"))).at(-1)!.content.status).toBe("error");
  });

  it.each(["in_progress", "failed", "declined"] as const)("restores %s calls as errors and isolates the same surface id across replies", (status) => {
    const tool = { toolResultId: "one", toolName: "render_ui", title: "render_ui", status, input: JSON.stringify(args(create())), output: "" };
    const restored = toAguiMessages(["a1", "a2"].map((messageId) => ({ messageId, role: "assistant", status: "interrupted", content: "", toolResults: [tool] })));
    const activities = restored.filter((message) => message.role === "activity");
    expect(activities.map((message) => message.id)).toEqual(["genui:turn:a1:s", "genui:turn:a2:s"]);
    expect(activities.every((message) => message.content.status === "error")).toBe(true);
  });
});
