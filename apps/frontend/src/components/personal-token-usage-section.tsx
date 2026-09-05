"use client";

import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { fetchPersonalTokenUsage } from "../lib/settings-api";
import { queryKeys } from "../lib/query-keys";
import {
  BarChart,
  DayRangePicker,
  type Days,
  TokenBreakdown,
  TokenUsageSkeleton,
  TokenUsageSummary,
  ViewToggle
} from "./token-usage-chart-primitives";
import { HINT } from "../lib/ui-tokens";

const STAT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4";

type View = "day" | "model";

const VIEW_OPTIONS: Array<{ id: View; label: string }> = [
  { id: "day", label: "Over time" },
  { id: "model", label: "By model" }
];

export function PersonalTokenUsageSection() {
  const [days, setDays] = useState<Days>(30);
  const [view, setView] = useState<View>("day");
  const query = useQuery({
    queryKey: queryKeys.settings.tokenUsage(days),
    queryFn: () => fetchPersonalTokenUsage(days),
    placeholderData: keepPreviousData
  });
  const usage = query.data;
  const error = query.error instanceof Error ? query.error.message : query.error ? "Failed to load token usage." : null;

  const dailyBars = useMemo(
    () =>
      (usage?.daily ?? []).map((d) => ({
        label: d.date,
        inputSeries: d.inputTokens,
        outputSeries: d.outputTokens
      })),
    [usage]
  );

  const totals = usage?.totals;

  return (
    <section id="usage" className="flex flex-col gap-5 pt-5">
      <div className="flex flex-wrap items-center gap-3 pb-1">
        <DayRangePicker value={days} onChange={setDays} />
        <ViewToggle options={VIEW_OPTIONS} value={view} onChange={setView} />
        {query.isFetching ? <span className="text-xs text-on-surface-faint">Loading…</span> : null}
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {!totals && query.isPending ? <TokenUsageSkeleton /> : null}

      {totals ? (
        <TokenUsageSummary totals={totals} days={days} />
      ) : null}

      {usage && !query.isFetching ? (
        <div className={`${STAT_CARD} overflow-hidden p-5`}>
          {view === "day" ? (
            dailyBars.length === 0 ? (
              <p className={HINT}>No token data recorded in this period.</p>
            ) : (
              <BarChart
                data={dailyBars}
                primaryColor="var(--color-accent)"
                secondaryColor="var(--color-success)"
                primaryLabel="Input tokens"
                secondaryLabel="Output tokens"
              />
            )
          ) : null}

          {view === "model" ? (
            usage.byModel.length === 0 ? (
              <p className={HINT}>No model data in this period.</p>
            ) : (
              <TokenBreakdown
                rows={usage.byModel.map((m) => ({
                  key: m.modelName,
                  label: m.modelName,
                  inputTokens: m.inputTokens,
                  outputTokens: m.outputTokens,
                  totalTokens: m.totalTokens,
                  costUsd: m.costUsd
                }))}
                barColor="var(--color-warning)"
                chartPrimaryColor="var(--color-warning)"
                chartSecondaryColor="var(--color-success)"
                firstColumnLabel="Model"
              />
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
