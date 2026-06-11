"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchPersonalTokenUsage, type PersonalTokenUsageSeries } from "../lib/settings-api";
import {
  BarChart,
  DayRangePicker,
  fmtCost,
  fmtTokens,
  HBar,
  type Days,
  ViewToggle
} from "./token-usage-chart-primitives";
import { HINT, SECTION_LABEL } from "../lib/ui-tokens";

const STAT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4";
const COL_GRID = "grid grid-cols-[1fr_80px_80px_80px_90px] gap-x-4";

type View = "day" | "model";

const VIEW_OPTIONS: Array<{ id: View; label: string }> = [
  { id: "day", label: "Over time" },
  { id: "model", label: "By model" }
];

export function PersonalTokenUsageSection() {
  const [days, setDays] = useState<Days>(30);
  const [view, setView] = useState<View>("day");
  const [usage, setUsage] = useState<PersonalTokenUsageSeries | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: Days) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPersonalTokenUsage(d);
      setUsage(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load token usage.");
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

  const modelBars = useMemo(
    () =>
      (usage?.byModel ?? []).map((m) => ({
        label: m.modelName,
        primary: m.inputTokens,
        secondary: m.outputTokens
      })),
    [usage]
  );

  const maxModelTokens = useMemo(
    () => Math.max(...(usage?.byModel ?? []).map((m) => m.totalTokens), 1),
    [usage]
  );

  const totals = usage?.totals;

  return (
    <section id="usage" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Personal stats</p>
        <h3 className="text-lg font-semibold text-on-surface">Token usage &amp; cost</h3>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-2 pb-1">
        <DayRangePicker value={days} onChange={setDays} />
        <ViewToggle options={VIEW_OPTIONS} value={view} onChange={setView} />
        {loading ? <span className="text-xs text-on-surface-faint">Loading…</span> : null}
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {totals ? (
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

      {usage && !loading ? (
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
              <div className="flex flex-col">
                <div
                  className={`${COL_GRID} border-b border-outline-variant py-1.5 text-[0.7rem] font-bold uppercase tracking-wider text-on-surface-faint`}
                >
                  <span>Model</span>
                  <span className="text-right">Input</span>
                  <span className="text-right">Output</span>
                  <span className="text-right">Total</span>
                  <span className="text-right">Cost</span>
                </div>

                {usage.byModel.map((m) => (
                  <div
                    key={m.modelName}
                    className={`${COL_GRID} items-center border-b border-outline-variant py-2.5 text-sm`}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <HBar
                        value={m.totalTokens}
                        max={maxModelTokens}
                        color="var(--color-warning)"
                      />
                      <span className="max-w-[180px] flex-shrink-0 overflow-hidden font-mono text-[0.82rem] text-ellipsis whitespace-nowrap text-on-surface-variant">
                        {m.modelName}
                      </span>
                    </div>
                    <span className="text-right text-[0.82rem] text-on-surface-variant">
                      {fmtTokens(m.inputTokens)}
                    </span>
                    <span className="text-right text-[0.82rem] text-on-surface-variant">
                      {fmtTokens(m.outputTokens)}
                    </span>
                    <span className="text-right font-semibold">{fmtTokens(m.totalTokens)}</span>
                    <span className="text-right text-[0.82rem] text-on-surface-variant">
                      {fmtCost(m.costUsd)}
                    </span>
                  </div>
                ))}

                <div className="pt-5">
                  <BarChart
                    data={modelBars}
                    primaryColor="var(--color-warning)"
                    secondaryColor="var(--color-success)"
                    primaryLabel="Input tokens"
                    secondaryLabel="Output tokens"
                  />
                </div>
              </div>
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
