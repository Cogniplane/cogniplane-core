"use client";

import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";

import {
  buildSegmentTooltip,
  entityColor,
  formatBucketLabel,
  TIME_SERIES_ACTIONS
} from "../../../lib/admin-pii-utils";
import type {
  PiiActivityMetrics,
  PiiBucketGranularity,
  PiiActivityTimeSeriesPoint
} from "@cogniplane/shared-types";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from "@/components/ui/chart";
import { HINT, SECTION_LABEL } from "../../../lib/ui-tokens";

const STAT_CARD =
  "min-w-0 space-y-3";
const OVERVIEW_GRID =
  "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3";

// Categorical chart palette for the five action stacks. The eye should read
// these as different kinds of decision, not severity levels. Config keys are
// the action names (allow/report/...), which do NOT collide with the app's
// global --color-* design tokens, so ChartContainer can safely emit
// --color-allow etc. for the stacked bars to reference.
const ACTION_CHART_CONFIG = {
  // Past-tense results, named after the Settings modes: Detect reports, Block blocks, Transform transforms.
  allow: { label: "Allowed", color: "var(--chart-2)" },
  report: { label: "Reported", color: "var(--chart-1)" },
  block: { label: "Blocked", color: "var(--chart-4)" },
  transformedCount: { label: "Transformed", color: "var(--chart-5)" },
  failed: { label: "Failed", color: "var(--chart-3)" }
} satisfies ChartConfig;

const CHART_KEYS = {
  allow: "allow", report: "report", block: "block", transform: "transformedCount", failed: "failed"
} as const;

/**
 * Stacked-bar time-series of PII actions per bucket. The API already returns
 * chart-ready points ({ bucket, allow, report, block, transform, failed }),
 * so this maps them straight onto a Recharts stacked BarChart — no geometry
 * pre-computation. Recharts owns axes, gridlines, hover tooltip, and the
 * responsive container.
 */
export function TimeSeriesChart({
  series,
  bucket
}: {
  series: PiiActivityTimeSeriesPoint[];
  bucket: PiiBucketGranularity;
}) {
  // The API fills empty buckets with zeros, so an empty chart is all zeros, not an empty list.
  // The chart counts finished scans only. The Scans tile also counts queued ones.
  if (series.every((point) => TIME_SERIES_ACTIONS.every((action) => !point[action]))) {
    return <p className={HINT}>No completed scans in this range.</p>;
  }

  // Recharts forwards datum fields to SVG shapes. Keep the API's numeric
  // `transform` count away from the SVG attribute with the same name.
  const chartSeries = series.map(({ transform, ...point }) => ({ ...point, transformedCount: transform }));

  return (
    <ChartContainer config={ACTION_CHART_CONFIG} className="h-60 w-full">
      <BarChart data={chartSeries} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--color-outline-variant)" />
        <XAxis
          dataKey="bucket"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value) => formatBucketLabel(String(value), bucket)}
          className="text-xs"
        />
        <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} className="text-xs" />
        <ChartTooltip
          content={
            <ChartTooltipContent labelFormatter={(label) => formatBucketLabel(String(label), bucket)} />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {TIME_SERIES_ACTIONS.map((action) => (
          <Bar
            key={action}
            dataKey={CHART_KEYS[action]}
            stackId="actions"
            fill={`var(--color-${CHART_KEYS[action]})`}
            name={ACTION_CHART_CONFIG[CHART_KEYS[action]].label}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

// ─── Findings breakdown ────────────────────────────────────────────────────

export function FindingsBreakdown({ data }: { data: PiiActivityMetrics }) {
  const allEntities = Array.from(
    new Set([
      ...data.byEntityType.map((r) => r.entityType),
      ...data.byConfidence.map((r) => r.entityType)
    ])
  );

  // bySubjectType counts scans, not findings, so only the entity counts decide this.
  const findings = data.byEntityType.reduce((sum, row) => sum + row.count, 0);
  if (findings === 0) return <p className={HINT}>No findings in this range.</p>;

  return (
    <div className={OVERVIEW_GRID}>
      <DonutCard rows={data.byEntityType} allEntities={allEntities} />
      <ConfidenceCard rows={data.byConfidence} />
      <SubjectSplitCard rows={data.bySubjectType} />
    </div>
  );
}

function DonutCard({
  rows,
  allEntities
}: {
  rows: Array<{ entityType: string; count: number }>;
  allEntities: string[];
}) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  // Pre-resolve each slice's color from the shared entity palette so the
  // Recharts <Cell>s and the legend list stay in lockstep.
  const slices = rows
    .filter((r) => r.count > 0)
    .map((r) => ({
      entityType: r.entityType,
      count: r.count,
      color: entityColor(r.entityType, allEntities),
      percentage: total > 0 ? Math.round((r.count / total) * 1000) / 10 : 0
    }));

  // Minimal config: the donut colors live on each <Cell>, not in config keys,
  // so a single generic series entry is enough for the tooltip wrapper.
  const config = { count: { label: "Findings" } } satisfies ChartConfig;

  return (
    <article className={STAT_CARD}>
      <h3 className={SECTION_LABEL}>By entity type</h3>
      {slices.length === 0 ? (
        <p className={`${HINT} mt-2`}>No findings in this range.</p>
      ) : (
        <div className="mt-3 flex min-w-0 flex-col items-start gap-4">
          <ChartContainer
            config={config}
            className="aspect-square h-[140px] w-full max-w-[140px]"
          >
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent nameKey="entityType" hideLabel />} />
              <Pie
                data={slices}
                dataKey="count"
                nameKey="entityType"
                innerRadius="55%"
                outerRadius="100%"
                strokeWidth={0}
              >
                {slices.map((s) => (
                  <Cell key={s.entityType} fill={s.color} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
          <ul className="m-0 flex w-full min-w-0 list-none flex-col gap-2 p-0 text-xs text-on-surface-variant">
            {slices.map((s) => (
              <li key={s.entityType} className="flex min-w-0 items-start gap-1.5">
                <span
                  aria-hidden="true"
                  className="mt-1 size-2 shrink-0 rounded-sm"
                  style={{ background: s.color }}
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {s.entityType}: {s.count} ({s.percentage}%)
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function ConfidenceCard({ rows }: { rows: PiiActivityMetrics["byConfidence"] }) {
  if (rows.length === 0) {
    return (
      <article className={STAT_CARD}>
        <h3 className={SECTION_LABEL}>By confidence</h3>
        <p className={`${HINT} mt-2`}>No findings in this range.</p>
      </article>
    );
  }

  return (
    <article className={STAT_CARD}>
      <h3 className={SECTION_LABEL}>By confidence</h3>
      <div className="mt-2 flex flex-col gap-2">
        {rows.map((row) => {
          const total = row.high + row.medium + row.low;
          if (total === 0) return null;
          const highPct = (row.high / total) * 100;
          const mediumPct = (row.medium / total) * 100;
          const lowPct = (row.low / total) * 100;
          return (
            <div key={row.entityType}>
              <div className="mb-0.5 flex items-start justify-between gap-2 text-xs text-on-surface-variant">
                <span className="min-w-0 [overflow-wrap:anywhere]">{row.entityType}</span>
                <span className="shrink-0 tabular-nums">{total}</span>
              </div>
              <div
                role="img"
                aria-label={`${row.entityType}: ${row.high} high, ${row.medium} medium, ${row.low} low confidence`}
                className="flex h-2.5 overflow-hidden rounded bg-surface-container"
              >
                {row.high > 0 ? (
                  // HTML title attribute (not <title> child) is the right
                  // tooltip mechanism in non-SVG context — browsers render
                  // it on hover; <title> as a child of <span> is parsed as
                  // an unknown element and shows nothing.
                  <span
                    title={`high: ${buildSegmentTooltip(row.high, total)}`}
                    className="transition-[width] duration-200"
                    style={{ width: `${highPct}%`, background: "var(--color-success)" }}
                  />
                ) : null}
                {row.medium > 0 ? (
                  <span
                    title={`medium: ${buildSegmentTooltip(row.medium, total)}`}
                    style={{ width: `${mediumPct}%`, background: "var(--color-on-surface-variant)" }}
                  />
                ) : null}
                {row.low > 0 ? (
                  <span
                    title={`low: ${buildSegmentTooltip(row.low, total)}`}
                    style={{ width: `${lowPct}%`, background: "var(--color-warning)" }}
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function SubjectSplitCard({ rows }: { rows: PiiActivityMetrics["bySubjectType"] }) {
  const total = rows.reduce((sum, r) => sum + r.count, 0) || 1;
  const sources = [
    { type: "message", label: "chat", color: "var(--chart-1)" },
    { type: "artifact", label: "direct uploads", color: "var(--chart-2)" },
    { type: "project_instructions", label: "project instructions", color: "var(--chart-3)" }
  ].map((source) => ({ ...source, count: rows.find((r) => r.subjectType === source.type)?.count ?? 0 }));

  return (
    <article className={STAT_CARD}>
      <h3 className={SECTION_LABEL}>By source</h3>
      <dl className="mt-3 flex flex-col gap-2 tabular-nums">
        {sources.map((source) => <div key={source.type} className="flex items-baseline justify-between gap-3">
          <dt className="text-xs text-on-surface-variant">{source.label}</dt>
          <dd className="shrink-0 text-base font-semibold text-on-surface">
            {source.count}
            <span className="ml-2 text-xs font-normal text-on-surface-variant"> ({((source.count / total) * 100).toFixed(0)}%)</span>
          </dd>
        </div>)}
      </dl>
      <div role="img" aria-label={sources.map((s) => `${s.count} ${s.label} scans`).join(", ")}
        className="mt-3 flex h-2.5 overflow-hidden rounded bg-surface-container">
        {sources.filter((s) => s.count > 0).map((source) => <span key={source.type}
          title={`${source.label}: ${buildSegmentTooltip(source.count, total)}`}
          style={{ width: `${(source.count / total) * 100}%`, background: source.color }} />)}
      </div>
    </article>
  );
}
