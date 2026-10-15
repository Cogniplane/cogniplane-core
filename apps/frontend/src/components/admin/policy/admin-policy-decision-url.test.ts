import { describe, expect, it } from "vitest";

import { parseDecisionUrl, writeDecisionUrl } from "./admin-policy-decision-url";
import { consequenceLines, monitorDecisionsHref, ruleNotes } from "./policy-monitor.logic";
import type { PolicyMonitorRuleSummary, PolicyMonitorSummaryResponse } from "@cogniplane/shared-types";

const counts = { block: 0, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 0, total: 0 };
const summary: PolicyMonitorSummaryResponse = {
  windowStart: "2026-09-20T12:00:00.000Z",
  windowEnd: "2026-09-27T12:00:00.000Z",
  totals: { ...counts, block: 2, approvalScheduled: 1, total: 3 },
  rules: [],
  excluded: { resourceChecks: 0, unrecognized: 0 }
};

function rule(overrides: Partial<PolicyMonitorRuleSummary>): PolicyMonitorRuleSummary {
  return {
    ruleId: "pol_a",
    currentRule: { name: "Block writes", enabled: true, effect: "block" },
    counts: { ...counts, block: 1, total: 1 },
    lastRecordedAt: "2026-09-26T10:00:00.000Z",
    ...overrides
  };
}

describe("decision filter URL", () => {
  it("links a count to the exact rule, outcome, window, and evidence set", () => {
    const href = monitorDecisionsHref(summary, { ruleId: "pol a/1", outcome: "block" });
    const [path, query, hash] = href.split(/[?#]/);
    expect(path).toBe("/admin/policy");
    expect(hash).toBe("policy-decisions");
    expect(parseDecisionUrl(new URLSearchParams(query))).toEqual({
      ok: true,
      filters: {
        matchedRuleId: "pol a/1",
        evidence: "monitor_gateway",
        since: summary.windowStart,
        until: summary.windowEnd,
        outcomes: ["block"]
      }
    });
  });

  it("round-trips every filter and keeps unrelated parameters", () => {
    const filters = {
      outcomes: ["require_approval" as const],
      enforced: false,
      severities: ["file_change" as const],
      toolNames: ["github_create_pr", "notion_create_page"],
      from: "2026-09-01",
      to: "2026-09-02"
    };
    const written = writeDecisionUrl(new URLSearchParams("tab=x&rule=old"), filters);
    expect(written.get("tab")).toBe("x");
    expect(written.get("rule")).toBeNull();
    expect(parseDecisionUrl(written)).toEqual({ ok: true, filters });
  });

  it.each([
    ["evidence=everything", "not known"],
    ["since=yesterday", "window start"],
    ["since=2026-09-27T12:00:00Z&until=2026-09-20T12:00:00Z", "starts after it ends"],
    ["outcome=block&outcome=allow", "more than once"],
    ["outcome=deny", "not known"],
    ["enforced=maybe", "not known"],
    ["from=2026-13-40", "start date"],
    // Date.parse would move these to March 2 and March 1.
    ["from=2026-02-30", "start date"],
    ["to=2026-02-29", "end date"],
    ["since=2026-02-30T12:00:00Z", "window start"],
    ["until=2026-09-27T24:00:00Z", "window end"],
    ["since=2026-09-20T12:00:00Z&from=2026-09-20", "not both"],
    ["rule=", "empty"]
  ])("reports %s instead of dropping it", (query, problem) => {
    const parsed = parseDecisionUrl(new URLSearchParams(query));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join(" ")).toContain(problem);
  });
});

describe("monitor summary wording", () => {
  it("says what Enforce would do for each approval context", () => {
    const lines = consequenceLines({ block: 1, approvalInteractive: 2, approvalScheduled: 1, approvalUnknownContext: 1, total: 5 });
    expect(lines.map((line) => [line.key, line.count])).toEqual([["block", 1], ["interactive", 2], ["scheduled", 1], ["unknown", 1]]);
    expect(lines.find((line) => line.key === "scheduled")?.text).toContain("denied");
    expect(lines.find((line) => line.key === "unknown")?.text).toContain("does not say");
  });

  it("accepts a real leap day", () => {
    expect(parseDecisionUrl(new URLSearchParams("from=2028-02-29&to=2028-02-29"))).toEqual({
      ok: true,
      filters: { from: "2028-02-29", to: "2028-02-29" }
    });
  });

  it("flags deleted, disabled, and changed rules", () => {
    expect(ruleNotes(rule({ currentRule: null }))).toEqual(["Deleted. It will not act under Enforce."]);
    expect(ruleNotes(rule({ currentRule: { name: "x", enabled: false, effect: "block" } }))).toEqual([
      "Disabled now. It will not act under Enforce."
    ]);
    expect(ruleNotes(rule({ currentRule: { name: "x", enabled: true, effect: "allow" } }))).toEqual([
      "Its effect is now Allow."
    ]);
    expect(ruleNotes(rule({}))).toEqual([]);
  });
});
