import { EventType, type BaseEvent } from "@ag-ui/client";

import type { CogniplaneCustomEvent, CustomEventValue } from "@cogniplane/shared-types";

export type AGUIInterruptedResult = { interrupted: true };

export const AGUI_INTERRUPTED_RESULT: AGUIInterruptedResult = { interrupted: true };

export function isAGUIInterruptedFinish(event: BaseEvent): boolean {
  if (event.type !== EventType.RUN_FINISHED) return false;
  const result = (event as { result?: { interrupted?: boolean } }).result;
  return result?.interrupted === true;
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
