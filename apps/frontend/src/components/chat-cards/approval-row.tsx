"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangleIcon, ChevronDownIcon } from "lucide-react";

import type { Approval } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { AnimatedHeight } from "@/components/ui/animated-height";
import type { ApprovalDecision, ApprovalRow } from "./chat-cards.types";

type DecisionHandler = (approvalId: string, decision: ApprovalDecision) => void;

export function ApprovalRowView({
  row,
  onDecision
}: {
  row: ApprovalRow;
  onDecision: DecisionHandler;
}) {
  return (
    <article
      role="alert"
      className="card-enter rounded-lg border border-warning/30 bg-warning-surface px-4 py-3"
    >
      <div className="grid grid-cols-[auto_1fr] items-start gap-3">
        <div
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-warning-surface text-warning"
        >
          <AlertTriangleIcon className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold text-warning">
            Approval needed · {kindLabel(row.kind)}
          </div>
          <div className="mt-0.5 text-sm font-semibold text-on-surface [overflow-wrap:anywhere]">{row.title}</div>
          <ApprovalSummary summary={row.summary} monospace={row.kind === "command_execution"} />
        </div>
      </div>
      <ApprovalActions row={row} onDecision={onDecision} className="mt-3" />
    </article>
  );
}

/**
 * The decision controls of an approval inside the card of its tool call. The
 * card already names the tool and its target, so this section gives the
 * approval's own text and the three decisions. After a decision, focus goes
 * back to the card through `onSettled`, because these controls unmount.
 */
export function InlineApproval({
  row,
  onDecision,
  onSettled
}: {
  row: ApprovalRow;
  onDecision: DecisionHandler;
  onSettled: () => void;
}) {
  const titleId = useId();
  const section = useRef<HTMLElement | null>(null);
  const decided = useRef(false);
  const settled = useRef(onSettled);
  useLayoutEffect(() => {
    settled.current = onSettled;
  });
  // Runs before the section leaves the DOM. A button that the user pressed
  // holds focus, or lost it when it was disabled while the request ran.
  useLayoutEffect(() => {
    const node = section.current;
    return () => {
      const active = document.activeElement;
      if (decided.current && (active === null || active === document.body || Boolean(node?.contains(active)))) {
        settled.current();
      }
    };
  }, []);
  const decide: DecisionHandler = (approvalId, decision) => {
    decided.current = true;
    onDecision(approvalId, decision);
  };

  return (
    <section
      ref={section}
      role="alert"
      aria-labelledby={titleId}
      className="mt-2 rounded-md bg-warning-surface px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p id={titleId} className="text-sm font-semibold text-on-surface [overflow-wrap:anywhere]">
            <span className="sr-only">Approval needed: </span>
            {row.title}
          </p>
          <ApprovalSummary summary={row.summary} monospace={row.kind === "command_execution"} />
        </div>
      </div>
      <ApprovalActions row={row} onDecision={decide} className="mt-2.5" />
    </section>
  );
}

function ApprovalSummary({ summary, monospace }: { summary: string; monospace: boolean }) {
  // Show the action and its consequences before a decision. Raw JSON keeps
  // its disclosure, unless the backend laid it out across several lines.
  const [expanded, setExpanded] = useState(!summary.trimStart().startsWith("{") || summary.includes("\n"));
  if (!summary) return null;
  // A summary worth expanding is one long enough to be truncated on one line.
  if (summary.length <= 80) return <div className={`mt-0.5 break-words text-xs text-on-surface-variant ${monospace ? "font-mono" : ""}`}>{summary}</div>;
  return (
    <button
      type="button"
      onClick={() => setExpanded((value) => !value)}
      className="mt-0.5 flex w-full items-start gap-1 rounded-sm text-left text-xs text-on-surface-variant outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-expanded={expanded}
    >
      <ChevronDownIcon
        className={`mt-0.5 size-3 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
      />
      <AnimatedHeight className="min-w-0 flex-1">
        <span
          className={`${monospace || summary.trimStart().startsWith("{") ? "font-mono" : ""} ${
            expanded ? "whitespace-pre-wrap break-words" : "block truncate"
          }`}
        >
          {summary}
        </span>
      </AnimatedHeight>
    </button>
  );
}

function ApprovalActions({
  row,
  onDecision,
  className
}: {
  row: ApprovalRow;
  onDecision: DecisionHandler;
  className: string;
}) {
  const working = row.decisionState === "approving" || row.decisionState === "rejecting";
  const scopeHintId = useId();
  return (
    <div className={`${className} flex flex-col gap-2`}>
      <div className="flex flex-wrap justify-end gap-2">
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
        size="sm"
        disabled={working}
        onClick={() => onDecision(row.approvalId, { decision: "approve" })}
      >
        {row.decisionState === "approving" ? "Working…" : "Approve once"}
      </Button>
      {row.allowForTurn ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={working}
          title="Auto-approve every matching action for the rest of this turn"
          aria-describedby={working ? undefined : scopeHintId}
          onClick={() => onDecision(row.approvalId, { decision: "approve", rememberForTurn: true })}
        >
          Allow for this turn
        </Button>
      ) : null}
      </div>
      {/* A request that needs approval of its exact values each time (memory_save) gets no
          turn option: approving it for the turn would not approve the next one. */}
      {working || !row.allowForTurn ? null : (
        <p id={scopeHintId} className="text-xs text-on-surface-variant">
          Allow for this turn also approves matching actions until this turn ends.
        </p>
      )}
    </div>
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
    case "mcp_tool":
      return "Tool call";
    default:
      return "Approval";
  }
}
