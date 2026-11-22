// The saved side state of a session, as the query cache gives it to the chat.
import type { SavedSideState } from "../components/agui-transcript";
import { nextReadOrder } from "../lib/agui/read-order";

/** A saved result of a new read. Create it outside the render: each new
 *  object applies again. */
export function savedState(partial: Partial<SavedSideState> = {}): SavedSideState {
  return { toolStatuses: [], mcpApps: {}, notices: [], approvals: [], readOrder: nextReadOrder(), ...partial };
}
