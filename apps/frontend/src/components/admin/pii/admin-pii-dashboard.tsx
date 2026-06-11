"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { getAdminPiiMetrics } from "../../../lib/admin-api";
import {
  computeDelta,
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
    refetchOnWindowFocus: true
  });

  // Surgical refresh: invalidate only entries scoped to the current range.
  // The predicate matches any cache key whose params object carries the
  // active range — preserves cached data for inactive ranges so toggling
  // the time selector doesn't refetch from a Refresh click on a different
  // range. groupBy / actions / limit live inside the params object and
  // are matched by prefix automatically.
  const refresh = () => {
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (!Array.isArray(key) || key.length < 4) return false;
        if (key[0] !== "admin" || key[1] !== "pii") return false;
        if (
          key[2] !== "metrics" &&
          key[2] !== "top" &&
          key[2] !== "recent" &&
          key[2] !== "jobs/stats"
        ) {
          return false;
        }
        const keyParams = key[key.length - 1] as { range?: string; from?: string; to?: string } | undefined;
        if (!keyParams || typeof keyParams !== "object") return false;
        return (
          keyParams.range === params.range &&
          keyParams.from === params.from &&
          keyParams.to === params.to
        );
      }
    });
  };

  const data = metricsQuery.data ?? null;
  const isLoading = metricsQuery.isLoading;

  return (
    <section id="pii" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className={SECTION_LABEL}>Activity</p>
          <h3 className="text-lg font-semibold text-on-surface">PII activity</h3>
        </div>
        <Button type="button" variant="ghost" onClick={refresh}>
          Refresh
        </Button>
      </div>

      <HeaderStrip
        data={data}
        range={range}
        onRangeChange={setRange}
        loading={isLoading}
      />

      {metricsQuery.error ? (
        <p className="text-sm text-danger">{(metricsQuery.error as Error).message}</p>
      ) : null}

      <KpiRow data={data} loading={isLoading} />

      <Card aria-label="pii-time-series">
        <CardHeader>
          <p className={SECTION_LABEL}>Activity over time</p>
        </CardHeader>
        <CardContent>
          {data ? (
            <TimeSeriesChart series={data.timeSeries} bucket={data.range.bucket} />
          ) : (
            <p className={HINT}>Loading…</p>
          )}
        </CardContent>
      </Card>

      <Card aria-label="pii-findings">
        <CardHeader>
          <p className={SECTION_LABEL}>Findings breakdown</p>
        </CardHeader>
        <CardContent>
          {data ? <FindingsBreakdown data={data} /> : <p className={HINT}>Loading…</p>}
        </CardContent>
      </Card>

      <TopOffenders {...params} />
      <RecentActivityFeed {...params} />
      <OpsHealthPanel {...params} />
    </section>
  );
}

function HeaderStrip(props: {
  data: PiiActivityMetrics | null;
  range: RangeState;
  onRangeChange: (next: RangeState) => void;
  loading: boolean;
}) {
  const policy = props.data?.policy;
  const modeLabel = policy?.enabled ? policy.mode : "off";
  const modePill = policy?.enabled && policy.mode !== "off" ? PILL_GREEN : PILL_GRAY;

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={modePill}>mode: {modeLabel}</span>
            <PiiProviderStatusPill />
            {policy ? <ScopesPill policy={policy} /> : null}
          </div>
          <RangeSelector
            range={props.range}
            onChange={props.onRangeChange}
            disabled={props.loading}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ScopesPill({ policy }: { policy: NonNullable<PiiActivityMetrics["policy"]> }) {
  const enabled: string[] = [];
  if (policy.scopes.chatPrompts) enabled.push("chat");
  if (policy.scopes.uploads) enabled.push("uploads");
  if (policy.scopes.microsoftImports) enabled.push("microsoft");
  return (
    <span className={PILL_GRAY}>
      scopes: {enabled.length > 0 ? enabled.join(" • ") : "none"}
    </span>
  );
}

function RangeSelector(props: {
  range: RangeState;
  onChange: (next: RangeState) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="time range">
      {PRESET_OPTIONS.map((opt) => {
        const active = props.range.preset === opt.value;
        // Reuses the existing pill primitives. The active preset shows a
        // saturated green pill; inactive presets render in the gray
        // variant — same convention as the mode/scopes pills.
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
