"use client";

import { Bar, BarChart as RechartsBarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { DAY_OPTIONS, fmtAxisShort, fmtCost, fmtTokens, formatBarLabel, type Days } from "./token-usage-chart-primitives.logic";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SECTION_LABEL, TOKEN_USAGE_COL_GRID } from "../lib/ui-tokens";
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
// Grouped bar chart (Recharts via the shadcn chart wrapper). The public prop
// shape is unchanged from the prior hand-rolled SVG version so every call
// site keeps working; `primaryColor`/`secondaryColor` accept a CSS color or
// `var(--chart-N)` token.
// ---------------------------------------------------------------------------

export type BarChartProps = {
  data: Array<{ label: string; inputSeries: number; outputSeries: number }>;
  primaryColor: string;
  secondaryColor: string;
  primaryLabel: string;
  secondaryLabel: string;
};

export function BarChart({
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
    <ChartContainer config={config} className="h-[200px] w-full">
      <RechartsBarChart data={data} margin={{ top: 12, right: 8, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--color-outline-variant)" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={formatBarLabel}
          className="text-[0.7rem]"
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          tickFormatter={fmtAxisShort}
          className="text-[0.7rem]"
        />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={(label) => formatBarLabel(String(label))} />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="inputSeries" name={primaryLabel} fill="var(--color-inputSeries)" radius={2} />
        <Bar dataKey="outputSeries" name={secondaryLabel} fill="var(--color-outputSeries)" radius={2} />
      </RechartsBarChart>
    </ChartContainer>
  );
}

// ---------------------------------------------------------------------------
// Horizontal proportion bar
// ---------------------------------------------------------------------------

export function HBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="h-1.5 min-w-[60px] flex-1 overflow-hidden rounded-sm bg-surface-container">
      <div
        className="h-full rounded-sm transition-[width] duration-[400ms] ease-out"
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
        value={fmtTokens(totals.totalTokens)}
        detail={`In the last ${days} days`}
      />
      <ReportStatCard
        label="Input tokens"
        value={fmtTokens(totals.inputTokens)}
        detail="Prompt + context"
      />
      <ReportStatCard
        label="Output tokens"
        value={fmtTokens(totals.outputTokens)}
        detail="Generated text"
      />
      <ReportStatCard
        label="Est. cost"
        value={fmtCost(totals.costUsd)}
        detail={`${totals.messageCount} messages`}
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

export function TokenBreakdown({
  rows,
  barColor,
  chartPrimaryColor,
  chartSecondaryColor,
  firstColumnLabel
}: {
  rows: TokenBreakdownRow[];
  barColor: string;
  chartPrimaryColor: string;
  chartSecondaryColor: string;
  firstColumnLabel: "User" | "Model";
}) {
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens), 1);
  return (
    <div className="flex flex-col">
      <div
        className={`${TOKEN_USAGE_COL_GRID} border-b border-outline-variant py-1.5 text-[0.7rem] font-bold uppercase tracking-wider text-on-surface-faint`}
      >
        <span>{firstColumnLabel}</span>
        <span className="text-right">Input</span>
        <span className="text-right">Output</span>
        <span className="text-right">Total</span>
        <span className="text-right">Cost</span>
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          className={`${TOKEN_USAGE_COL_GRID} items-center border-b border-outline-variant py-2.5 text-sm`}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <HBar value={row.totalTokens} max={maxTokens} color={barColor} />
            <span className="max-w-[180px] flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.82rem] text-on-surface-variant">
              {row.label}
            </span>
          </div>
          <span className="text-right text-[0.82rem] text-on-surface-variant">
            {fmtTokens(row.inputTokens)}
          </span>
          <span className="text-right text-[0.82rem] text-on-surface-variant">
            {fmtTokens(row.outputTokens)}
          </span>
          <span className="text-right font-semibold">
            {fmtTokens(row.totalTokens)}
          </span>
          <span className="text-right text-[0.82rem] text-on-surface-variant">
            {fmtCost(row.costUsd)}
          </span>
        </div>
      ))}
      <div className="pt-5">
        <BarChart
          data={rows.map((row) => ({
            label: row.label,
            inputSeries: row.inputTokens,
            outputSeries: row.outputTokens
          }))}
          primaryColor={chartPrimaryColor}
          secondaryColor={chartSecondaryColor}
          primaryLabel="Input tokens"
          secondaryLabel="Output tokens"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day range + view toggle controls (shared UI)
// ---------------------------------------------------------------------------

export function DayRangePicker({
  value,
  onChange
}: {
  value: Days;
  onChange: (d: Days) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {DAY_OPTIONS.map((d) => (
        <Button
          key={d}
          type="button"
          variant={value === d ? "secondary" : "ghost"}
          size="xs"
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
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <Button
          key={opt.id}
          type="button"
          variant={value === opt.id ? "secondary" : "ghost"}
          size="xs"
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}
