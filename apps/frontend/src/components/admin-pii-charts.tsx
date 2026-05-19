"use client";

import {
  buildDonutSegments,
  buildSegmentTooltip,
  buildTimeSeriesGeometry,
  entityColor,
  formatBucketLabel,
  TIME_SERIES_ACTIONS,
  type TimeSeriesAction
} from "../lib/admin-pii-utils";
import type {
  PiiActivityMetrics,
  PiiBucketGranularity,
  PiiActivityTimeSeriesPoint
} from "@cogniplane/shared-types";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const STAT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4";
const HINT = "text-sm text-on-surface-faint";
const OVERVIEW_GRID =
  "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";

// Categorical hues for the five action stacks. Pulled from existing CSS
// tokens (no net-new colors). The eye should read these as different
// kinds of decision, not as severity levels — that's why allow=success
// and block=danger are distant hues, and report/transform are both
// accent-tinted (they're variations of "we did something with this").
const ACTION_COLOR: Record<TimeSeriesAction, string> = {
  allow: "var(--color-success)",
  report: "var(--color-accent)",
  block: "var(--color-danger)",
  transform: "color-mix(in srgb, var(--color-accent) 70%, var(--color-surface-container))",
  failed: "var(--color-warning)"
};

const ACTION_LABEL: Record<TimeSeriesAction, string> = {
  allow: "Allow",
  report: "Report",
  block: "Block",
  transform: "Transform",
  failed: "Failed"
};

/**
 * Stacked-bar time-series chart. Picked stacked bars over stacked areas
 * because the API returns 7–30 buckets — discrete enough that bars read
 * cleaner than continuous areas, and the geometry helper is simpler.
 *
 * Tooltips are pre-computed `<title>` strings on each segment. That gives
 * native browser hover with count + percentage on desktop. If product
 * later wants a richer interactive overlay, the upgrade path is local
 * to this component.
 */
export function TimeSeriesChart({
  series,
  bucket
}: {
  series: PiiActivityTimeSeriesPoint[];
  bucket: PiiBucketGranularity;
}) {
  const geometry = buildTimeSeriesGeometry(series);

  if (geometry.bars.length === 0) {
    return <p className={HINT}>No PII activity in this range.</p>;
  }

  const tickStride = computeXTickStride(geometry.bars.length);

  // 0..100 on x, 0..yMax on y (inverted; SVG y grows downward, so segments
  // are positioned from the bottom of the bar).
  return (
    <div className="flex gap-2">
      <YAxisLabels yTicks={geometry.yTicks} />
      <div className="flex-1">
        <svg
          viewBox="0 0 100 50"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Stacked time series across ${geometry.bars.length} ${bucket} buckets`}
          className="block h-60 w-full"
        >
          {[0, 25, 50].map((y) => (
            <line
              key={y}
              x1="0"
              x2="100"
              y1={y}
              y2={y}
              stroke="var(--color-outline-variant)"
              strokeWidth="0.2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {geometry.bars.map((bar) => (
            <g key={bar.bucket}>
              {bar.segments.map((seg) => {
                // Segment percentages map to the chart's 0..50 y-range
                // (top half holds the bar, bottom half is for x-axis labels).
                const segH = (seg.hPct / 100) * 50;
                const segY = 50 - (seg.yStartPct / 100) * 50 - segH;
                return (
                  <rect
                    key={seg.action}
                    x={bar.xPct - bar.widthPct / 2}
                    y={segY}
                    width={bar.widthPct}
                    height={segH}
                    fill={ACTION_COLOR[seg.action]}
                  >
                    <title>{seg.label}</title>
                  </rect>
                );
              })}
            </g>
          ))}
        </svg>
        <div
          aria-hidden="true"
          className="mt-1 flex justify-between text-[0.72rem] text-on-surface-variant"
        >
          {geometry.bars.map((bar, i) => (
            <span key={bar.bucket} className="flex-1 text-center tabular-nums">
              {i % tickStride === 0 ? formatBucketLabel(bar.bucket, bucket) : ""}
            </span>
          ))}
        </div>
        <Legend />
      </div>
    </div>
  );
}

function YAxisLabels({ yTicks }: { yTicks: number[] }) {
  // yTicks come back lowest-to-highest. Render them top-to-bottom (reverse)
  // so the visual axis matches the chart's inverted SVG y-coordinate.
  const reversed = [...yTicks].reverse();
  return (
    <div
      aria-hidden="true"
      className="flex h-60 min-w-7 flex-col justify-between pr-1 text-right text-[0.7rem] text-on-surface-variant tabular-nums"
    >
      {reversed.map((tick, i) => (
        <span key={i}>{tick.toLocaleString()}</span>
      ))}
    </div>
  );
}

function computeXTickStride(barCount: number): number {
  // Aim for ≤8 visible labels regardless of bar count. 24h hourly = 24
  // bars → stride 3 (8 labels). 30d daily = 30 → stride 4 (~8 labels).
  // 7d daily = 7 → stride 1 (every bar).
  return Math.max(1, Math.ceil(barCount / 8));
}

function Legend() {
  return (
    <div
      role="list"
      aria-label="action legend"
      className="mt-2.5 flex flex-wrap items-center gap-3"
    >
      {TIME_SERIES_ACTIONS.map((action) => (
        <span
          key={action}
          role="listitem"
          className="inline-flex items-center gap-1.5 text-[0.78rem] text-on-surface-variant"
        >
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-sm"
            style={{ background: ACTION_COLOR[action] }}
          />
          {ACTION_LABEL[action]}
        </span>
      ))}
    </div>
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
  const segments = buildDonutSegments(rows);
  const total = rows.reduce((sum, r) => sum + r.count, 0);

  return (
    <article className={STAT_CARD}>
      <p className={SECTION_LABEL}>By entity type</p>
      {segments.length === 0 ? (
        <p className={`${HINT} mt-2`}>No findings detected in this range.</p>
      ) : (
        <div className="mt-3 flex items-center gap-4">
          <svg
            viewBox="0 0 100 100"
            role="img"
            aria-label={`Donut: ${total} findings across ${segments.length} entity types`}
            className="aspect-square w-full max-w-[140px]"
          >
            {segments.map((seg) => {
              const color = entityColor(seg.entityType, allEntities);
              if (seg.isFullCircle) {
                return (
                  <circle key={seg.entityType} cx="50" cy="50" r="40" fill={color}>
                    <title>{`${seg.entityType}: ${buildSegmentTooltip(seg.count, total)}`}</title>
                  </circle>
                );
              }
              return (
                <path key={seg.entityType} d={seg.pathD} fill={color}>
                  <title>{`${seg.entityType}: ${buildSegmentTooltip(seg.count, total)}`}</title>
                </path>
              );
            })}
            {/* Inner ring cutout — gives the donut its hole. Sits on top
                of the wedges with the card's surface color so the
                stacking order produces the cutout effect without masks. */}
            <circle cx="50" cy="50" r="22" fill="var(--color-surface-container-lowest)" />
          </svg>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[0.78rem] text-on-surface-variant">
            {segments.map((seg) => (
              <li key={seg.entityType} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-sm"
                  style={{ background: entityColor(seg.entityType, allEntities) }}
                />
                <span>
                  {seg.entityType}: {seg.count} ({seg.percentage}%)
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
