"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { AdminSessionDetailOverview, AdminSessionDetailResponse } from "@cogniplane/shared-types";
import { AdminSessionDetailSidebar } from "./admin-session-detail-sidebar";
import { SessionCopyButton } from "./session-copy-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatTimestamp } from "../../../lib/time-format";
import { PILL_GRAY, PILL_GREEN, HINT, SECTION_LABEL } from "../../../lib/ui-tokens";

function statusBadgeClass(status: AdminSessionDetailOverview["status"]): string {
  switch (status) {
    case "active":
      return PILL_GREEN;
    case "errored":
    default:
      return PILL_GRAY;
  }
}

function HeaderStrip(props: { overview: AdminSessionDetailOverview; backHref: string }) {
  const { overview } = props;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={SECTION_LABEL}>
              <Link href={props.backHref} className="hover:underline">
                ← Back to sessions
              </Link>
            </p>
            <h3 className="break-words text-lg font-semibold text-on-surface">
              {overview.sessionName || "Session"}
            </h3>
            <p className="mt-1 text-sm text-on-surface-variant">
              {overview.userEmail ?? overview.userId} · started{" "}
              {formatTimestamp(overview.createdAt)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={statusBadgeClass(overview.status)}>{overview.status}</span>
            <SessionCopyButton value={overview.sessionId} label="Copy session ID" size="sm">Copy session ID</SessionCopyButton>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="break-all text-xs text-on-surface-faint">{overview.sessionId}</p>
      </CardContent>
    </Card>
  );
}

export function AdminSessionDetailView(props: {
  detail: AdminSessionDetailResponse | null;
  error: string | null;
  available: boolean;
  isNotFound: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  retry: () => void;
  backHref: string;
}) {
  const { detail, error, available, isNotFound, isLoading, isRefreshing, retry, backHref } = props;
  const heading = useRef<HTMLHeadingElement>(null);
  const retryOwner = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!isRefreshing && !error && detail && retryOwner.current) {
      if (document.activeElement === retryOwner.current) heading.current?.focus();
      retryOwner.current = null;
    }
  }, [isRefreshing, error, detail]);
  return (
    <section id="session-detail" className="flex flex-col gap-5">
      <div>
        <h2 ref={heading} tabIndex={-1} className="scroll-mt-2 rounded-sm text-lg font-semibold text-on-surface outline-none focus:ring-[3px] focus:ring-ring/50">Session detail</h2>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="pt-6">
            <p role="status" className={HINT}>Loading session…</p>
          </CardContent>
        </Card>
      ) : null}

      {!isLoading && isNotFound ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-danger">Session not found or not in your tenant.</p>
            <p className="mt-2 text-sm text-on-surface-variant">
              <Link href={backHref} className="text-info hover:underline">
                Back to sessions
              </Link>
            </p>
          </CardContent>
        </Card>
      ) : null}

      {error || detail ? <div className="space-y-2">{error ? <p role="alert" className="text-sm text-danger">{detail ? "Session detail could not be updated. The loaded evidence remains below. " : ""}{error}</p> : null}<Button variant="outline" className="min-w-36" aria-disabled={isRefreshing} aria-busy={isRefreshing} onClick={event => { if (!isRefreshing) { retryOwner.current = event.currentTarget; retry(); } }}>{isRefreshing ? "Reloading…" : "Reload session"}</Button></div> : null}

      {!isLoading && available && detail ? (
        <>
          <HeaderStrip overview={detail.overview} backHref={backHref} />

          <AdminSessionDetailSidebar key={detail.overview.sessionId} detail={detail} />
        </>
      ) : null}
    </section>
  );
}
