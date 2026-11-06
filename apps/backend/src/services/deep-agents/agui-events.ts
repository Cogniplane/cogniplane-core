import { EventType, type BaseEvent } from "@ag-ui/client";

import { TurnStopReasonSchema, type CogniplaneCustomEvent, type CustomEventValue, type TurnStopReason } from "@cogniplane/shared-types";

/** `reason`: why the backend stopped the turn, when the user did not. */
export type AGUIInterruptedResult = { interrupted: true; reason?: TurnStopReason };

export const AGUI_INTERRUPTED_RESULT: AGUIInterruptedResult = { interrupted: true };

export function interruptedResult(reason?: TurnStopReason): AGUIInterruptedResult {
  return reason ? { interrupted: true, reason } : AGUI_INTERRUPTED_RESULT;
}

export function isAGUIInterruptedFinish(event: BaseEvent): boolean {
  if (event.type !== EventType.RUN_FINISHED) return false;
  const result = (event as { result?: { interrupted?: boolean } }).result;
  return result?.interrupted === true;
}

/** The stop reason of an interrupted RUN_FINISHED, if it has a known one. */
export function interruptedFinishReason(event: BaseEvent): TurnStopReason | undefined {
  if (!isAGUIInterruptedFinish(event)) return undefined;
  const parsed = TurnStopReasonSchema.safeParse((event as { result?: { reason?: unknown } }).result?.reason);
  return parsed.success ? parsed.data : undefined;
}

/** A turn-abort reason (AbortSignal.reason) that is a stop reason, or undefined. */
export function turnStopReasonOf(value: unknown): TurnStopReason | undefined {
  const parsed = TurnStopReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function approvalRequiredEvent(input: CustomEventValue<"approval_required">): BaseEvent {
  return customEvent("approval_required", input);
}

export function runtimeNoticeEvent(input: CustomEventValue<"runtime_notice">): BaseEvent {
  return customEvent("runtime_notice", input);
}

export function customEvent<Name extends CogniplaneCustomEvent["name"]>(
  name: Name,
  value: CustomEventValue<Name>
): BaseEvent & { name: Name; value: CustomEventValue<Name> } {
  return { type: EventType.CUSTOM, name, value };
}
