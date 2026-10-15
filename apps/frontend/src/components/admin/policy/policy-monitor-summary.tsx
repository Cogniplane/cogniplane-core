"use client";

import type { PolicyMonitorRuleSummary, PolicyMonitorSummaryResponse } from "@cogniplane/shared-types";

import {
  approvalCount,
  excludedEvidenceText,
  ruleName,
  ruleNotes
} from "./policy-monitor.logic";

/** What the counts mean and what they leave out. Always shown with the numbers. */
export function MonitorEvidenceLimits({ summary }: { summary: PolicyMonitorSummaryResponse }) {
  return (
    <ul className="flex flex-col gap-1 text-xs leading-5 text-on-surface-variant">
      <li>
        Counts show what each rule decided when the tool call happened. They are not a replay of
        your current rules. Names show each rule as it is now.
      </li>
      <li>
        The gateway records a decision only when a rule matches, and it cannot guarantee every
        write. A zero does not mean there was no tool activity.
      </li>
      <li>{excludedEvidenceText(summary)}</li>
    </ul>
  );
}

function RuleCounts({ rule }: { rule: PolicyMonitorRuleSummary }) {
  const approvals = approvalCount(rule.counts);
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm tabular-nums text-on-surface-variant">
      {rule.counts.block > 0 ? <span>{rule.counts.block.toLocaleString()} blocked</span> : null}
      {approvals > 0 ? <span>{approvals.toLocaleString()} need approval</span> : null}
    </p>
  );
}

/** Rules that matched in the window, most counted first. */
export function MonitorRuleList({ summary, headingId }: { summary: PolicyMonitorSummaryResponse; headingId?: string }) {
  return (
    <ol aria-labelledby={headingId} className="flex flex-col divide-y divide-outline-variant">
      {summary.rules.map((rule) => {
        const notes = ruleNotes(rule);
        const name = ruleName(rule);
        return (
          <li
            key={rule.ruleId}
            className="grid gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline"
          >
            <div className="min-w-0">
              <p className={`text-sm font-medium [overflow-wrap:anywhere] ${rule.currentRule ? "text-on-surface" : "italic text-on-surface-variant"}`}>
                {name}
              </p>
              {notes.map((note) => (
                <p key={note} className="mt-0.5 text-xs text-warning">{note}</p>
              ))}
            </div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 sm:justify-end">
              <RuleCounts rule={rule} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
