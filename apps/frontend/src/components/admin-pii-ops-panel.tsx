"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getAdminPiiJobsStats } from "../lib/admin-api";
import {
  breakerStatePillClass,
  formatLatency,
  formatRelativeTime,
  formatTimestamp,
  readPersistedBoolean,
  writePersistedBoolean
} from "../lib/admin-pii-utils";
import type {
  PiiBreakerTransitionEvent,
  PiiJobsStatsResponse,
  PiiLatencyRow,
  PiiQueueStats,
  PiiRangePreset
} from "@cogniplane/shared-types";
import { queryKeys } from "../lib/query-keys";
import { Card, CardContent } from "@/components/ui/card";

const STORAGE_KEY = "cogniplane:admin-pii-ops-panel:expanded";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const PILL_BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const PILL_RED = `${PILL_BASE} bg-danger-surface text-danger`;
const HINT = "text-sm text-on-surface-faint";
const LIST_ITEM =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-3";
const STAT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4";
const OVERVIEW_GRID =
  "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4";

type Props = {
  range: PiiRangePreset;
  from?: string;
  to?: string;
};

/**
 * Ops panel collapses by default — the data is operator-flavored and
 * the privacy officer view doesn't need it. Persisted across sessions
 * via localStorage so an SRE who keeps it open between visits doesn't
 * have to re-expand each time.
 *
 * Hydration safety: the initial state is always `false` on both server
 * and client. We read localStorage in a useEffect after mount and
 * promote to `true` if the user previously expanded — same pattern as
 * chat-shell's artifact-pane width persistence. The trade-off is a
 * one-frame flash of "collapsed" before the saved state kicks in.
 */
export function OpsHealthPanel(props: Props) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // SSR-safe localStorage hydration: lazy init would cause hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(readPersistedBoolean(window.localStorage, STORAGE_KEY, false));
  }, []);

  const toggle = () => {
    setExpanded((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        writePersistedBoolean(window.localStorage, STORAGE_KEY, next);
      }
      return next;
    });
  };

  const params = { range: props.range, from: props.from, to: props.to };
  const statsQuery = useQuery({
    queryKey: queryKeys.admin.piiJobsStats(params),
    queryFn: () => getAdminPiiJobsStats(params),
    refetchOnWindowFocus: true,
    // Skip the network call when collapsed — the endpoint reads
    // platform_events and pii_scan_jobs/runs aggregates, not free.
    enabled: expanded
  });

  const data = statsQuery.data ?? null;

  return (
    <Card aria-label="pii-ops">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls="pii-ops-panel-content"
        className="flex w-full cursor-pointer items-start justify-between gap-3 px-6 text-left"
      >
        <div>
          <p className={SECTION_LABEL}>Operational health</p>
          <p className="mt-1 text-sm text-on-surface-faint">
            {expanded
              ? "Hide queue, latency, breaker timeline"
              : "Show queue, latency, breaker timeline"}
          </p>
        </div>
        <span className={PILL_GRAY} aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded ? (
        <CardContent>
          <div id="pii-ops-panel-content" role="region" aria-label="Operational health">
            {statsQuery.isLoading ? (
              <p className={HINT}>Loading…</p>
            ) : statsQuery.error ? (
              <p className="text-sm text-danger">{(statsQuery.error as Error).message}</p>
            ) : !data ? (
              <p className={HINT}>Operational stats unavailable.</p>
            ) : (
              <OpsContent data={data} />
            )}
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

function OpsContent({ data }: { data: PiiJobsStatsResponse }) {
  return (
    <div className="flex flex-col gap-5">
      <QueueStatsRow queue={data.queue} />
      <LatencyTable rows={data.latency} />
      <TopErrorsList rows={data.topErrors} />
      <BreakerTimeline events={data.breakerTimeline} />
    </div>
  );
}

function StatCard(props: {
  label: string;
  value: string;
  detail: string;
}) {
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

function QueueStatsRow({ queue }: { queue: PiiQueueStats }) {
  return (
    <div>
      <p className={`${SECTION_LABEL} mb-2`}>Job queue (point-in-time)</p>
      <div className={OVERVIEW_GRID}>
        <StatCard
          label="Queued"
          value={queue.queued.toLocaleString()}
          detail={
            queue.oldestQueuedAt
              ? `oldest ${formatRelativeTime(queue.oldestQueuedAt)}`
              : "no backlog"
          }
        />
        <StatCard label="Claimed" value={queue.claimed.toLocaleString()} detail="in flight" />
        <StatCard
          label="Completed"
          value={queue.completed.toLocaleString()}
          detail="lifetime"
        />
        <StatCard
          label="Failed"
          value={queue.failed.toLocaleString()}
          detail={
            queue.maxAttemptsHit > 0
              ? `${queue.maxAttemptsHit} hit max attempts`
              : "no max-attempt failures"
          }
        />
      </div>
    </div>
  );
}

function LatencyTable({ rows }: { rows: PiiLatencyRow[] }) {
  return (
    <div>
      <p className={`${SECTION_LABEL} mb-2`}>
        Scan latency (completed / blocked / transformed only)
      </p>
      {rows.length === 0 ? (
        <p className={HINT}>No completed scans in this range.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div className={LIST_ITEM} key={row.subjectType}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm font-semibold text-on-surface">
                  {row.subjectType === "message" ? "Chat messages" : "Artifacts"}
                </strong>
                <span className={PILL_GRAY}>n={row.sampleCount}</span>
              </div>
              <p className="mt-1 text-xs text-on-surface-faint tabular-nums">
                p50 {formatLatency(row.p50Ms)} • p95 {formatLatency(row.p95Ms)} • p99{" "}
                {formatLatency(row.p99Ms)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TopErrorsList({ rows }: { rows: PiiJobsStatsResponse["topErrors"] }) {
  return (
    <div>
      <p className={`${SECTION_LABEL} mb-2`}>Top errors</p>
      {rows.length === 0 ? (
        <p className={HINT}>No failed scans in this range.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <div className={LIST_ITEM} key={`${i}-${row.message}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm font-semibold break-words text-on-surface">
                  {row.message}
                </strong>
                <span className={PILL_RED}>{row.count.toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BreakerTimeline({ events }: { events: PiiBreakerTransitionEvent[] }) {
  return (
    <div>
      <p className={`${SECTION_LABEL} mb-2`}>Breaker transitions (newest first)</p>
      {events.length === 0 ? (
        <p className={HINT}>No breaker transitions in this range.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map((event, i) => (
            <div className={LIST_ITEM} key={`${event.at}-${i}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={breakerStatePillClass(event.from)}>{event.from}</span>
                  <span aria-hidden="true" className="text-on-surface-variant">
                    →
                  </span>
                  <span className={breakerStatePillClass(event.to)}>{event.to}</span>
                </div>
                <span
                  className="text-xs text-on-surface-faint tabular-nums"
                  title={formatTimestamp(event.at)}
                >
                  {formatRelativeTime(event.at)}
                </span>
              </div>
              <p className="mt-1 text-xs text-on-surface-faint">
                {event.provider}
                {event.failureCount > 0
                  ? ` • ${event.failureCount} failure${event.failureCount === 1 ? "" : "s"} in window`
                  : ""}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
