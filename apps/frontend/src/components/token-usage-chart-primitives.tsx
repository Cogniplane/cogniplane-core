"use client";

import { Bar, BarChart as RechartsBarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { DAY_OPTIONS, fmtAxisShort, fmtCost, formatBarLabel, type Days } from "./token-usage-chart-primitives.logic";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SECTION_LABEL } from "../lib/ui-tokens";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from "@/components/ui/chart";

export { fmtCost, fmtTokens, type Days } from "./token-usage-chart-primitives.logic";

// ---------------------------------------------------------------------------
// Grouped bar chart (Recharts via the shadcn chart wrapper). `primaryColor`
// and `secondaryColor` accept a CSS color or a `var(--chart-N)` token.
// ---------------------------------------------------------------------------

export type BarChartProps = {
  title?: string;
  data: Array<{ label: string; inputSeries: number; outputSeries: number }>;
  primaryColor: string;
  secondaryColor: string;
  primaryLabel: string;
  secondaryLabel: string;
};

export function BarChart({
  title = "Token usage chart",
  data,
  primaryColor,
  secondaryColor,
  primaryLabel,
  secondaryLabel
}: BarChartProps) {
  // Config keys are deliberately chart-specific (`inputSeries`/`outputSeries`)
  // rather than `primary`/`secondary`: ChartContainer emits a `--color-<key>`
  // CSS var per key, and `primary`/`secondary` would collide with the app's
  // global design tokens (--color-primary / --color-secondary).
  const config = {
    inputSeries: { label: primaryLabel, color: primaryColor },
    outputSeries: { label: secondaryLabel, color: secondaryColor }
  } satisfies ChartConfig;

  return (
    <ChartContainer config={config} aria-label={title} className="h-[220px] w-full text-on-surface [&_.recharts-surface:focus-visible]:outline-solid [&_.recharts-surface:focus-visible]:outline-2 [&_.recharts-surface:focus-visible]:outline-brand">
      <RechartsBarChart accessibilityLayer aria-label={`${title}. Use left and right arrow keys to inspect values.`} data={data} margin={{ top: 12, right: 8, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--color-outline-variant)" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={formatBarLabel}
          className="text-xs"
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          tickFormatter={fmtAxisShort}
          className="text-xs"
        />
        <ChartTooltip
          content={<ChartTooltipContent className="max-w-[min(22rem,80vw)] break-words text-on-surface" labelFormatter={(_label, payload) => String(payload[0]?.payload?.label ?? "")} />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="inputSeries" name={primaryLabel} fill="var(--color-inputSeries)" radius={2} isAnimationActive={false} />
        <Bar dataKey="outputSeries" name={secondaryLabel} fill="var(--color-outputSeries)" radius={2} isAnimationActive={false} />
      </RechartsBarChart>
    </ChartContainer>
  );
}

export function HBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div aria-hidden="true" className="h-1.5 w-16 shrink-0 overflow-hidden rounded-sm bg-surface-container">
      <div
        className="h-full rounded-sm transition-[width] duration-[400ms] ease-out motion-reduce:transition-none"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

const REPORT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4";

export function ReportStatCard(props: { label: string; value: string; detail: string }) {
  return (
    <article className={REPORT_CARD}>
      <p className={SECTION_LABEL}>{props.label}</p>
      <strong className="mt-2 block text-2xl font-bold tracking-tight text-on-surface tabular-nums">
        {props.value}
      </strong>
      <p className="mt-1 text-xs text-on-surface-variant">{props.detail}</p>
    </article>
  );
}

export function TokenUsageSummary({
  totals,
  days
}: {
  totals: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    messageCount: number;
  };
  days: Days;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <ReportStatCard
        label="Total tokens"
        value={totals.totalTokens.toLocaleString("en-US")}
        detail={`In the last ${days} days`}
      />
      <ReportStatCard
        label="Input tokens"
        value={totals.inputTokens.toLocaleString("en-US")}
        detail="Prompt + context"
      />
      <ReportStatCard
        label="Output tokens"
        value={totals.outputTokens.toLocaleString("en-US")}
        detail="Generated text"
      />
      <ReportStatCard
        label="Estimated cost, USD"
        value={fmtCost(totals.costUsd)}
        detail={`${totals.messageCount.toLocaleString("en-US")} messages`}
      />
    </div>
  );
}

export function TokenUsageSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={REPORT_CARD} data-testid="token-usage-stat-skeleton">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-7 w-16" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
        ))}
      </div>
      <div className={`${REPORT_CARD} p-5`}>
        <Skeleton className="h-[200px] w-full" />
      </div>
    </>
  );
}

export type TokenBreakdownRow = {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

export function TokenBreakdown({ rows, barColor, firstColumnLabel }: {
  rows: TokenBreakdownRow[];
  barColor: string;
  firstColumnLabel: "User" | "Model" | "Date, UTC";
}) {
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens), 1);
  return (
    <ul aria-label={`${firstColumnLabel} token breakdown`} className="divide-y divide-outline-variant">
      {rows.map(row => (
        <li key={row.key} className="py-4 first:pt-0 last:pb-0">
          <div className="mb-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
            <span className="min-w-0 w-full break-words text-sm font-medium sm:w-auto sm:flex-1 text-on-surface [overflow-wrap:anywhere]">{row.label}</span>
            <HBar value={row.totalTokens} max={maxTokens} color={barColor} />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm tabular-nums sm:grid-cols-4">
            {[
              ["Input", row.inputTokens.toLocaleString("en-US")],
              ["Output", row.outputTokens.toLocaleString("en-US")],
              ["Total", row.totalTokens.toLocaleString("en-US")],
              ["Est. cost, USD", fmtCost(row.costUsd)]
            ].map(([label, value]) => <div key={label} className="min-w-0"><dt className="mb-1 text-xs text-on-surface-variant">{label}</dt><dd className="break-words font-medium text-on-surface [overflow-wrap:anywhere]">{value}</dd></div>)}
          </dl>
        </li>
      ))}
    </ul>
  );
}

export function DailyTokenUsage({ daily }: { daily: Array<{ date: string; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }> }) {
  return <div className="min-w-0">
    <h3 className="mb-3 text-sm font-semibold text-on-surface">Daily tokens, UTC</h3>
    <BarChart title="Daily input and output tokens, UTC" data={daily.map(day => ({ label: day.date, inputSeries: day.inputTokens, outputSeries: day.outputTokens }))} primaryColor="var(--chart-1)" secondaryColor="var(--chart-2)" primaryLabel="Input tokens" secondaryLabel="Output tokens" />
    <details className="mt-5 border-t border-outline-variant pt-3">
      <summary className="cursor-pointer rounded-sm py-2 text-sm font-medium text-on-surface focus-visible:outline-2 focus-visible:outline-brand">Daily values and estimated cost</summary>
      <div className="pt-3"><TokenBreakdown firstColumnLabel="Date, UTC" barColor="var(--chart-1)" rows={daily.map(day => ({ key: day.date, label: day.date, ...day }))} /></div>
    </details>
  </div>;
}

export function UsageReportStatus({ days, report, fetching, error, unavailable, onRetry }: {
  days: Days;
  report?: { days: Days; loadedAt: string };
  fetching: boolean;
  error: string | null;
  unavailable: boolean;
  onRetry: () => void;
}) {
  return <div className="space-y-2 text-sm">
    <p role="status" className="text-on-surface-variant">
      {fetching
        ? report ? `Loading the last ${days} days. Showing the previous ${report.days}-day report until the read succeeds.` : `Loading usage for the last ${days} days.`
        : report ? `Showing the last ${report.days} days. Loaded ${report.loadedAt.replace("T", " ").slice(0, 19)} UTC.` : null}
    </p>
    {error ? <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-0 flex-1 basis-60 break-words text-danger">{error}{report ? ` The last ${days} days could not be loaded. The ${report.days}-day report shown below has not been updated.` : ""}</p>
      <Button type="button" variant="outline" size="sm" disabled={fetching} onClick={onRetry}>{fetching ? "Retrying…" : unavailable ? "Check again" : "Retry"}</Button>
    </div> : null}
  </div>;
}

export function DayRangePicker({
  value,
  onChange
}: {
  value: Days;
  onChange: (d: Days) => void;
}) {
  return (
    <div role="group" aria-label="Report period" className="flex flex-wrap gap-1">
      {DAY_OPTIONS.map((d) => (
        <Button
          key={d}
          aria-pressed={value === d}
          type="button"
          variant={value === d ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onChange(d)}
        >
          {d}d
        </Button>
      ))}
    </div>
  );
}

export function ViewToggle<T extends string>({
  options,
  value,
  onChange
}: {
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label="Report view" className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <Button
          key={opt.id}
          aria-pressed={value === opt.id}
          type="button"
          variant={value === opt.id ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}
