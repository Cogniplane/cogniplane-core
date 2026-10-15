import type {
  PolicyEffect,
  PolicyMonitorOutcomeCounts,
  PolicyMonitorRuleSummary,
  PolicyMonitorSummaryResponse
} from "@cogniplane/shared-types";

import { writeDecisionUrl } from "./admin-policy-decision-url";

export const POLICY_PAGE = "/admin/policy";
export const DECISIONS_ANCHOR = "policy-decisions";
/** Overview links open the review on the Policies page with this parameter. */
export const REVIEW_PARAM = "review";
export const REVIEW_ENFORCEMENT = "enforcement";
export const REVIEW_ENFORCEMENT_HREF = `${POLICY_PAGE}?${REVIEW_PARAM}=${REVIEW_ENFORCEMENT}`;

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function approvalCount(counts: PolicyMonitorOutcomeCounts): number {
  return counts.approvalInteractive + counts.approvalScheduled + counts.approvalUnknownContext;
}

/**
 * Link to the decisions that a count was made from: the same window and
 * evidence set, and optionally one rule and one outcome.
 */
export function monitorDecisionsHref(
  summary: Pick<PolicyMonitorSummaryResponse, "windowStart" | "windowEnd">,
  options: { ruleId?: string; outcome?: PolicyEffect } = {}
): string {
  const search = writeDecisionUrl(new URLSearchParams(), {
    matchedRuleId: options.ruleId,
    evidence: "monitor_gateway",
    since: summary.windowStart,
    until: summary.windowEnd,
    outcomes: options.outcome ? [options.outcome] : undefined
  });
  return `${POLICY_PAGE}?${search.toString()}#${DECISIONS_ANCHOR}`;
}

const UTC_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC"
});

export function formatUtc(iso: string): string {
  return UTC_FORMAT.format(new Date(iso));
}

export function formatWindow(start: string, end: string): string {
  return `${formatUtc(start)} to ${formatUtc(end)} UTC`;
}

export function ruleName(rule: PolicyMonitorRuleSummary): string {
  return rule.currentRule?.name ?? "Deleted rule";
}

/** Notes about how the rule is now, compared with when it was recorded. */
export function ruleNotes(rule: PolicyMonitorRuleSummary): string[] {
  if (!rule.currentRule) return ["Deleted. It will not act under Enforce."];
  const notes: string[] = [];
  if (!rule.currentRule.enabled) notes.push("Disabled now. It will not act under Enforce.");
  const recordedBlock = rule.counts.block > 0;
  const recordedApproval = approvalCount(rule.counts) > 0;
  const effect = rule.currentRule.effect;
  if (
    (effect === "allow" && (recordedBlock || recordedApproval)) ||
    (effect === "block" && recordedApproval && !recordedBlock) ||
    (effect === "require_approval" && recordedBlock && !recordedApproval)
  ) {
    notes.push(`Its effect is now ${EFFECT_NOW[effect]}.`);
  }
  return notes;
}

const EFFECT_NOW: Record<PolicyEffect, string> = {
  allow: "Allow",
  block: "Block",
  require_approval: "Require approval"
};

/** Rules in the window that are now disabled or deleted. */
export function inactiveRuleCount(summary: PolicyMonitorSummaryResponse): number {
  return summary.rules.filter((rule) => !rule.currentRule || !rule.currentRule.enabled).length;
}

/**
 * What to say when nothing was counted. The gateway records only rule
 * matches, writes are best effort, and some records are excluded, so a zero
 * says nothing about tool activity or safety.
 */
export const ZERO_EVIDENCE_TITLE = "No Monitor block or approval records were counted in these 7 days.";
export const ZERO_EVIDENCE_DETAIL =
  "This does not mean that no tool calls ran or that Enforce is safe. The gateway records only " +
  "rule matches, a write can fail, and some records are not counted.";

/** How to read the Monitor counts, in one short line. */
export const HISTORICAL_EVIDENCE_NOTE =
  "Counts come from decisions that rules recorded at the time, shown with current rule names. They do not cover all tool activity.";

export type ConsequenceLine = { key: string; count: number; text: string };

/** What Enforce would have done, one line for each outcome that happened. */
export function consequenceLines(counts: PolicyMonitorOutcomeCounts): ConsequenceLine[] {
  const lines: ConsequenceLine[] = [
    {
      key: "block",
      count: counts.block,
      text: counts.block === 1 ? "tool call would have been blocked." : "tool calls would have been blocked."
    },
    {
      key: "interactive",
      count: counts.approvalInteractive,
      text:
        counts.approvalInteractive === 1
          ? "tool call in a chat would have asked the user for approval."
          : "tool calls in chats would have asked the user for approval."
    },
    {
      key: "scheduled",
      count: counts.approvalScheduled,
      text:
        (counts.approvalScheduled === 1
          ? "tool call on a scheduled run would have been denied."
          : "tool calls on scheduled runs would have been denied.") +
        " Scheduled runs cannot ask for approval."
    },
    {
      key: "unknown",
      count: counts.approvalUnknownContext,
      text:
        counts.approvalUnknownContext === 1
          ? "tool call needed approval, but the record does not say if it was a chat or a scheduled run."
          : "tool calls needed approval, but the records do not say if they were chats or scheduled runs."
    }
  ];
  return lines.filter((line) => line.count > 0);
}

/** Plain statement of what the counts leave out. */
export function excludedEvidenceText(summary: PolicyMonitorSummaryResponse): string {
  const { resourceChecks, unrecognized } = summary.excluded;
  return (
    `Not counted: resource checks after a tool call finished (${resourceChecks.toLocaleString()}), ` +
    `and older or unrecognized records (${unrecognized.toLocaleString()}).`
  );
}
