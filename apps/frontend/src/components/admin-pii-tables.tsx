"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import {
  formatRelativeTime,
  formatTimestamp,
  shortId,
  statusPillClass
} from "../lib/admin-pii-utils";
import { getAdminPiiRecent, getAdminPiiTop } from "../lib/admin-api";
import type {
  PiiRangePreset,
  PiiRecentResponse,
  PiiTopGroupBy,
  PiiTopSessionRow,
  PiiTopUserRow
} from "@cogniplane/shared-types";
import { queryKeys } from "../lib/query-keys";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type RangeProps = { range: PiiRangePreset; from?: string; to?: string };

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const PILL_BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_RED = `${PILL_BASE} bg-danger-surface text-danger`;
const PILL_BLUE = `${PILL_BASE} bg-accent-soft text-accent`;
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const TAB_ACTIVE = `${PILL_BLUE} cursor-pointer border-0`;
const TAB_INACTIVE = `${PILL_GRAY} cursor-pointer border-0`;
const HINT = "text-sm text-on-surface-faint";
const LIST_ITEM =
  "block rounded-lg border border-outline-variant bg-surface-container-lowest p-3 no-underline text-inherit transition-colors hover:border-outline";

// ─── TopOffenders ──────────────────────────────────────────────────────────

export function TopOffenders(props: RangeProps) {
  const [groupBy, setGroupBy] = useState<PiiTopGroupBy>("user");
  const params = { ...props, groupBy };

  const topQuery = useQuery({
    queryKey: queryKeys.admin.piiTop(params),
    queryFn: () => getAdminPiiTop(params),
    refetchOnWindowFocus: true
  });

  const data = topQuery.data ?? null;

  return (
    <Card aria-label="pii-top">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={SECTION_LABEL}>Top offenders</p>
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="group by">
            {(["user", "session"] as PiiTopGroupBy[]).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={groupBy === tab}
                onClick={() => setGroupBy(tab)}
                className={groupBy === tab ? TAB_ACTIVE : TAB_INACTIVE}
              >
                {tab === "user" ? "Users" : "Sessions"}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {topQuery.isLoading ? (
          <p className={HINT}>Loading…</p>
        ) : !data || data.rows.length === 0 ? (
          <p className={HINT}>
            {groupBy === "user"
              ? "No high-volume users in this range."
              : "No high-activity sessions in this range."}
          </p>
        ) : data.groupBy === "user" ? (
          <TopUserTable rows={data.rows} />
        ) : (
          <TopSessionTable rows={data.rows} />
        )}
      </CardContent>
    </Card>
  );
}

function TopUserTable({ rows }: { rows: PiiTopUserRow[] }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <Link
          // The admin users page reads `?userId=` to scroll the matching
          // row into view; that wiring lives in admin-users-section.tsx.
          href={`/admin/users?userId=${encodeURIComponent(row.userId)}`}
          key={row.userId}
          className={LIST_ITEM}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-sm font-semibold text-on-surface" title={row.userId}>
              {shortId(row.userId)}
            </strong>
            <div className="flex flex-wrap items-center gap-1.5">
              {row.blockCount > 0 ? (
                <span className={PILL_RED}>{row.blockCount} blocked</span>
              ) : null}
              {row.transformCount > 0 ? (
                <span className={PILL_BLUE}>{row.transformCount} transformed</span>
              ) : null}
              {row.failedCount > 0 ? (
                <span className={PILL_RED}>{row.failedCount} failed</span>
              ) : null}
            </div>
          </div>
          <p className="mt-1 text-xs text-on-surface-faint">
            {row.findingsTotal} finding{row.findingsTotal === 1 ? "" : "s"} across{" "}
            {row.sessionsCount} session{row.sessionsCount === 1 ? "" : "s"} •{" "}
            <span title={formatTimestamp(row.lastSeenAt)}>{formatRelativeTime(row.lastSeenAt)}</span>
          </p>
        </Link>
      ))}
    </div>
  );
}

function TopSessionTable({ rows }: { rows: PiiTopSessionRow[] }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <Link
          // ?tab=pii deep-links into the session sidebar's PII tab. The
          // sidebar component reads searchParams on mount and seeds its
          // initial tab — see admin-session-detail-sidebar.tsx.
          href={`/admin/sessions/${encodeURIComponent(row.sessionId)}?tab=pii`}
          key={row.sessionId}
          className={LIST_ITEM}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-sm font-semibold text-on-surface" title={row.sessionId}>
              {shortId(row.sessionId)}
            </strong>
            <div className="flex flex-wrap items-center gap-1.5">
              {row.actionMix.block > 0 ? (
                <span className={PILL_RED}>{row.actionMix.block} blocked</span>
              ) : null}
              {row.actionMix.transform > 0 ? (
                <span className={PILL_BLUE}>{row.actionMix.transform} transformed</span>
              ) : null}
              {row.actionMix.failed > 0 ? (
                <span className={PILL_RED}>{row.actionMix.failed} failed</span>
              ) : null}
            </div>
          </div>
          <p className="mt-1 text-xs text-on-surface-faint">
            {row.findingsTotal} finding{row.findingsTotal === 1 ? "" : "s"}
            {row.userId ? ` • user ${shortId(row.userId)}` : ""} •{" "}
            <span title={formatTimestamp(row.lastActivityAt)}>
              {formatRelativeTime(row.lastActivityAt)}
            </span>
          </p>
        </Link>
      ))}
    </div>
  );
}

// ─── RecentActivityFeed ────────────────────────────────────────────────────

export function RecentActivityFeed(props: RangeProps) {
  // Default actions match the backend's default (block/transform/failed) so
  // the cache key shape stays stable and we don't request a redundant
  // permutation. Custom action filtering is a follow-up.
  const params = { ...props };
  const recentQuery = useQuery({
    queryKey: queryKeys.admin.piiRecent(params),
    queryFn: () => getAdminPiiRecent(params),
    refetchOnWindowFocus: true
  });

  const data: PiiRecentResponse | null = recentQuery.data ?? null;

  return (
    <Card aria-label="pii-recent">
      <CardHeader>
        <p className={SECTION_LABEL}>Recent activity</p>
      </CardHeader>
      <CardContent>
        {recentQuery.isLoading ? (
          <p className={HINT}>Loading…</p>
        ) : !data || data.rows.length === 0 ? (
          <p className={HINT}>No blocked, transformed, or failed scans in this range.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {data.rows.map((row) => {
              const sessionHref = row.sessionId
                ? `/admin/sessions/${encodeURIComponent(row.sessionId)}?tab=pii`
                : null;
              const inner = (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm font-semibold text-on-surface" title={row.subjectId}>
                      {row.subjectType === "message" ? "Message" : "Artifact"} {shortId(row.subjectId)}
                    </strong>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={statusPillClass(row.status)}>{row.status}</span>
                      <span className={PILL_GRAY}>mode: {row.mode}</span>
                      {row.providerType ? (
                        <span className={PILL_GRAY}>{row.providerType}</span>
                      ) : null}
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-on-surface-faint">
                    {row.findingsCount} finding{row.findingsCount === 1 ? "" : "s"}
                    {row.entityTypes.length > 0 ? `: ${row.entityTypes.join(", ")}` : ""}
                    {row.errorMessage ? ` — ${row.errorMessage}` : ""}
                    {" • "}
                    <span title={formatTimestamp(row.createdAt)}>
                      {formatRelativeTime(row.createdAt)}
                    </span>
                  </p>
                </>
              );
              // When a row has a session id, deep-link to the session detail's
              // PII tab. Orphan scans (no session) — rare, but possible — render
              // as a plain non-clickable list item so the user isn't sent to a
              // 404.
              return sessionHref ? (
                <Link href={sessionHref} key={row.scanRunId} className={LIST_ITEM}>
                  {inner}
                </Link>
              ) : (
                <div
                  key={row.scanRunId}
                  className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3"
                >
                  {inner}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
