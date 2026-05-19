"use client";

import { AdminSessionAlertBadge } from "./admin-session-alert-badge";
import type { AdminSessionRow } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const PILL_BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const PILL_GREEN = `${PILL_BASE} bg-success-surface text-success`;
const HINT = "text-sm text-on-surface-faint";
const LIST_ITEM =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-3 transition-colors hover:border-outline";

function formatDateTime(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function statusBadgeClass(status: AdminSessionRow["status"]): string {
  switch (status) {
    case "active":
      return PILL_GREEN;
    case "errored":
    default:
      return PILL_GRAY;
  }
}

function runtimeLabel(provider: AdminSessionRow["runtimeProvider"]): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex") return "Codex";
  return "—";
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

function SessionsHeader(props: { count: number; hasMore?: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className={SECTION_LABEL}>Review</p>
        <h2 className="text-lg font-semibold text-on-surface">Sessions</h2>
        <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
          {SECTION_DESCRIPTION}
        </p>
      </div>
      <span className={PILL_GRAY}>
        Showing {props.count} session{props.count === 1 ? "" : "s"}
        {props.hasMore ? "+" : ""}
      </span>
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
}) {
  if (props.isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className={HINT}>Loading sessions…</p>
        </CardContent>
      </Card>
    );
  }

  if (props.sessions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <SessionsHeader count={0} />
        </CardHeader>
        <CardContent>
          <p className={HINT}>
            No sessions found. Sessions appear here once users start conversations.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <SessionsHeader count={props.sessions.length} hasMore={props.hasMore} />
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          {props.sessions.map((row) => {
            const interactive = props.onRowClick != null;
            const handleActivate = () => {
              if (interactive) props.onRowClick?.(row.sessionId);
            };
            return (
              <div
                className={`${LIST_ITEM} ${interactive ? "cursor-pointer" : ""}`}
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
                    <span className={PILL_GRAY}>{runtimeLabel(row.runtimeProvider)}</span>
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
                  {formatDateTime(row.createdAt)} · last activity{" "}
                  {formatDateTime(row.lastActivityAt)}
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

        {props.hasMore && props.onLoadMore ? (
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
