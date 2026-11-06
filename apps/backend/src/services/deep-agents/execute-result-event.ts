import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";

/**
 * The SDK `execute` tool turns the structured `ExecuteResponse` of the sandbox
 * into text ("[Command failed with exit code 19]") and returns it as a
 * successful `ToolMessage`. After that, only the text has the exit code.
 *
 * The E2B backend therefore reports the structured exit code from inside the
 * tool run, before the SDK formats it. The run is the one that is current in
 * the LangChain async context, so the `on_custom_event` stream event carries
 * the run ID of the tool. It arrives before the `on_tool_end` event of that run.
 */
export const EXECUTE_RESULT_EVENT = "cogniplane.execute_result";

/** Reports the exit code of one command to the tool run that is current. No run, no event. */
export function dispatchExecuteResult(exitCode: number | null): Promise<void> {
  return dispatchCustomEvent(EXECUTE_RESULT_EVENT, { exitCode });
}
