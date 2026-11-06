// Pure rules of the StatusSummary component of generated UI
// (status-summary.tsx). The props schema (StatusSummaryPropsSchema) has already
// checked the statuses and the counts, so these functions only read them. They
// compute no count and no percentage.

import type { StatusSummaryStatus } from "@cogniplane/shared-types";

import { cleanLine } from "./checklist-card.logic";

/** The heading when the model sets no title. */
export const DEFAULT_HEADING = "Status summary";

/** What a row says when the model gave it no status. */
export const NOT_REPORTED_LABEL = "Status not reported";

/** The text of each status. The browser never reads a status from other text. */
export const STATUS_LABELS: Record<StatusSummaryStatus, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  "at-risk": "At risk",
  blocked: "Blocked",
  complete: "Complete"
};

export function statusLabel(status: StatusSummaryStatus | undefined): string {
  return status ? STATUS_LABELS[status] : NOT_REPORTED_LABEL;
}

export function statusHeading(title: string | undefined): string {
  return (title ? cleanLine(title) : "") || DEFAULT_HEADING;
}

/** "3 of 8 completed". */
export function countLabel(completed: number, total: number): string {
  return `${completed.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} completed`;
}

export type Counts = { completed: number; total: number };

/** The counts of a view or a row, or null when the model gave none. The
 *  schema has made them a pair. */
export function readCounts(value: { completed?: number; total?: number }): Counts | null {
  return value.completed !== undefined && value.total !== undefined
    ? { completed: value.completed, total: value.total }
    : null;
}

export const EMPTY_LABEL = "No status items to show.";
