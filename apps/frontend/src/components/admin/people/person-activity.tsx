"use client";

import Link from "next/link";
import type { UseQueryResult } from "@tanstack/react-query";
import type { AdminSessionRow, AdminSessionsListResponse } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "../../../lib/admin-pii-utils";
import { sessionDetailHref } from "../../../lib/admin-session-links";
import { toErrorMessage } from "../../../lib/error-utils";
import { formatTimestamp } from "../../../lib/time-format";
import type { MemberMonthUsage } from "../../../lib/token-usage-api";
import { PILL_GRAY, PILL_RED, SECTION_LABEL } from "../../../lib/ui-tokens";
import { fmtCost, fmtTokens, HBar } from "../../token-usage-chart-primitives";
import { AdminSessionAlertBadge } from "../sessions/admin-session-alert-badge";

function monthLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "This month";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

function LoadFailure({ what, error, retry }: { what: string; error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg bg-surface-container-low px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-danger">
        Could not load {what}. {toErrorMessage(error, "")}
      </p>
      <Button variant="outline" size="sm" onClick={retry}>Retry</Button>
    </div>
  );
}

function Figure({ label, value, detail, title }: { label: string; value: string; detail: string; title?: string }) {
  return (
    <div className="min-w-0 py-3 sm:px-5 sm:first:pl-0">
      <dt className={SECTION_LABEL}>{label}</dt>
      <dd className="mt-1.5 text-3xl font-semibold tracking-tight text-on-surface tabular-nums" title={title}>{value}</dd>
      <dd className="mt-1 text-xs text-on-surface-variant">{detail}</dd>
    </div>
  );
}

function MonthUsage({ query }: { query: UseQueryResult<MemberMonthUsage> }) {
  if (query.isPending) {
    return (
      <div role="status" aria-label="Loading usage" className="grid gap-4 py-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}
      </div>
    );
  }
  if (query.isError) {
    return <LoadFailure what="usage" error={query.error} retry={() => void query.refetch()} />;
  }

  const { usage, range } = query.data;
  const { totals } = usage;
  const maxModelTokens = Math.max(0, ...usage.byModel.map((row) => row.totalTokens));
  return (
    <div>
      <p className="text-sm text-on-surface-variant">
        {monthLabel(range.from)}, UTC. Counts agent replies that recorded token usage.
      </p>
      <dl className="mt-2 grid grid-cols-1 divide-y divide-outline-variant sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Figure
          label="Tokens"
          value={fmtTokens(totals.totalTokens)}
          title={`${totals.totalTokens.toLocaleString()} tokens`}
          detail={`${fmtTokens(totals.inputTokens)} in, ${fmtTokens(totals.outputTokens)} out`}
        />
        <Figure label="Est. cost" value={fmtCost(totals.costUsd)} detail="From model prices, not an invoice" />
        <Figure
          label="Replies"
          value={totals.messageCount.toLocaleString()}
          detail={totals.messageCount === 1 ? "Agent reply" : "Agent replies"}
        />
      </dl>
      {usage.byModel.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">By model</h4>
          <ul className="mt-2 flex flex-col gap-2">
            {usage.byModel.map((row) => (
              <li key={row.modelName} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto_auto]">
                <span className="truncate text-on-surface" title={row.modelName}>{row.modelName}</span>
                <span className="hidden sm:flex"><HBar value={row.totalTokens} max={maxModelTokens} color="var(--chart-1)" /></span>
                <span className="text-right tabular-nums text-on-surface-variant">{fmtTokens(row.totalTokens)}</span>
                <span className="hidden text-right tabular-nums text-on-surface-faint sm:inline">{fmtCost(row.costUsd)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-sm text-on-surface-faint">No model usage recorded this month.</p>
      )}
    </div>
  );
}

export function sessionHref(sessionId: string, userId: string): string {
  // The detail page's back link returns to the sessions list with this filter.
  return sessionDetailHref(sessionId, new URLSearchParams({ userId }).toString());
}

export function allSessionsHref(userId: string): string {
  return `/admin/sessions?${new URLSearchParams({ userId }).toString()}`;
}

function SessionRow({ row, userId }: { row: AdminSessionRow; userId: string }) {
  return (
    <li>
      <Link
        href={sessionHref(row.sessionId, userId)}
        className="group -mx-2 flex flex-col gap-1.5 rounded-md px-2 py-3 outline-none transition-colors hover:bg-surface-container-low focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="text-sm font-medium text-on-surface group-hover:underline group-hover:underline-offset-4">
            {row.messageCount} message{row.messageCount === 1 ? "" : "s"}
            {row.modelName ? <span className="font-normal text-on-surface-variant"> with {row.modelName}</span> : null}
          </span>
          <time dateTime={row.lastActivityAt} title={formatTimestamp(row.lastActivityAt)} className="text-xs text-on-surface-variant tabular-nums">
            Active {formatRelativeTime(row.lastActivityAt)}
          </time>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[0.7rem] text-on-surface-faint">{row.sessionId}</span>
          {/* The alerts usually include "errored" for an errored session. Show the badge once. */}
          {row.status === "errored" && !row.alerts.some((alert) => alert.kind === "errored") ? <span className={PILL_RED}>Errored</span> : null}
          {row.skillsUsedCount > 0 ? <span className={PILL_GRAY}>{row.skillsUsedCount} skill{row.skillsUsedCount === 1 ? "" : "s"}</span> : null}
          {row.mcpServersUsedCount > 0 ? <span className={PILL_GRAY}>{row.mcpServersUsedCount} connection{row.mcpServersUsedCount === 1 ? "" : "s"}</span> : null}
          {row.alerts.map((alert) => <AdminSessionAlertBadge key={alert.kind} alert={alert} />)}
        </span>
      </Link>
    </li>
  );
}

function RecentSessions({ query, userId, firstName }: {
  query: UseQueryResult<AdminSessionsListResponse>;
  userId: string;
  firstName: string;
}) {
  if (query.isPending) {
    return (
      <div role="status" aria-label="Loading sessions" className="flex flex-col gap-3 py-3">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}
      </div>
    );
  }
  if (query.isError) {
    return <LoadFailure what="sessions" error={query.error} retry={() => void query.refetch()} />;
  }
  const rows = query.data.items;
  return (
    <div>
      {rows.length === 0 ? (
        <p className="py-3 text-sm text-on-surface-faint">No sessions yet.</p>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {rows.map((row) => <SessionRow key={row.sessionId} row={row} userId={userId} />)}
        </ul>
      )}
      <Link
        href={allSessionsHref(userId)}
        className="mt-3 inline-block rounded-sm text-sm font-medium text-info underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        All sessions by {firstName}
      </Link>
    </div>
  );
}

export function PersonActivity(props: {
  userId: string;
  firstName: string;
  usage: UseQueryResult<MemberMonthUsage>;
  sessions: UseQueryResult<AdminSessionsListResponse>;
}) {
  return (
    <div className="min-w-0">
      <div>
        <h3 className="text-sm font-semibold text-on-surface">This month</h3>
        <div className="mt-1"><MonthUsage query={props.usage} /></div>
      </div>
      <div className="mt-8 border-t border-outline-variant pt-5">
        <h3 className="text-sm font-semibold text-on-surface">Recent sessions</h3>
        <RecentSessions query={props.sessions} userId={props.userId} firstName={props.firstName} />
      </div>
    </div>
  );
}
