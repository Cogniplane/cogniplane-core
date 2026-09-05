"use client";

import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { fetchTokenUsage } from "../lib/token-usage-api";
import { isRouteNotFoundError, toRouteUnavailableMessage } from "../lib/error-utils";
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

function shortUserId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

type View = "day" | "user" | "model";

const VIEW_OPTIONS: Array<{ id: View; label: string }> = [
  { id: "day", label: "Over time" },
  { id: "user", label: "By user" },
  { id: "model", label: "By model" }
];

export function TokenUsageSection() {
  const [days, setDays] = useState<Days>(30);
  const [view, setView] = useState<View>("day");
  const query = useQuery({
    queryKey: queryKeys.admin.tokenUsage(days),
    queryFn: () => fetchTokenUsage(days),
    placeholderData: keepPreviousData
  });
  const usage = query.data;
  const available = !isRouteNotFoundError(query.error, "GET", "/admin/token-usage");
  const error = query.error
    ? toRouteUnavailableMessage(query.error, { method: "GET", pathPrefix: "/admin/token-usage", featureName: "Token usage reporting", fallback: "Failed to load token usage." })
    : null;

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
    <section id="token-usage" className="flex flex-col gap-5 pt-5">
      {available ? (
        <div className="flex flex-wrap items-center gap-3 pt-2 pb-1">
          <DayRangePicker value={days} onChange={setDays} />
          <ViewToggle options={VIEW_OPTIONS} value={view} onChange={setView} />
          {query.isFetching ? <span className="text-xs text-on-surface-faint">Loading…</span> : null}
        </div>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {available && !totals && query.isPending ? <TokenUsageSkeleton /> : null}

      {available && totals ? (
        <TokenUsageSummary totals={totals} days={days} />
      ) : null}

      {available && usage && !query.isFetching ? (
        <div className={`${STAT_CARD} overflow-hidden p-5`}>
          {view === "day" ? (
            dailyBars.length === 0 ? (
              <p className={HINT}>No token data recorded in this period.</p>
            ) : (
              <BarChart
                data={dailyBars}
                primaryColor="var(--chart-1)"
                secondaryColor="var(--chart-2)"
                primaryLabel="Input tokens"
                secondaryLabel="Output tokens"
              />
            )
          ) : null}

          {view === "user" ? (
            usage.byUser.length === 0 ? (
              <p className={HINT}>No user data in this period.</p>
            ) : (
              <TokenBreakdown
                firstColumnLabel="User"
                rows={usage.byUser.map((u) => ({
                  key: u.userId,
                  label: shortUserId(u.userId),
                  inputTokens: u.inputTokens,
                  outputTokens: u.outputTokens,
                  totalTokens: u.totalTokens,
                  costUsd: u.costUsd
                }))}
                barColor="var(--chart-1)"
                chartPrimaryColor="var(--chart-1)"
                chartSecondaryColor="var(--chart-2)"
              />
            )
          ) : null}

          {view === "model" ? (
            usage.byModel.length === 0 ? (
              <p className={HINT}>No model data in this period.</p>
            ) : (
              <TokenBreakdown
                firstColumnLabel="Model"
                rows={usage.byModel.map((m) => ({
                  key: m.modelName,
                  label: m.modelName,
                  inputTokens: m.inputTokens,
                  outputTokens: m.outputTokens,
                  totalTokens: m.totalTokens,
                  costUsd: m.costUsd
                }))}
                barColor="var(--chart-3)"
                chartPrimaryColor="var(--chart-3)"
                chartSecondaryColor="var(--chart-2)"
              />
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
