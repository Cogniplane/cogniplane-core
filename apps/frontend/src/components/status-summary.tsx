"use client";
// StatusSummary: an application component of the chat's generative UI catalog.
// A read-only list of phases or items. Each row shows a label, a status from a
// fixed list as text with an icon and a semantic color, an optional detail
// line, and optional counts. The status is the model's data: the component
// colors it by its name and never reads success or failure from other text. A
// row without a status says so. The component computes no count and no
// percentage. A progress bar shows only when the model gave counts with a
// total above zero, and it uses the native <progress> element. It has no
// events, links, inputs or state of the user.
//
// The SDK stylesheet resets the margins of p, table, figcaption and headings
// with a rule that beats utility classes (see LEARNINGS), so the spacing here
// comes from padding and gaps, and the font size of the heading is forced.

import type { StatusSummaryProps, StatusSummaryStatus } from "@cogniplane/shared-types";
import { CircleCheckIcon, CircleDashedIcon, CircleHelpIcon, CircleIcon, OctagonXIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react";
import { useId } from "react";

import { cleanLine } from "./checklist-card.logic";
import { countLabel, EMPTY_LABEL, readCounts, statusHeading, statusLabel } from "./status-summary.logic";

const CHIP = "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold";
const NEUTRAL = "bg-surface-container text-on-surface-variant";

// Green, amber, red and blue only mean a state. The icon and the text carry the
// state too, so color is never the only cue.
const STATUS_STYLE: Record<StatusSummaryStatus, { Icon: LucideIcon; tone: string }> = {
  complete: { Icon: CircleCheckIcon, tone: "bg-success-surface text-success" },
  "in-progress": { Icon: CircleDashedIcon, tone: "bg-info-surface text-info" },
  "at-risk": { Icon: TriangleAlertIcon, tone: "bg-warning-surface text-warning" },
  blocked: { Icon: OctagonXIcon, tone: "bg-danger-surface text-danger" },
  "not-started": { Icon: CircleIcon, tone: NEUTRAL }
};
const NOT_REPORTED_STYLE = { Icon: CircleHelpIcon, tone: NEUTRAL };

function StatusChip({ status }: { status: StatusSummaryStatus | undefined }) {
  const { Icon, tone } = status ? STATUS_STYLE[status] : NOT_REPORTED_STYLE;
  return (
    // The tints are translucent. On a clear surface the text of Complete keeps
    // 4.7:1 or more. On the panel it measured 4.2, under the 4.5 of WCAG AA.
    <span className="inline-flex shrink-0 rounded bg-surface-container-lowest">
      <span className={`${CHIP} ${tone}`}>
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="sr-only">Status: </span>
        {statusLabel(status)}
      </span>
    </span>
  );
}

/** The native progress element. Its name is the label of its owner, and its
 *  value text is the plain count, so a screen reader does not announce a
 *  percentage that the model never gave. */
function CountBar({ completed, total, labelledBy }: { completed: number; total: number; labelledBy: string }) {
  return (
    <progress
      value={completed}
      max={total}
      aria-labelledby={labelledBy}
      aria-valuetext={countLabel(completed, total)}
      className="block h-1.5 w-full appearance-none overflow-hidden rounded-full border-0 bg-surface-container [&::-moz-progress-bar]:bg-brand [&::-webkit-progress-bar]:bg-surface-container [&::-webkit-progress-value]:bg-brand"
    />
  );
}

export function GenerativeStatusSummary({ title, completed, total, items }: StatusSummaryProps) {
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const overall = readCounts({ completed, total });

  return (
    <section aria-labelledby={headingId} className="my-1 w-full max-w-xl text-sm text-on-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id={headingId} className="m-0 min-w-0 text-sm! font-semibold [overflow-wrap:anywhere]">{statusHeading(title)}</h3>
        {overall ? <p className="m-0 text-xs tabular-nums text-on-surface-variant">{countLabel(overall.completed, overall.total)}</p> : null}
      </div>
      {overall && overall.total > 0 ? (
        <div className="pt-2"><CountBar completed={overall.completed} total={overall.total} labelledBy={headingId} /></div>
      ) : null}

      {items.length === 0 ? (
        <div className="pt-2"><p className="m-0 rounded-md bg-surface-container px-3 py-2 text-xs text-on-surface-variant">{EMPTY_LABEL}</p></div>
      ) : (
        <ul className="m-0 mt-2 list-none divide-y divide-outline-variant p-0">
          {items.map((item) => {
            const labelId = `${baseId}-${item.id}-label`;
            const rowCounts = readCounts(item);
            const detail = item.detail ? cleanLine(item.detail) : "";
            return (
              <li key={item.id} className="flex flex-col gap-1 py-2">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span id={labelId} className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{cleanLine(item.label)}</span>
                  <StatusChip status={item.status} />
                </div>
                {detail ? <p className="m-0 text-xs text-on-surface-variant [overflow-wrap:anywhere]">{detail}</p> : null}
                {rowCounts ? (
                  <div className="flex items-center gap-3">
                    {rowCounts.total > 0 ? (
                      <div className="min-w-0 flex-1"><CountBar completed={rowCounts.completed} total={rowCounts.total} labelledBy={labelId} /></div>
                    ) : null}
                    <p className="m-0 shrink-0 text-xs tabular-nums text-on-surface-variant">{countLabel(rowCounts.completed, rowCounts.total)}</p>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
