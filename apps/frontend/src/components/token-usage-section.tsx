"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { listAdminUsers } from "../lib/admin-api";
import { fetchTokenUsage } from "../lib/token-usage-api";
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

type View = "day" | "user" | "model";

const VIEW_OPTIONS: Array<{ id: View; label: string }> = [
  { id: "day", label: "Over time" },
  { id: "user", label: "By user" },
  { id: "model", label: "By model" }
];

export function TokenUsageSection() {
  const [view, setView] = useState<View>("day");
  const { days, changeDays, query, report } = useUsageReport(queryKeys.admin.tokenUsage, fetchTokenUsage);
  const users = useQuery({
    queryKey: queryKeys.admin.users(),
    queryFn: listAdminUsers,
    enabled: view === "user"
  });
  const names = new Map((users.data ?? []).map((user) => [user.userId,
    user.displayName && user.email ? `${user.displayName} (${user.email})` : user.displayName || user.email || user.userId
  ]));
  const usage = report?.usage;
  const available = !isRouteNotFoundError(query.error, "GET", "/admin/token-usage");
  const error = query.error
    ? toRouteUnavailableMessage(query.error, { method: "GET", pathPrefix: "/admin/token-usage", featureName: "Token usage reporting", fallback: "Failed to load token usage." })
    : null;

  const totals = usage?.totals;

  return (
    <section id="token-reports" aria-labelledby="token-reports-heading" className="flex flex-col gap-5 pt-5">
      <div>
        <h2 id="token-reports-heading" className="text-lg font-semibold text-on-surface">Token reports</h2>
        <p className="mt-1 text-sm text-on-surface-variant">
          Estimated from recorded messages in the selected period. The period does not change the model budget.
        </p>
      </div>
      {available ? (
        <div className="flex flex-wrap items-center gap-3 pb-1">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-xs text-on-surface-variant">Last</span>
            <DayRangePicker value={days} onChange={changeDays} />
          </div>
          <ViewToggle options={VIEW_OPTIONS} value={view} onChange={setView} />
        </div>
      ) : null}

      <UsageReportStatus days={days} report={report} fetching={query.isFetching} error={error} unavailable={!available} onRetry={() => { void query.refetch(); }} />

      {view === "user" && users.isError ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-on-surface-variant"><p>Names could not be loaded. Showing user IDs where needed.</p><button type="button" className="rounded-sm p-2 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-brand" onClick={() => { void users.refetch(); }}>Retry names</button></div> : null}
      {view === "user" && users.isFetching ? <p role="status" className="text-sm text-on-surface-variant">Loading names. User IDs remain available.</p> : null}
      {view === "user" ? <p className="text-sm text-on-surface-variant">By user shows up to 50 users with the most tokens in this period. Totals and daily and model reports include all recorded usage in the organization.</p> : null}

      {available && !totals && query.isPending ? <TokenUsageSkeleton /> : null}

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

          {view === "user" ? (
            usage.byUser.length === 0 ? (
              <p className={HINT}>No user data in this period.</p>
            ) : (
              <TokenBreakdown
                firstColumnLabel="User"
                rows={usage.byUser.map((u) => ({
                  key: u.userId,
                  label: names.get(u.userId) ?? u.userId,
                  inputTokens: u.inputTokens,
                  outputTokens: u.outputTokens,
                  totalTokens: u.totalTokens,
                  costUsd: u.costUsd
                }))}
                barColor="var(--chart-1)"
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
              />
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
