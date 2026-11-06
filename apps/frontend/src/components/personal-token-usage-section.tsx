"use client";

import { useState } from "react";

import { fetchPersonalTokenUsage } from "../lib/settings-api";
import { isRouteNotFoundError, toRouteUnavailableMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import {
  DailyTokenUsage,
  UsageReportStatus,
  DayRangePicker,
  TokenBreakdown,
  TokenUsageSkeleton,
  TokenUsageSummary,
  ViewToggle
} from "./token-usage-chart-primitives";
import { useUsageReport } from "./use-usage-report";
import { HINT } from "../lib/ui-tokens";

const STAT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4";

type View = "day" | "model";

const VIEW_OPTIONS: Array<{ id: View; label: string }> = [
  { id: "day", label: "Over time" },
  { id: "model", label: "By model" }
];

export function PersonalTokenUsageSection() {
  const [view, setView] = useState<View>("day");
  const { days, changeDays, query, report } = useUsageReport(queryKeys.settings.tokenUsage, fetchPersonalTokenUsage);
  const usage = report?.usage;
  const available = !isRouteNotFoundError(query.error, "GET", "/me/token-usage");
  const error = query.error ? toRouteUnavailableMessage(query.error, { method: "GET", pathPrefix: "/me/token-usage", featureName: "Personal usage reporting", fallback: "Failed to load token usage." }) : null;

  const totals = usage?.totals;

  return (
    <section aria-label="Personal token usage" id="usage" className="flex flex-col gap-5 pt-5">
      <div className="flex flex-wrap items-center gap-3 pb-1">
        <DayRangePicker value={days} onChange={changeDays} />
        <ViewToggle options={VIEW_OPTIONS} value={view} onChange={setView} />
      </div>

      <UsageReportStatus days={days} report={report} fetching={query.isFetching} error={error} unavailable={!available} onRetry={() => { void query.refetch(); }} />

      {!totals && query.isPending ? <TokenUsageSkeleton /> : null}

      {totals && report ? (
        <TokenUsageSummary totals={totals} days={report.days} />
      ) : null}

      {usage ? (
        <div className={`${STAT_CARD} min-w-0 p-4 sm:p-5`}>
          {view === "day" ? (
            usage.daily.length === 0 ? (
              <p className={HINT}>No token data recorded in this period.</p>
            ) : (
              <DailyTokenUsage daily={usage.daily} />
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
                barColor="var(--chart-3)"
                firstColumnLabel="Model"
              />
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
