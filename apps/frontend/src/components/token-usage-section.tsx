"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchTokenUsage, type TokenUsageSeries } from "../lib/token-usage-api";
import { isRouteNotFoundError, toRouteUnavailableMessage } from "../lib/error-utils";
import {
  BarChart,
  DayRangePicker,
  fmtCost,
  fmtTokens,
  HBar,
  type Days,
  ViewToggle
} from "./token-usage-chart-primitives";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const STAT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4";
const HINT = "text-sm text-on-surface-faint";

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
  const [usage, setUsage] = useState<TokenUsageSeries | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  const load = useCallback(async (d: Days) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchTokenUsage(d);
      setAvailable(true);
      setUsage(data);
    } catch (e) {
      setAvailable(!isRouteNotFoundError(e, "GET", "/admin/token-usage"));
      setUsage(null);
      setError(
        toRouteUnavailableMessage(e, {
          method: "GET",
          pathPrefix: "/admin/token-usage",
          featureName: "Token usage reporting",
          fallback: "Failed to load token usage."
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

  const dailyBars = useMemo(
    () =>
      (usage?.daily ?? []).map((d) => ({
        label: d.date,
        primary: d.inputTokens,
        secondary: d.outputTokens
      })),
    [usage]
  );

  const userBars = useMemo(
    () =>
      (usage?.byUser ?? []).map((u) => ({
        label: shortUserId(u.userId),
        primary: u.inputTokens,
        secondary: u.outputTokens
      })),
    [usage]
  );

  const modelBars = useMemo(
    () =>
      (usage?.byModel ?? []).map((m) => ({
        label: m.modelName,
        primary: m.inputTokens,
        secondary: m.outputTokens
      })),
    [usage]
  );

  const totals = usage?.totals;

  return (
    <section id="token-usage" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Observability</p>
        <h3 className="text-lg font-semibold text-on-surface">Token usage</h3>
      </div>

      {available ? (
        <div className="flex flex-wrap items-center gap-3 pt-2 pb-1">
          <DayRangePicker value={days} onChange={setDays} />
          <ViewToggle options={VIEW_OPTIONS} value={view} onChange={setView} />
          {loading ? <span className="text-xs text-on-surface-faint">Loading…</span> : null}
        </div>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {available && totals ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Total tokens"
            value={fmtTokens(totals.totalTokens)}
            detail={`In the last ${days} days`}
          />
          <StatCard
            label="Input tokens"
            value={fmtTokens(totals.inputTokens)}
            detail="Prompt + context"
          />
          <StatCard
            label="Output tokens"
            value={fmtTokens(totals.outputTokens)}
            detail="Generated text"
          />
          <StatCard
            label="Est. cost"
            value={fmtCost(totals.costUsd)}
            detail={`${totals.messageCount} messages`}
          />
        </div>
      ) : null}

      {available && usage && !loading ? (
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
              <BreakdownTable
                rows={usage.byUser.map((u) => ({
                  key: u.userId,
                  label: shortUserId(u.userId),
                  inputTokens: u.inputTokens,
                  outputTokens: u.outputTokens,
                  totalTokens: u.totalTokens,
                  costUsd: u.costUsd
                }))}
                barColor="var(--chart-1)"
                chartBars={userBars}
                chartPrimaryColor="var(--chart-1)"
                chartSecondaryColor="var(--chart-2)"
              />
            )
          ) : null}

          {view === "model" ? (
            usage.byModel.length === 0 ? (
              <p className={HINT}>No model data in this period.</p>
            ) : (
              <BreakdownTable
                rows={usage.byModel.map((m) => ({
                  key: m.modelName,
                  label: m.modelName,
                  inputTokens: m.inputTokens,
                  outputTokens: m.outputTokens,
                  totalTokens: m.totalTokens,
                  costUsd: m.costUsd
                }))}
                barColor="var(--chart-3)"
                chartBars={modelBars}
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

// ---------------------------------------------------------------------------
// Shared breakdown table used for both user + model views
// ---------------------------------------------------------------------------

type BreakdownRow = {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

const COL_GRID = "grid grid-cols-[1fr_80px_80px_80px_90px] gap-x-4";

function BreakdownTable({
  rows,
  barColor,
  chartBars,
  chartPrimaryColor,
  chartSecondaryColor
}: {
  rows: BreakdownRow[];
  barColor: string;
  chartBars: Array<{ label: string; primary: number; secondary: number }>;
  chartPrimaryColor: string;
  chartSecondaryColor: string;
}) {
  const maxTokens = Math.max(...rows.map((r) => r.totalTokens), 1);

  return (
    <div className="flex flex-col">
      <div
        className={`${COL_GRID} border-b border-outline-variant py-1.5 text-[0.7rem] font-bold uppercase tracking-wider text-on-surface-faint`}
      >
        <span>Name</span>
        <span className="text-right">Input</span>
        <span className="text-right">Output</span>
        <span className="text-right">Total</span>
        <span className="text-right">Cost</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.key}
          className={`${COL_GRID} items-center border-b border-outline-variant py-2.5 text-sm`}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <HBar value={r.totalTokens} max={maxTokens} color={barColor} />
            <span className="max-w-[180px] flex-shrink-0 overflow-hidden font-mono text-[0.78rem] text-ellipsis whitespace-nowrap text-on-surface-variant">
              {r.label}
            </span>
          </div>
          <span className="text-right text-[0.82rem] text-on-surface-variant">
            {fmtTokens(r.inputTokens)}
          </span>
          <span className="text-right text-[0.82rem] text-on-surface-variant">
            {fmtTokens(r.outputTokens)}
          </span>
          <span className="text-right font-semibold">{fmtTokens(r.totalTokens)}</span>
          <span className="text-right text-[0.82rem] text-on-surface-variant">
            {fmtCost(r.costUsd)}
          </span>
        </div>
      ))}

      <div className="pt-5">
        <BarChart
          data={chartBars}
          primaryColor={chartPrimaryColor}
          secondaryColor={chartSecondaryColor}
          primaryLabel="Input tokens"
          secondaryLabel="Output tokens"
        />
      </div>
    </div>
  );
}
