"use client";

import { aggregateFindings } from "../../../lib/admin-session-pii-utils";
import { shortId, statusPillClass } from "../../../lib/admin-pii-utils";
import { formatTimestamp } from "../../../lib/time-format";
import type { AdminSessionDetailPiiRun } from "@cogniplane/shared-types";
import { PILL_GRAY } from "../../../lib/ui-tokens";

function findingsLabel(findings: unknown[]): string {
  const aggregated = aggregateFindings(findings);
  if (aggregated.length === 0) {
    return findings.length === 1 ? "1 finding" : `${findings.length} findings`;
  }
  return aggregated
    .map((b) => `${b.count} ${b.label}${b.count === 1 ? "" : "s"}`)
    .join(", ");
}

export function AdminSessionPiiTab(props: { piiRuns: AdminSessionDetailPiiRun[] }) {
  if (props.piiRuns.length === 0) {
    return <p className="text-sm text-on-surface-faint">No PII scan runs for this session.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {props.piiRuns.map((run) => (
        <details
          key={run.scanRunId}
          className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3"
        >
          <summary className="cursor-pointer list-revert">
            <div className="inline-block w-[calc(100%-24px)] align-top">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm font-semibold text-on-surface">
                  {run.subjectType === "message" ? "Message" : "Artifact"} {shortId(run.subjectId)}
                </strong>
                <span className={statusPillClass(run.status)}>{run.status}</span>
                <span className={PILL_GRAY}>mode: {run.mode}</span>
                {run.providerType ? <span className={PILL_GRAY}>{run.providerType}</span> : null}
                {run.actionTaken ? <span className={PILL_GRAY}>action: {run.actionTaken}</span> : null}
              </div>
              <p className="mt-1 text-xs text-on-surface-faint">
                {findingsLabel(run.findings)} · created {formatTimestamp(run.createdAt)}
              </p>
            </div>
          </summary>
          <div className="mt-2 text-xs text-on-surface-variant">
            <p>
              <strong className="font-semibold text-on-surface">Scan run ID:</strong> {run.scanRunId}
            </p>
            {run.providerModel ? (
              <p>
                <strong className="font-semibold text-on-surface">Provider model:</strong>{" "}
                {run.providerModel}
              </p>
            ) : null}
            {run.completedAt ? (
              <p>
                <strong className="font-semibold text-on-surface">Completed:</strong>{" "}
                {formatTimestamp(run.completedAt)}
              </p>
            ) : null}
            {run.summaryText ? (
              <p>
                <strong className="font-semibold text-on-surface">Summary:</strong> {run.summaryText}
              </p>
            ) : null}
            {run.errorMessage ? (
              <p className="text-danger">
                <strong className="font-semibold">Error:</strong> {run.errorMessage}
              </p>
            ) : null}
            {run.findings.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer">Findings ({run.findings.length})</summary>
                <pre className="mt-1.5 overflow-auto text-[11px] text-on-surface-variant">
                  {JSON.stringify(run.findings, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        </details>
      ))}
    </div>
  );
}
