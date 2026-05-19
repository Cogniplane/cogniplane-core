"use client";

import { useMemo } from "react";

import {
  computeBarLayout,
  computeYTicks,
  DAY_OPTIONS,
  fmtAxisShort,
  formatBarLabel,
  shouldShowBarLabel,
  type Days
} from "./token-usage-chart-primitives.logic";
import { Button } from "@/components/ui/button";

export { fmtCost, fmtTokens, type Days } from "./token-usage-chart-primitives.logic";

// ---------------------------------------------------------------------------
// Tiny SVG grouped bar chart — no external dependencies
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
  const W = 600;
  const H = 200;
  const PAD = { top: 12, right: 8, bottom: 36, left: 52 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const maxVal = useMemo(
    () => Math.max(...data.map((d) => d.primary + d.secondary), 1),
    [data]
  );

  const yTicks = useMemo(() => computeYTicks(maxVal), [maxVal]);
  const layout = useMemo(() => computeBarLayout(chartW, data.length), [chartW, data.length]);

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        aria-label="Token usage bar chart"
      >
        {yTicks.map((tick, i) => {
          const y = PAD.top + chartH - (tick / maxVal) * chartH;
          return (
            <g key={`${tick}-${i}`}>
              <line
                x1={PAD.left}
                x2={PAD.left + chartW}
                y1={y}
                y2={y}
                stroke="var(--color-outline-variant)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={y + 4}
                textAnchor="end"
                fontSize={9}
                fill="var(--color-on-surface-faint)"
                fontFamily="inherit"
              >
                {fmtAxisShort(tick)}
              </text>
            </g>
          );
        })}

        {data.map((d, i) => {
          const cx = PAD.left + i * layout.barGroupW + layout.barGroupW / 2;
          const x1 = cx - layout.barW - layout.gap / 2;
          const x2 = cx + layout.gap / 2;
          const h1 = (d.primary / maxVal) * chartH;
          const h2 = (d.secondary / maxVal) * chartH;

          return (
            <g key={d.label}>
              <rect
                x={x1}
                y={PAD.top + chartH - h1}
                width={layout.barW}
                height={h1}
                rx={2}
                fill={primaryColor}
                opacity={0.85}
              />
              <rect
                x={x2}
                y={PAD.top + chartH - h2}
                width={layout.barW}
                height={h2}
                rx={2}
                fill={secondaryColor}
                opacity={0.75}
              />
              {shouldShowBarLabel(i, data.length) && (
                <text
                  x={cx}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize={8}
                  fill="var(--color-on-surface-faint)"
                  fontFamily="inherit"
                >
                  {formatBarLabel(d.label)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div
        className="flex gap-4 pt-1 text-xs text-on-surface-variant"
        style={{ paddingLeft: PAD.left }}
      >
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 shrink-0 rounded-sm opacity-85"
            style={{ background: primaryColor }}
          />
          {primaryLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 shrink-0 rounded-sm opacity-75"
            style={{ background: secondaryColor }}
          />
          {secondaryLabel}
        </span>
      </div>
    </div>
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
