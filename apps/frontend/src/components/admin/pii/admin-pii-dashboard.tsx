"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";

import { getAdminPiiMetrics } from "../../../lib/admin-api";
import {
  computeDelta,
  isPiiRangeQueryKey,
  sparklineFromTimeSeries,
  type PiiKpiKey
} from "../../../lib/admin-pii-utils";
import type { PiiActivityMetrics, PiiRangePreset } from "@cogniplane/shared-types";
import { queryKeys } from "../../../lib/query-keys";
import { FindingsBreakdown, TimeSeriesChart } from "./admin-pii-charts";
import { OpsHealthPanel } from "./admin-pii-ops-panel";
import { RecentActivityFeed, TopOffenders } from "./admin-pii-tables";
import { PiiProviderStatusPill } from "../../pii-provider-status-pill";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PILL_GRAY, PILL_GREEN, HINT, SECTION_LABEL } from "../../../lib/ui-tokens";

const MODE_LABELS = { off: "Off", detect: "Detect", block: "Block", transform: "Transform" } as const;

type RangeState =
  | { preset: "24h" | "7d" | "30d" }
  | { preset: "custom"; from: string; to: string };

const PRESET_OPTIONS: Array<{ value: "24h" | "7d" | "30d"; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" }
];

const KPI_DEFINITIONS: Array<{ key: PiiKpiKey; label: string; tone: "neutral" | "warn" }> = [
  { key: "scans", label: "Scans", tone: "neutral" },
  { key: "findings", label: "Findings", tone: "neutral" },
  { key: "blocked", label: "Blocked", tone: "warn" },
  { key: "transformed", label: "Transformed", tone: "warn" },
  { key: "failed", label: "Failed", tone: "warn" }
];

const STAT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4";

function rangeQueryParams(range: RangeState): { range: PiiRangePreset; from?: string; to?: string } {
  return range.preset === "custom"
    ? { range: "custom", from: range.from, to: range.to }
    : { range: range.preset };
}

export function AdminPiiDashboard() {
  const queryClient = useQueryClient();
  const [range, setRange] = useState<RangeState>({ preset: "7d" });

  const params = rangeQueryParams(range);
  const metricsQuery = useQuery({
    queryKey: queryKeys.admin.piiMetrics(params),
    queryFn: () => getAdminPiiMetrics(params),
    // Dashboard polls on focus — overrides the global default of false.
    refetchOnWindowFocus: true,
    // Keep the last range on screen while the next one loads, so the page does not flash.
    placeholderData: (previous) => previous
  });

  // Surgical refresh: invalidate only entries scoped to the current range, so
  // cached data for other ranges survives a Refresh click.
  const refresh = () => {
    void queryClient.invalidateQueries({ predicate: (query) => isPiiRangeQueryKey(query.queryKey, params) });
  };

  const data = metricsQuery.data ?? null;
  const isLoading = metricsQuery.isLoading;

  const policy = data?.policy;
  const off = Boolean(policy) && (!policy!.enabled || policy!.mode === "off");
  // With protection off and no scans in the range, every number is zero. Say why instead.
  const nothingToShow = off && (data?.kpis.scans.current ?? 0) === 0;

  return (
    <section id="pii" className="flex flex-col gap-5 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-on-surface-variant">
          <p>{policy ? policySentence(policy) : isLoading ? "Loading activity..." : ""}</p>
          <PiiProviderStatusPill />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangeSelector range={range} onChange={setRange} disabled={isLoading} />
          <Button type="button" variant="ghost" size="sm" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {metricsQuery.error ? (
        <p role="alert" className="text-sm text-danger">{(metricsQuery.error as Error).message}</p>
      ) : null}

      {nothingToShow ? (
        <p className="border-y border-outline-variant py-4 text-sm text-on-surface-variant">
          Protection is off, so nothing is scanned.{" "}
          <Link href="/admin/privacy" className="underline underline-offset-4">Turn it on in Settings</Link>.
        </p>
      ) : (
        <>
          <KpiRow data={data} loading={isLoading} />

          <Card>
            <CardHeader>
              <h2 id="pii-time-series-title" className="text-base font-semibold text-on-surface">Activity over time</h2>
            </CardHeader>
            <CardContent>
              {data ? (
                <TimeSeriesChart series={data.timeSeries} bucket={data.range.bucket} />
              ) : (
                <p className={HINT}>Loading…</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h2 id="pii-findings-title" className="text-base font-semibold text-on-surface">Findings breakdown</h2>
            </CardHeader>
            <CardContent>
              {data ? <FindingsBreakdown data={data} /> : <p className={HINT}>Loading…</p>}
            </CardContent>
          </Card>

          <TopOffenders {...params} />
          <RecentActivityFeed {...params} />
          <OpsHealthPanel {...params} />
        </>
      )}
    </section>
  );
}

/** "Detect mode. Scans chat prompts and uploads." in the words the Settings tab uses. */
function policySentence(policy: NonNullable<PiiActivityMetrics["policy"]>): string {
  if (!policy.enabled || policy.mode === "off") return "Protection is off.";
  const sources = [
    policy.scopes.chatPrompts ? "chat prompts" : null,
    policy.scopes.uploads ? "direct uploads" : null,
    policy.scopes.microsoftImports ? "Microsoft imports" : null
  ].filter((source): source is string => source !== null);
  const scans = sources.length === 0
    ? "No chat prompts, uploads, or imports are scanned."
    : `Scans ${sources.join(", ").replace(/, ([^,]*)$/, " and $1")}.`;
  return `${MODE_LABELS[policy.mode]} mode. ${scans}`;
}

function RangeSelector(props: {
  range: RangeState;
  onChange: (next: RangeState) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Time range">
      {PRESET_OPTIONS.map((opt) => {
        const active = props.range.preset === opt.value;
        // Reuses the pill primitives. The active preset shows a green pill;
        // inactive presets render in gray.
        return (
          <button
            key={opt.value}
            type="button"
            disabled={props.disabled}
            aria-pressed={active}
            onClick={() => props.onChange({ preset: opt.value })}
            className={`${active ? PILL_GREEN : PILL_GRAY} cursor-pointer border-0 disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function KpiRow({
  data,
  loading
}: {
  data: PiiActivityMetrics | null;
  loading: boolean;
}) {
  const series = data?.timeSeries ?? [];
  return (
    <div
      role="list"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
    >
      {KPI_DEFINITIONS.map(({ key, label, tone }) => {
        const kpi = data?.kpis[key];
        const sparkline =
          key === "findings" ? null : sparklineFromTimeSeries(series, key);
        return (
          <KpiTile
            key={key}
            label={label}
            tone={tone}
            current={kpi?.current ?? 0}
            previous={kpi?.previous ?? 0}
            sparkline={sparkline}
            loading={loading}
          />
        );
      })}
    </div>
  );
}

function KpiTile(props: {
  label: string;
  tone: "neutral" | "warn";
  current: number;
  previous: number;
  sparkline: number[] | null;
  loading: boolean;
}) {
  const delta = computeDelta(props.current, props.previous);
  const deltaLabel =
    delta.direction === "new"
      ? "new"
      : delta.direction === "flat"
        ? "—"
        : `${delta.pct! > 0 ? "+" : ""}${delta.pct}%`;
  // For warn-tone tiles (Blocked / Transformed / Failed), an UP delta is
  // bad and a DOWN delta is good — flip the color tokens. Neutral-tone
  // tiles (Scans / Findings) follow the literal sign.
  const deltaColor =
    delta.direction === "flat" || delta.direction === "new"
      ? "var(--color-on-surface-variant)"
      : (delta.direction === "up") === (props.tone === "warn")
        ? "var(--color-warning)"
        : "var(--color-success)";

  return (
    <article role="listitem" className={STAT_CARD}>
      <p className={SECTION_LABEL}>{props.label}</p>
      <strong className="mt-2 block text-2xl font-bold tracking-tight text-on-surface tabular-nums">
        {props.loading ? "—" : props.current.toLocaleString()}
      </strong>
      <p
        className="m-0 text-xs tabular-nums"
        style={{ color: deltaColor }}
      >
        {props.loading ? "" : deltaLabel}
      </p>
      {props.sparkline && props.sparkline.length >= 2 ? (
        <Sparkline values={props.sparkline} tone={props.tone} />
      ) : null}
    </article>
  );
}

/**
 * Inline-SVG sparkline. No charting library — keeps the bundle the same
 * size it is today. The line is normalized to a 100×24 viewBox; CSS sizes
 * the rendered SVG by giving it 100% width and a fixed pixel height.
 */
function Sparkline({ values, tone }: { values: number[]; tone: "neutral" | "warn" }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const stepX = 100 / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(2)},${(24 - (v / max) * 24).toFixed(2)}`)
    .join(" ");
  const stroke = tone === "warn" ? "var(--color-warning)" : "var(--color-on-surface-variant)";
  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="mt-2 block h-6 w-full"
    >
      <polyline fill="none" stroke={stroke} strokeWidth="1.5" points={points} />
    </svg>
  );
}
