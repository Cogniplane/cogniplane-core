// A call that never returned keeps the stored status `in_progress` as evidence.
// Once its message has ended, nothing runs it, so readers show it as
// `interrupted`: its action can be done, partly done, or not started.

const RUNNING_MESSAGE_STATUSES: ReadonlySet<string> = new Set(["pending", "streaming"]);

export function displayedToolStatus(toolStatus: string, parentMessageStatus: string | null | undefined): string {
  if (toolStatus !== "in_progress") return toolStatus;
  if (parentMessageStatus == null || RUNNING_MESSAGE_STATUSES.has(parentMessageStatus)) return toolStatus;
  return "interrupted";
}
