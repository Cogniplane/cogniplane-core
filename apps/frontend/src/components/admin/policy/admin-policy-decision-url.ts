import {
  POLICY_DECISION_EVIDENCE,
  POLICY_EFFECTS,
  POLICY_SEVERITIES,
  type PolicyDecisionEvidence,
  type PolicyEffect,
  type PolicySeverity
} from "@cogniplane/shared-types";

// The Policies page keeps the decision filters in the URL, so a link from the
// monitor summary or the Overview opens the exact same rows, and the filters
// survive a reload and back/forward navigation.
//
//   rule      recorded rule ID          evidence  monitor_gateway
//   since     exact ISO lower bound     until     exact ISO upper bound (inclusive)
//   outcome   one effect                enforced  true | false
//   severity  one severity              tool      comma-separated tool names
//   from, to  YYYY-MM-DD UTC day range (to includes the whole day)
//
// since/until and from/to both set the lower bound on the API, so a URL can
// hold only one of the two forms.

export type DecisionFilters = {
  matchedRuleId?: string;
  evidence?: PolicyDecisionEvidence;
  since?: string;
  until?: string;
  outcomes?: PolicyEffect[];
  enforced?: boolean;
  severities?: PolicySeverity[];
  toolNames?: string[];
  from?: string;
  to?: string;
};

export const DECISION_URL_KEYS = [
  "rule",
  "evidence",
  "since",
  "until",
  "outcome",
  "enforced",
  "severity",
  "tool",
  "from",
  "to"
] as const;

export type DecisionUrlParse =
  | { ok: true; filters: DecisionFilters }
  | { ok: false; problems: string[] };

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

// Date.parse moves an impossible day to the next month (2026-02-30 becomes
// March 2), so check that the calendar has the day.
function isDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isInstant(value: string): boolean {
  const match = ISO_PATTERN.exec(value);
  return match !== null && isDay(match[1]!) && !Number.isNaN(Date.parse(value));
}

/**
 * Read the decision filters from the URL. A value that cannot be read is
 * reported, not dropped: the page then shows the problem instead of rows for a
 * wider scope than the link asked for.
 */
export function parseDecisionUrl(params: URLSearchParams): DecisionUrlParse {
  const problems: string[] = [];
  const filters: DecisionFilters = {};
  const read = (key: (typeof DECISION_URL_KEYS)[number]): string | undefined => {
    const values = params.getAll(key);
    if (values.length === 0) return undefined;
    if (values.length > 1) {
      problems.push(`"${key}" appears more than once.`);
      return undefined;
    }
    const value = (values[0] ?? "").trim();
    if (!value) {
      problems.push(`"${key}" is empty.`);
      return undefined;
    }
    return value;
  };

  const rule = read("rule");
  if (rule !== undefined) {
    if (rule.length > 200) problems.push("The rule ID is too long.");
    else filters.matchedRuleId = rule;
  }

  const evidence = read("evidence");
  if (evidence !== undefined) {
    if ((POLICY_DECISION_EVIDENCE as readonly string[]).includes(evidence)) {
      filters.evidence = evidence as PolicyDecisionEvidence;
    } else {
      problems.push(`The evidence set "${evidence}" is not known.`);
    }
  }

  const since = read("since");
  if (since !== undefined) {
    if (isInstant(since)) filters.since = since;
    else problems.push("The window start is not a valid timestamp.");
  }
  const until = read("until");
  if (until !== undefined) {
    if (isInstant(until)) filters.until = until;
    else problems.push("The window end is not a valid timestamp.");
  }
  if (filters.since && filters.until && Date.parse(filters.since) > Date.parse(filters.until)) {
    problems.push("The window starts after it ends.");
  }

  const outcome = read("outcome");
  if (outcome !== undefined) {
    if ((POLICY_EFFECTS as readonly string[]).includes(outcome)) filters.outcomes = [outcome as PolicyEffect];
    else problems.push(`The outcome "${outcome}" is not known.`);
  }

  const enforced = read("enforced");
  if (enforced !== undefined) {
    if (enforced === "true" || enforced === "false") filters.enforced = enforced === "true";
    else problems.push(`The enforcement value "${enforced}" is not known.`);
  }

  const severity = read("severity");
  if (severity !== undefined) {
    if ((POLICY_SEVERITIES as readonly string[]).includes(severity)) {
      filters.severities = [severity as PolicySeverity];
    } else {
      problems.push(`The severity "${severity}" is not known.`);
    }
  }

  const tool = read("tool");
  if (tool !== undefined) {
    const names = tool.split(",").map((name) => name.trim()).filter(Boolean);
    if (names.length > 0) filters.toolNames = names;
    else problems.push("The tool filter is empty.");
  }

  const from = read("from");
  if (from !== undefined) {
    if (isDay(from)) filters.from = from;
    else problems.push("The start date is not a valid date.");
  }
  const to = read("to");
  if (to !== undefined) {
    if (isDay(to)) filters.to = to;
    else problems.push("The end date is not a valid date.");
  }
  if ((since !== undefined || until !== undefined) && (from !== undefined || to !== undefined)) {
    problems.push("A link can use an exact window or a date range, not both.");
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, filters };
}

/**
 * Write the filters into `base`, replacing every decision filter key and
 * keeping unrelated parameters.
 */
export function writeDecisionUrl(base: URLSearchParams, filters: DecisionFilters): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const key of DECISION_URL_KEYS) next.delete(key);
  if (filters.matchedRuleId) next.set("rule", filters.matchedRuleId);
  if (filters.evidence) next.set("evidence", filters.evidence);
  if (filters.since) next.set("since", filters.since);
  if (filters.until) next.set("until", filters.until);
  if (filters.outcomes?.[0]) next.set("outcome", filters.outcomes[0]);
  if (filters.enforced !== undefined) next.set("enforced", String(filters.enforced));
  if (filters.severities?.[0]) next.set("severity", filters.severities[0]);
  if (filters.toolNames?.length) next.set("tool", filters.toolNames.join(","));
  if (filters.from) next.set("from", filters.from);
  if (filters.to) next.set("to", filters.to);
  return next;
}

/** A stable string for comparing two filter sets. */
export function decisionFiltersKey(filters: DecisionFilters): string {
  return writeDecisionUrl(new URLSearchParams(), filters).toString();
}

/** True when the filters narrow to a rule, an evidence set, or an exact window. */
export function hasDecisionScope(filters: DecisionFilters): boolean {
  return Boolean(filters.matchedRuleId || filters.evidence || filters.since || filters.until);
}

/** The scope part of the filters: kept when the filter bar applies a draft. */
export function decisionScope(filters: DecisionFilters): DecisionFilters {
  return {
    matchedRuleId: filters.matchedRuleId,
    evidence: filters.evidence,
    since: filters.since,
    until: filters.until
  };
}
