"use client";

import { useEffect, useRef } from "react";

import { AdminSessionAlertBadge } from "./admin-session-alert-badge";
import type { AdminSessionRow } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTimestamp } from "../../../lib/time-format";
import { PILL_GRAY, PILL_GREEN, HINT, LIST_ITEM } from "../../../lib/ui-tokens";

const LIST_ITEM_HOVER = `${LIST_ITEM} hover-lift hover:border-outline`;

function statusBadgeClass(status: AdminSessionRow["status"]): string {
  switch (status) {
    case "active":
      return PILL_GREEN;
    case "errored":
    default:
      return PILL_GRAY;
  }
}

function userDisplay(row: AdminSessionRow): string {
  return row.userEmail ?? row.userId;
}

// Every non-deleted session is openable. Sessions land in `active` on creation
// and only the detail endpoint can decide what to render for in-flight ones.
export function isSessionRowClickable(_row: AdminSessionRow): boolean {
  return true;
}

const SECTION_DESCRIPTION =
  "Inspect chat sessions across the tenant. Filter by user, date, and alert type to investigate incidents.";

function SessionsHeader(props: { count?: number; hasMore?: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 tabIndex={-1} className="scroll-mt-2 rounded-sm text-lg font-semibold text-on-surface outline-none focus:ring-[3px] focus:ring-ring/50">Sessions</h2>
        <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
          {SECTION_DESCRIPTION}
        </p>
      </div>
      {props.count !== undefined ? <span className={PILL_GRAY}>
        Showing {props.count} session{props.count === 1 ? "" : "s"}
        {props.hasMore ? "+" : ""}
      </span> : null}
    </div>
  );
}

export function AdminSessionsSection(props: {
  sessions: AdminSessionRow[];
  isLoading: boolean;
  onRowClick?: (sessionId: string) => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  hasData?: boolean;
  error?: string | null;
  available?: boolean;
  isRefreshing?: boolean;
  isFiltered?: boolean;
  onRetry?: () => void;
}) {
  const section = useRef<HTMLDivElement>(null);
  const retryOwner = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!props.isRefreshing && !props.error && retryOwner.current) {
      if (document.activeElement === retryOwner.current) section.current?.querySelector<HTMLElement>("h2")?.focus();
      retryOwner.current = null;
    }
  }, [props.isRefreshing, props.error]);
  const hasData = props.hasData ?? !props.isLoading;
  const showRows = hasData && props.available !== false;
  const feedback = props.error || (props.onRetry && !props.isLoading && props.available !== false) ? (
    <div className="mb-4 space-y-2">
      {props.error ? <p role="alert" className="text-sm text-danger">{showRows ? "Sessions could not be updated. The loaded results remain below. " : ""}{props.error}</p> : null}
      {props.onRetry ? <Button type="button" variant="outline" aria-disabled={props.isRefreshing} aria-busy={props.isRefreshing} className="min-w-36" onClick={event => { if (!props.isRefreshing) { retryOwner.current = event.currentTarget; props.onRetry?.(); } }}>{props.isRefreshing ? "Reloading…" : "Reload sessions"}</Button> : null}
    </div>
  ) : null;

  return (
    <Card ref={section}>
      <CardHeader>
        <SessionsHeader count={showRows ? props.sessions.length : undefined} hasMore={props.hasMore} />
      </CardHeader>
      <CardContent>
        {feedback}
        {props.isLoading && !hasData && !props.error ? <div role="status" aria-label="Loading sessions" className="space-y-3"><p className={HINT}>Loading sessions…</p>{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div> : null}
        {showRows && props.sessions.length === 0 ? <p className={HINT}>{props.isFiltered ? "No sessions match these filters. Change the filters to search another creation period, user or alert." : "No sessions found. Sessions appear here once users start conversations."}</p> : null}
        <div className="flex flex-col gap-2">
          {showRows && props.sessions.map((row) => {
            const interactive = props.onRowClick != null;
            const handleActivate = () => {
              if (interactive) props.onRowClick?.(row.sessionId);
            };
            return (
              <div
                className={`${LIST_ITEM_HOVER} break-words [overflow-wrap:anywhere] ${interactive ? "cursor-pointer" : ""}`}
                key={row.sessionId}
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? 0 : undefined}
                onClick={interactive ? handleActivate : undefined}
                onKeyDown={
                  interactive
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleActivate();
                        }
                      }
                    : undefined
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm font-semibold text-on-surface">
                    {userDisplay(row)}
                  </strong>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={statusBadgeClass(row.status)}>{row.status}</span>
                    {row.modelName ? <span className={PILL_GRAY}>{row.modelName}</span> : null}
                    <span
                      className={PILL_GRAY}
                      title="Distinct skills invoked in this session."
                    >
                      {row.skillsUsedCount} skill{row.skillsUsedCount === 1 ? "" : "s"}
                    </span>
                    <span
                      className={PILL_GRAY}
                      title="Distinct MCP servers invoked in this session."
                    >
                      {row.mcpServersUsedCount} MCP
                    </span>
                  </div>
                </div>
                <p className="mt-1 text-xs text-on-surface-faint">
                  {row.messageCount} message{row.messageCount === 1 ? "" : "s"} · started{" "}
                  {formatTimestamp(row.createdAt)} · last activity{" "}
                  {formatTimestamp(row.lastActivityAt)}
                </p>
                {row.alerts.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {row.alerts.map((alert) => (
                      <AdminSessionAlertBadge key={alert.kind} alert={alert} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {showRows && props.hasMore && props.onLoadMore ? (
          <div className="mt-3 text-center">
            <Button
              type="button"
              variant="ghost"
              onClick={props.onLoadMore}
              disabled={props.isLoadingMore}
            >
              {props.isLoadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
