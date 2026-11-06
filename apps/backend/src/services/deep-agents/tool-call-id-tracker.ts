import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

/**
 * Records the model's call ID of each tool run, by the run ID that the
 * `on_tool_start` stream event carries. The event leaves the call ID out
 * (@langchain/core 1.3 event tracer sends only `extra.metadata`), but the
 * tool-start callback receives it.
 *
 * `awaitHandlers` makes the callback manager run this handler inline, before
 * it returns from `handleToolStart`. The event tracer sends the event only
 * after an `await`, and the stream consumer reads it later, so the ID is
 * recorded before the event can arrive. A backgrounded handler would race the
 * consumer. deep-agents-graph.test.ts pins this order.
 *
 * One tracker serves one turn. It keeps every run of the turn: a fast tool can
 * end before the consumer reads its start event.
 */
export class ToolCallIdTracker extends BaseCallbackHandler {
  name = "ToolCallIdTracker";
  override awaitHandlers = true;
  private readonly modelCallIds = new Map<string, string>();

  override handleToolStart(
    _tool: unknown, _input: string, runId: string, _parentRunId?: string, _tags?: string[],
    _metadata?: Record<string, unknown>, _runName?: string, toolCallId?: string
  ): void {
    if (toolCallId) this.modelCallIds.set(runId, toolCallId);
  }

  /** The model's call ID of a tool run, if the tool was called with one. */
  modelCallIdOf(runId: string): string | undefined {
    return this.modelCallIds.get(runId);
  }
}
