"use client";

import type { AdminSessionDetailApproval } from "@cogniplane/shared-types";

const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_RED = `${PILL_BASE} bg-danger-surface text-danger`;
const PILL_BLUE = `${PILL_BASE} bg-accent-soft text-accent`;
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const HINT = "text-sm text-on-surface-faint";
const LIST_ITEM = "rounded-lg border border-outline-variant bg-surface-container-lowest p-3";

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function decisionPillClass(status: string, decision: string | null): string {
  // The canonical signal is `approvals.status` (pending|approved|rejected|expired);
  // `decision` is the lower-level approve|reject|null. Read status first.
  if (status === "approved" || decision === "approve") return PILL_BLUE;
  if (status === "rejected" || decision === "reject") return PILL_RED;
  return PILL_GRAY;
}

export function AdminSessionApprovalsTab(props: { approvals: AdminSessionDetailApproval[] }) {
  if (props.approvals.length === 0) {
    return <p className={HINT}>No approvals in this session.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {props.approvals.map((approval) => (
        <details key={approval.approvalId} className={LIST_ITEM}>
          <summary className="cursor-pointer list-revert">
            <div className="inline-block w-[calc(100%-24px)] align-top">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm font-semibold text-on-surface">{approval.title}</strong>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={PILL_GRAY}>{approval.kind}</span>
                  <span className={PILL_GRAY}>{approval.status}</span>
                  <span className={decisionPillClass(approval.status, approval.decision)}>
                    {approval.decision ?? "no decision"}
                  </span>
                </div>
              </div>
              <p className="mt-1 text-xs text-on-surface-faint">
                Created {formatTimestamp(approval.createdAt)} · resolved{" "}
                {formatTimestamp(approval.resolvedAt)}
              </p>
            </div>
          </summary>
          <div className="mt-2 text-xs text-on-surface-variant">
            <p>
              <strong className="font-semibold text-on-surface">Summary:</strong>{" "}
              {approval.summary || "—"}
            </p>
            <p>
              <strong className="font-semibold text-on-surface">Request method:</strong>{" "}
              {approval.requestMethod}
            </p>
            <p>
              <strong className="font-semibold text-on-surface">Turn ID:</strong> {approval.turnId}
            </p>
            <p>
              <strong className="font-semibold text-on-surface">Item ID:</strong> {approval.itemId}
            </p>
            <p>
              <strong className="font-semibold text-on-surface">Approval ID:</strong>{" "}
              {approval.approvalId}
            </p>
            {approval.requestPayload &&
            Object.keys(approval.requestPayload as object).length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer">Request payload</summary>
                <pre className="mt-1.5 overflow-auto text-[11px]">
                  {JSON.stringify(approval.requestPayload, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        </details>
      ))}
    </div>
  );
}
