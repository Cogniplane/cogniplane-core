"use client";

import { Bar, BarChart as RechartsBarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { DAY_OPTIONS, fmtAxisShort, formatBarLabel, type Days } from "./token-usage-chart-primitives.logic";
import { Button } from "@/components/ui/button";
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
  data: Array<{ label: string; primary: number; secondary: number }>;
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
        <Bar dataKey="primary" name={primaryLabel} fill="var(--color-inputSeries)" radius={2} />
        <Bar dataKey="secondary" name={secondaryLabel} fill="var(--color-outputSeries)" radius={2} />
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
