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
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4";
const OVERVIEW_GRID =
  "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";

// Categorical chart palette for the five action stacks. The eye should read
// these as different kinds of decision, not severity levels. Config keys are
// the action names (allow/report/...), which do NOT collide with the app's
// global --color-* design tokens, so ChartContainer can safely emit
// --color-allow etc. for the stacked bars to reference.
const ACTION_CHART_CONFIG = {
  allow: { label: "Allow", color: "var(--chart-2)" },
  report: { label: "Report", color: "var(--chart-1)" },
  block: { label: "Block", color: "var(--chart-4)" },
  transform: { label: "Transform", color: "var(--chart-5)" },
  failed: { label: "Failed", color: "var(--chart-3)" }
} satisfies ChartConfig;

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
  if (series.length === 0) {
    return <p className={HINT}>No PII activity in this range.</p>;
  }

  return (
    <ChartContainer config={ACTION_CHART_CONFIG} className="h-60 w-full">
      <BarChart data={series} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--color-outline-variant)" />
        <XAxis
          dataKey="bucket"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value) => formatBucketLabel(String(value), bucket)}
          className="text-[0.72rem]"
        />
        <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} className="text-[0.7rem]" />
        <ChartTooltip
          content={
            <ChartTooltipContent labelFormatter={(label) => formatBucketLabel(String(label), bucket)} />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {TIME_SERIES_ACTIONS.map((action) => (
          <Bar
            key={action}
            dataKey={action}
            stackId="actions"
            fill={`var(--color-${action})`}
            name={ACTION_CHART_CONFIG[action].label}
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
      <p className={SECTION_LABEL}>By entity type</p>
      {slices.length === 0 ? (
        <p className={`${HINT} mt-2`}>No findings detected in this range.</p>
      ) : (
        <div className="mt-3 flex items-center gap-4">
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
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[0.78rem] text-on-surface-variant">
            {slices.map((s) => (
              <li key={s.entityType} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-sm"
                  style={{ background: s.color }}
                />
                <span>
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
        <p className={SECTION_LABEL}>By confidence</p>
        <p className={`${HINT} mt-2`}>No findings detected in this range.</p>
      </article>
    );
  }

  return (
    <article className={STAT_CARD}>
      <p className={SECTION_LABEL}>By confidence</p>
      <div className="mt-2 flex flex-col gap-2">
        {rows.map((row) => {
          const total = row.high + row.medium + row.low;
          if (total === 0) return null;
          const highPct = (row.high / total) * 100;
          const mediumPct = (row.medium / total) * 100;
          const lowPct = (row.low / total) * 100;
          return (
            <div key={row.entityType}>
              <div className="mb-0.5 flex items-center justify-between text-[0.78rem] text-on-surface-variant">
                <span>{row.entityType}</span>
                <span className="tabular-nums">{total}</span>
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
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  if (total === 0) {
    return (
      <article className={STAT_CARD}>
        <p className={SECTION_LABEL}>By source</p>
        <p className={`${HINT} mt-2`}>No PII activity in this range.</p>
      </article>
    );
  }
  const messageCount = rows.find((r) => r.subjectType === "message")?.count ?? 0;
  const artifactCount = rows.find((r) => r.subjectType === "artifact")?.count ?? 0;
  const messagePct = (messageCount / total) * 100;
  const artifactPct = (artifactCount / total) * 100;

  return (
    <article className={STAT_CARD}>
      <p className={SECTION_LABEL}>By source</p>
      <div className="mt-2 flex gap-4 tabular-nums">
        <div className="flex-1">
          <strong className="block text-[1.4rem] text-on-surface">{messageCount}</strong>
          <span className="text-[0.78rem] text-on-surface-variant">
            chat ({messagePct.toFixed(0)}%)
          </span>
        </div>
        <div className="flex-1">
          <strong className="block text-[1.4rem] text-on-surface">{artifactCount}</strong>
          <span className="text-[0.78rem] text-on-surface-variant">
            uploads ({artifactPct.toFixed(0)}%)
          </span>
        </div>
      </div>
      <div
        role="img"
        aria-label={`${messageCount} chat scans, ${artifactCount} upload scans`}
        className="mt-3 flex h-2.5 overflow-hidden rounded bg-surface-container"
      >
        {messageCount > 0 ? (
          <span
            title={`chat: ${buildSegmentTooltip(messageCount, total)}`}
            style={{ width: `${messagePct}%`, background: "var(--color-accent)" }}
          />
        ) : null}
        {artifactCount > 0 ? (
          <span
            title={`uploads: ${buildSegmentTooltip(artifactCount, total)}`}
            style={{ width: `${artifactPct}%`, background: "var(--color-success)" }}
          />
        ) : null}
      </div>
    </article>
  );
}
