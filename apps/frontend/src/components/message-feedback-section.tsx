"use client";

import { useId, useMemo, useState } from "react";
import {
  type ColumnDef,
  type SortingState,
  createSortedRowModel,
  flexRender,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, ChevronsUpDown, Loader2 } from "lucide-react";

import { fetchMessageFeedback } from "../lib/message-feedback-api";
import { isRouteNotFoundError, toRouteUnavailableMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import { DayRangePicker, ViewToggle } from "./token-usage-chart-primitives";
import { ReportStatCard } from "./token-usage-chart-primitives";
import { HINT } from "../lib/ui-tokens";
import { Button } from "./ui/button";
import { useUsageReport } from "./use-usage-report";

const STAT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4";

export function MessageFeedbackSection() {
  const [view, setView] = useState<"day" | "model">("day");
  const { days, changeDays, query, report } = useUsageReport(queryKeys.admin.messageFeedback, fetchMessageFeedback);
  const errorId = useId();
  const stats = report?.usage;
  const available = !isRouteNotFoundError(query.error, "GET", "/admin/message-feedback");
  const error = query.error
    ? toRouteUnavailableMessage(query.error, { method: "GET", pathPrefix: "/admin/message-feedback", featureName: "Message feedback reporting", fallback: "Failed to load feedback data." })
    : null;

  const totals = stats?.totals;

  return (
    <section aria-label="Message feedback report" id="message-feedback" className="flex min-w-0 flex-col gap-5 pt-5">
      {available ? (
        <div className="flex flex-wrap items-center gap-3 pt-2 pb-1">
          <DayRangePicker value={days} onChange={changeDays} />
          <ViewToggle options={[{ id: "day", label: "Over time" }, { id: "model", label: "By model" }]} value={view} onChange={setView} />
        </div>
      ) : null}

      <div className="space-y-2 text-sm">
        <Button type="button" variant="outline" className="relative w-44" aria-disabled={query.isFetching} aria-busy={query.isFetching} aria-describedby={error ? errorId : undefined} onClick={() => { if (!query.isFetching) void query.refetch({ cancelRefetch: false }); }}>
          {query.isFetching ? <Loader2 aria-hidden="true" className="absolute left-2 size-4 animate-spin motion-reduce:animate-none" /> : null}
          Reload feedback
        </Button>
        <p role="status" className="text-on-surface-variant">
          {query.isFetching
            ? report ? `Loading the last ${days} days. Showing the previous ${report.days}-day report until the read succeeds.` : `Loading feedback for the last ${days} days.`
            : report ? `Showing the last ${report.days} days. Loaded ${report.loadedAt.replace("T", " ").slice(0, 19)} UTC.` : null}
        </p>
        {error ? <p id={errorId} role="alert" className="max-w-prose text-danger">{error}{report ? ` The last ${days} days could not be loaded. The ${report.days}-day report below has not been updated.` : ""}</p> : null}
        <p className="max-w-prose text-on-surface-variant">Includes rated responses only. The period uses when feedback was given. Daily totals use UTC.</p>
      </div>

      {totals ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <ReportStatCard
              label="Positive rate"
              value={totals.ratePercent != null ? `${totals.ratePercent}%` : "—"}
              detail={`${totals.total} rated ${totals.total === 1 ? "response" : "responses"}`}
            />
            <ReportStatCard
              label="Thumbs up"
              value={String(totals.thumbsUp)}
              detail="Positive feedback"
            />
            <ReportStatCard
              label="Thumbs down"
              value={String(totals.thumbsDown)}
              detail="Negative feedback"
            />
          </div>

          {view === "day" && stats && stats.daily.length > 0 ? (
            <div className={`${STAT_CARD} min-w-0 p-4 sm:p-5`}>
              <h2 className="mb-3 font-heading text-base font-semibold">Daily breakdown</h2>
              <FeedbackTable
                rows={stats.daily.map((row) => ({
                  key: row.date,
                  label: row.date,
                  thumbsUp: row.thumbsUp,
                  thumbsDown: row.thumbsDown,
                  rate:
                    row.thumbsUp + row.thumbsDown > 0
                      ? Math.round((row.thumbsUp / (row.thumbsUp + row.thumbsDown)) * 100)
                      : null
                }))}
                firstColLabel="Date"
              />
            </div>
          ) : null}

          {view === "model" && stats && stats.byModel.length > 0 ? (
            <div className={`${STAT_CARD} min-w-0 p-4 sm:p-5`}>
              <h2 className="mb-3 font-heading text-base font-semibold">By model</h2>
              <FeedbackTable
                rows={stats.byModel.map((row) => ({
                  key: row.modelName,
                  label: row.modelName,
                  thumbsUp: row.thumbsUp,
                  thumbsDown: row.thumbsDown,
                  rate: row.ratePercent
                }))}
                firstColLabel="Model"
              />
            </div>
          ) : null}
        </>
      ) : null}

      {report && totals?.total === 0 ? (
        <p className={HINT}>No feedback recorded in the displayed {report.days}-day report.</p>
      ) : null}
    </section>
  );
}

type FeedbackRow = {
  key: string;
  label: string;
  thumbsUp: number;
  thumbsDown: number;
  rate: number | null;
};

// The label column uses the default "auto" sort. In v9 "auto" picks only registered
// functions: alphanumeric for dates and names with digits, text for other strings.
// Number columns use the built-in basic comparator, which needs no registration.
const feedbackTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text }
});

function FeedbackTable(props: { rows: FeedbackRow[]; firstColLabel: string }) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo<ColumnDef<typeof feedbackTableFeatures, FeedbackRow>[]>(
    () => [
      {
        accessorKey: "label",
        header: props.firstColLabel,
        cell: (ctx) => ctx.getValue<string>()
      },
      {
        accessorKey: "thumbsUp",
        header: "Up",
        cell: (ctx) => <span className="text-success">{ctx.getValue<number>()}</span>
      },
      {
        accessorKey: "thumbsDown",
        header: "Down",
        cell: (ctx) => <span className="text-danger">{ctx.getValue<number>()}</span>
      },
      {
        id: "rate",
        accessorFn: (row) => row.rate ?? undefined,
        header: "Rate",
        // null rates sort last regardless of direction.
        sortUndefined: "last",
        sortDescFirst: true,
        cell: (ctx) => {
          const v = ctx.getValue<number | undefined>();
          return v != null ? `${v}%` : "—";
        }
      }
    ],
    [props.firstColLabel]
  );

  const table = useTable({
    features: feedbackTableFeatures,
    data: props.rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (row) => row.key
  });

  return (
    <table className="w-full table-fixed border-collapse text-sm tabular-nums">
      <caption className="sr-only">Feedback by {props.firstColLabel.toLowerCase()}. Rate is the percentage of rated responses that are positive.</caption>
      <colgroup><col className="w-[34%]" /><col className="w-[22%]" /><col className="w-[22%]" /><col className="w-[22%]" /></colgroup>
      <thead>
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id} className="text-left text-on-surface-faint">
            {hg.headers.map((header) => {
              const sorted = header.column.getIsSorted();
              return (
                <th key={header.id} scope="col" aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"} className="p-1 text-left font-medium">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`${String(header.column.columnDef.header)}${sorted ? `, sorted ${sorted === "asc" ? "ascending" : "descending"}` : ", not sorted"}`}
                    onClick={header.column.getToggleSortingHandler()}
                    className="max-w-full gap-0.5 px-0 text-on-surface-variant has-[>svg]:px-0"
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {sorted === "asc" ? (
                      <ChevronUp className="size-2.5" aria-hidden="true" />
                    ) : sorted === "desc" ? (
                      <ChevronDown className="size-2.5" aria-hidden="true" />
                    ) : (
                      <ChevronsUpDown className="size-2.5 opacity-40" aria-hidden="true" />
                    )}
                  </Button>
                </th>
              );
            })}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id} className="border-t border-outline-variant">
            {row.getAllCells().map((cell) => (
              <td key={cell.id} className="p-1 py-2 align-top [overflow-wrap:anywhere]">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
