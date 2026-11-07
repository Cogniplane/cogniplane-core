// The outcome to show or export for a saved tool call (issues #16 and #17).
//
// A call that never returned keeps the stored status `in_progress`: no tool
// reported a result, so the store keeps that evidence as it is. Once its parent
// message has ended (completed, error, or interrupted), nothing runs it any more,
// and a reader must not see it as running. Its outcome is then `interrupted`: the
// action can be done, partly done, or not started. A call in a turn that still
// runs (pending or streaming), or whose parent message is unknown, keeps its
// stored status. A status that a tool reported (completed, failed, declined) is
// never changed.

/** Message statuses of a turn that still runs. */
const RUNNING_MESSAGE_STATUSES: ReadonlySet<string> = new Set(["pending", "streaming"]);

/** The tool status to show or export, from the stored status and the status of its parent message. */
export function displayedToolStatus(toolStatus: string, parentMessageStatus: string | null | undefined): string {
  if (toolStatus !== "in_progress") return toolStatus;
  if (parentMessageStatus == null || RUNNING_MESSAGE_STATUSES.has(parentMessageStatus)) return toolStatus;
  return "interrupted";
}
