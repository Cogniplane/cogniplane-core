"use client";

import { useState } from "react";
import { AlertTriangleIcon, ChevronDownIcon } from "lucide-react";

import type { Approval } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { AnimatedHeight } from "@/components/ui/animated-height";
import type { ApprovalDecision, ApprovalRow } from "../timeline.logic";

export function ApprovalRowView({
  row,
  onDecision
}: {
  row: ApprovalRow;
  onDecision: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  const working = row.decisionState === "approving" || row.decisionState === "rejecting";
  const [expanded, setExpanded] = useState(false);
  // A summary worth expanding is one long enough to be truncated on one line.
  const expandable = row.summary.length > 80;

  return (
    <article
      role="alert"
      className="rounded-lg border border-warning/30 bg-warning-surface/20 px-4 py-3"
    >
      <div className="grid grid-cols-[auto_1fr] items-start gap-3">
        <div
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-warning-surface text-warning"
        >
          <AlertTriangleIcon className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[0.64rem] font-extrabold uppercase tracking-[0.14em] text-warning">
            Approval needed · {kindLabel(row.kind)}
          </div>
          <div className="text-sm font-bold text-on-surface">{row.title}</div>
          {row.summary ? (
            expandable ? (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="mt-0.5 flex w-full items-start gap-1 text-left text-xs text-on-surface-variant outline-none"
                aria-expanded={expanded}
              >
                <ChevronDownIcon
                  className={`mt-0.5 size-3 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
                />
                <AnimatedHeight className="min-w-0 flex-1">
                  <span className={expanded ? "whitespace-pre-wrap break-words" : "block truncate"}>
                    {row.summary}
                  </span>
                </AnimatedHeight>
              </button>
            ) : (
              <div className="mt-0.5 text-xs text-on-surface-variant">{row.summary}</div>
            )
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={working}
          onClick={() => onDecision(row.approvalId, { decision: "reject" })}
        >
          {row.decisionState === "rejecting" ? "Working…" : "Decline"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={working}
          onClick={() => onDecision(row.approvalId, { decision: "approve" })}
        >
          {row.decisionState === "approving" ? "Working…" : "Approve once"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={working}
          title="Auto-approve every matching action for the rest of this turn"
          onClick={() => onDecision(row.approvalId, { decision: "approve", rememberForTurn: true })}
        >
          Allow for this turn
        </Button>
      </div>
    </article>
  );
}

function kindLabel(kind: Approval["kind"]): string {
  switch (kind) {
    case "command_execution":
      return "Shell command";
    case "file_change":
      return "File change";
    case "permissions":
      return "Permission request";
    default:
      return "Approval";
  }
}
