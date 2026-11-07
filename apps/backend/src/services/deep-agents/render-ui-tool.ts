import { A2UI_VERSION } from "@copilotkit/shared";
import { tool, type ToolRuntime } from "langchain";
import { isAIMessage, isHumanMessage, isToolMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { GENERATIVE_UI_RENDER_TOOL, RENDER_UI_TRANSPORT_DISABLED, RenderUiTurn, renderUiArgsSchema } from "./render-ui.js";

type UiToolContext = { generativeUiContext?: string | null; generativeUiTransport?: "tool" };

export const renderUiTool = tool((input, runtime: ToolRuntime<{ messages: BaseMessage[] }, UiToolContext>) => {
  if (runtime.context?.generativeUiTransport !== "tool" || !runtime.context.generativeUiContext) {
    return new ToolMessage({ tool_call_id: runtime.toolCallId, status: "error", content: RENDER_UI_TRANSPORT_DISABLED });
  }
  const turn = new RenderUiTurn("validation");
  const messages = runtime.state.messages;
  let start = messages.length;
  while (start > 0 && !isHumanMessage(messages[start - 1]!)) start -= 1;
  const currentTurn = messages.slice(start);
  const executed = new Set(currentTurn.filter(isToolMessage).filter((message) => {
    try {
      const result = JSON.parse(String(message.content));
      return Array.isArray(result.rendered) && Array.isArray(result.rejected);
    } catch { return false; }
  }).map((message) => message.tool_call_id));
  const currentBatch = currentTurn.find((message) => isAIMessage(message) &&
    message.tool_calls?.some((call) => call.id === runtime.toolCallId));
  // Include preceding calls in model order, including parallel calls. This
  // makes parallel checks deterministic. Earlier batches count only if the
  // tool checked them; an argument parse failure must not reserve a surface
  // id. The stream and history also apply no operation of a refused call.
  outer: for (const message of currentTurn) {
    if (!isAIMessage(message)) continue;
    for (const call of message.tool_calls ?? []) {
      if (call.id === runtime.toolCallId) break outer;
      if (call.name === GENERATIVE_UI_RENDER_TOOL && call.id && (message === currentBatch || executed.has(call.id))) {
        turn.set({ id: call.id, input: call.args, status: "ready" });
      }
    }
  }
  turn.set({ id: runtime.toolCallId, input, status: "ready" });
  const result = turn.result(runtime.toolCallId);
  return new ToolMessage({ tool_call_id: runtime.toolCallId, content: JSON.stringify(result),
    status: result.rejected.length > 0 ? "error" : "success" });
}, {
  name: GENERATIVE_UI_RENDER_TOOL,
  // The browser guide names the targets that its page mounts. An older tab
  // has no side panel, so this text does not name one.
  description: `Render standard UI components in a target that the browser guide lists. Use A2UI ${A2UI_VERSION} operations `
    + "and a new surface id in this turn. Generated events cannot start agent turns.",
  schema: renderUiArgsSchema
});
