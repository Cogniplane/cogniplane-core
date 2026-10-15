"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";

import type { PolicyMonitorSummaryResponse, TenantSettings } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { OverviewRow } from "../overview-row";
import { REVIEW_ENFORCEMENT_HREF, plural } from "./policy-monitor.logic";

/** The Policy Center row on the Overview: mode, the Monitor count, and the way to the review. */
export function PolicyCenterRoutine({
  settings,
  summary
}: {
  settings: Pick<UseQueryResult<TenantSettings>, "data" | "isPending" | "isError" | "refetch">;
  summary: Pick<UseQueryResult<PolicyMonitorSummaryResponse>, "data" | "isPending" | "isError" | "isFetching" | "refetch">;
}) {
  const monitoring = settings.data?.policyEnforcementMode === "monitor";
  const checkingEvidence = monitoring && summary.isPending;
  const total = monitoring ? summary.data?.totals.total : undefined;
  const evidenceFailed = monitoring && !summary.isPending && total === undefined;
  // A failed refresh keeps the earlier numbers. Say so next to them.
  const evidenceStale = monitoring && summary.isError && total !== undefined;

  let line: ReactNode;
  if (settings.isError) line = "Could not check policy mode.";
  else if (settings.isPending) line = "Checking policy mode...";
  else if (!monitoring) line = "Enforce mode. Matching rules block actions or ask for approval.";
  else if (checkingEvidence) line = "Monitor mode. Checking the last 7 days...";
  else if (total === undefined) line = "Monitor mode. Could not load the last 7 days.";
  else line = <>
    {total === 0 ? "Monitor mode. No block or approval records counted in the last 7 days."
      : `Monitor mode. In the last 7 days, ${plural(total, "tool call")} would have been blocked or needed approval under Enforce.`}
    {evidenceStale ? <span className="font-medium text-danger"> Could not refresh. These counts are from an earlier read.</span> : null}
  </>;

  return (
    <OverviewRow title="Policies" status={line} busy={settings.isPending || checkingEvidence}>
      {settings.isError ? <Button variant="outline" size="sm" onClick={() => void settings.refetch()}>Retry policies</Button> : null}
      {evidenceFailed || evidenceStale ? (
        <Button variant="outline" size="sm" disabled={summary.isFetching} onClick={() => void summary.refetch()}>
          {summary.isFetching ? "Retrying..." : "Retry evidence"}
        </Button>
      ) : null}
      {monitoring
        ? <Button variant="outline" size="sm" asChild><Link href={REVIEW_ENFORCEMENT_HREF}>Review enforcement</Link></Button>
        : <Button variant="outline" size="sm" asChild><Link href="/admin/policy">Manage policies</Link></Button>}
    </OverviewRow>
  );
}
