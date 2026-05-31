"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";

import { fetchMessageFeedback, type MessageFeedbackStats } from "../lib/message-feedback-api";
import { isRouteNotFoundError, toRouteUnavailableMessage } from "../lib/error-utils";
import { DayRangePicker, type Days } from "./token-usage-chart-primitives";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const STAT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4";
const HINT = "text-sm text-on-surface-faint";

export function MessageFeedbackSection() {
  const [days, setDays] = useState<Days>(30);
  const [stats, setStats] = useState<MessageFeedbackStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  const load = useCallback(async (d: Days) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMessageFeedback(d);
      setAvailable(true);
      setStats(data);
    } catch (e) {
      setAvailable(!isRouteNotFoundError(e, "GET", "/admin/message-feedback"));
      setStats(null);
      setError(
        toRouteUnavailableMessage(e, {
          method: "GET",
          pathPrefix: "/admin/message-feedback",
          featureName: "Message feedback reporting",
          fallback: "Failed to load feedback data."
        })
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // load() flips setLoading before awaiting; the cascading render is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(days);
  }, [days, load]);

  const totals = stats?.totals;

  return (
    <section id="message-feedback" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Observability</p>
        <h3 className="text-lg font-semibold text-on-surface">Message feedback</h3>
      </div>

      {available ? (
        <div className="flex flex-wrap items-center gap-3 pt-2 pb-1">
          <DayRangePicker value={days} onChange={setDays} />
          {loading ? <span className="text-xs text-on-surface-faint">Loading…</span> : null}
        </div>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {available && totals ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              label="Positive rate"
              value={totals.ratePercent != null ? `${totals.ratePercent}%` : "—"}
              detail={`${totals.total} rated responses`}
            />
            <StatCard
              label="Thumbs up"
              value={String(totals.thumbsUp)}
              detail="Positive feedback"
            />
            <StatCard
              label="Thumbs down"
              value={String(totals.thumbsDown)}
              detail="Negative feedback"
            />
          </div>

          {totals.total > 0 ? (
            <div className={`${STAT_CARD} p-5`}>
              <p className={`${SECTION_LABEL} mb-2`}>Positive rate</p>
              <div className="h-3 overflow-hidden rounded-full bg-surface-container">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-300"
                  style={{ width: `${totals.ratePercent}%` }}
                />
              </div>
            </div>
          ) : null}

          {stats && stats.daily.length > 0 ? (
            <div className={`${STAT_CARD} overflow-auto p-5`}>
              <p className={`${SECTION_LABEL} mb-3`}>Daily breakdown</p>
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

          {stats && stats.byModel.length > 0 ? (
            <div className={`${STAT_CARD} overflow-auto p-5`}>
              <p className={`${SECTION_LABEL} mb-3`}>By model</p>
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

      {available && !loading && !error && totals?.total === 0 ? (
        <p className={HINT}>No feedback recorded in this period.</p>
      ) : null}
    </section>
  );
}

function StatCard(props: { label: string; value: string; detail: string }) {
  return (
    <article className={STAT_CARD}>
      <p className={SECTION_LABEL}>{props.label}</p>
      <strong className="mt-2 block text-2xl font-bold tracking-tight text-on-surface tabular-nums">
        {props.value}
      </strong>
      <p className="mt-1 text-xs text-on-surface-variant">{props.detail}</p>
    </article>
  );
}

type FeedbackRow = {
  key: string;
  label: string;
  thumbsUp: number;
  thumbsDown: number;
  rate: number | null;
};

function FeedbackTable(props: { rows: FeedbackRow[]; firstColLabel: string }) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo<ColumnDef<FeedbackRow>[]>(
    () => [
      {
        accessorKey: "label",
        header: props.firstColLabel,
        cell: (ctx) => ctx.getValue<string>()
      },
      {
        accessorKey: "thumbsUp",
        header: "Up",
        cell: (ctx) => <span className="text-accent">{ctx.getValue<number>()}</span>
      },
      {
        accessorKey: "thumbsDown",
        header: "Down",
        cell: (ctx) => <span className="text-danger">{ctx.getValue<number>()}</span>
      },
      {
        accessorKey: "rate",
        header: "Rate",
        // null rates sort last regardless of direction.
        sortUndefined: "last",
        cell: (ctx) => {
          const v = ctx.getValue<number | null>();
          return v != null ? `${v}%` : "—";
        }
      }
    ],
    [props.firstColLabel]
  );

  // TanStack Table returns functions React Compiler can't memoize, so it skips
  // compiling this component. That's expected and harmless here — the table is
  // small and re-renders are cheap. Silence the known-incompatibility warning.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: props.rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (row) => row.key,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id} className="text-left text-on-surface-faint">
            {hg.headers.map((header) => {
              const sorted = header.column.getIsSorted();
              return (
                <th key={header.id} className="pr-3 pb-1 font-medium">
                  <button
                    type="button"
                    onClick={header.column.getToggleSortingHandler()}
                    className="inline-flex items-center gap-1 hover:text-on-surface"
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {sorted === "asc" ? (
                      <ChevronUp className="size-3" aria-hidden="true" />
                    ) : sorted === "desc" ? (
                      <ChevronDown className="size-3" aria-hidden="true" />
                    ) : (
                      <ChevronsUpDown className="size-3 opacity-40" aria-hidden="true" />
                    )}
                  </button>
                </th>
              );
            })}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id} className="border-t border-outline-variant">
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id} className="pr-3 py-1.5">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
