"use client";
// ComparisonTable: an application component of the chat's generative UI
// catalog. A read-only table: the model names the compared items (columns) and
// the criteria (rows) and gives each cell a value. The component shows exactly
// those values. It ranks nothing, marks no best cell, and shows "No data" for
// a cell that has no value. It has no events, links, inputs or state of the
// user, so the model cannot make it do anything.
//
// Layout. The table scrolls sideways inside its own region, so a wide table
// never widens the page. The region takes the keyboard focus, so a keyboard
// user can scroll it, and the caption and the criteria column stay in view. A
// note names the scroll when the table is wider than the space. Text wraps
// inside a bounded cell, so a long value makes a taller row and never a wider
// table.
//
// Two stylesheets beat utility classes here, because neither sits in a cascade
// layer. The SDK resets the margins of p, table, figcaption and
// headings, so the spacing here comes from padding and gaps. The markdown rules
// of globals.css style every table in the chat and the panel, so the table
// carries data-app-table, which those rules skip.

import type { ComparisonTableProps } from "@cogniplane/shared-types";
import { useEffect, useId, useRef, useState } from "react";

import { cleanLine } from "./checklist-card.logic";
import { cellDisplay, comparisonCaption, NO_DATA_LABEL } from "./comparison-table.logic";

/** Whether the content of an element is wider than the element. A resize of
 *  the element or its table measures again, as a streamed update changes both. */
function useHorizontalOverflow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    // The observer reports once when it starts to observe, so this also
    // measures the first layout.
    const observer = new ResizeObserver(() => setOverflows(element.scrollWidth > element.clientWidth + 1));
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return { ref, overflows };
}

// Opaque, so a sticky cell hides what scrolls under it.
const HEAD_CELL = "border-b border-outline-variant bg-surface-container px-3 py-2 text-left align-bottom font-semibold text-on-surface";
const STICKY = "sticky left-0 z-10 border-r border-outline-variant";
const WRAP = "[overflow-wrap:anywhere]";

export function GenerativeComparisonTable({ title, columns, rows }: ComparisonTableProps) {
  const captionId = useId();
  const { ref, overflows } = useHorizontalOverflow<HTMLDivElement>();

  return (
    <div className="my-1 flex w-full min-w-0 max-w-full flex-col gap-1.5 text-sm text-on-surface">
      {/* A region that scrolls must take focus, or a keyboard cannot reach what is off screen. */}
      <div
        ref={ref}
        role="region"
        aria-labelledby={captionId}
        tabIndex={0}
        className="@container max-w-full overflow-x-auto rounded-md border border-outline-variant bg-surface-container-lowest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <table data-app-table="" className="w-max min-w-full border-separate border-spacing-0 text-left">
          <caption id={captionId} className="border-b border-outline-variant p-0 text-left text-sm font-semibold text-on-surface">
            {/* The caption is as wide as the table. Its text stays at the left edge of the region, and wraps in the width that shows. */}
            <div className={`sticky left-0 box-border w-fit max-w-[100cqw] px-3 py-2 ${WRAP}`}>{comparisonCaption(title)}</div>
          </caption>
          <thead>
            <tr>
              <th scope="col" className={`${HEAD_CELL} ${STICKY} text-xs font-medium text-on-surface-variant`}>
                Criteria
              </th>
              {columns.map((column) => (
                <th key={column.id} scope="col" className={HEAD_CELL}>
                  <div className={`min-w-28 max-w-64 ${WRAP}`}>{cleanLine(column.label)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="[&>tr:last-child>*]:border-b-0">
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row" className={`${STICKY} border-b bg-surface-container-lowest px-3 py-2 text-left align-top font-medium`}>
                  <div className={`min-w-24 max-w-40 ${WRAP}`}>{cleanLine(row.label)}</div>
                </th>
                {columns.map((column) => {
                  const cell = cellDisplay(row.cells, column.id);
                  return (
                    <td key={column.id} className="border-b border-outline-variant px-3 py-2 align-top">
                      <div className={`min-w-28 max-w-64 tabular-nums ${WRAP}`}>
                        {cell.kind === "value" ? cell.text : <span className="text-on-surface-variant">{NO_DATA_LABEL}</span>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {overflows ? <p className="m-0 text-xs text-on-surface-variant">Scroll sideways to see all columns.</p> : null}
    </div>
  );
}
