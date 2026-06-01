import type {
  PolicyConditions,
  PolicyEffect,
  PolicySeverity,
  PolicyTurnContext
} from "@cogniplane/shared-types";

// The action being evaluated. Keys off tool name, MCP server category, read/write
// severity, and whether the turn is interactive or scheduled/unattended.
// `serverId` is also carried for evidence.
export type PolicyActionContext = {
  toolName: string;
  category: string | null;
  severity: PolicySeverity | null;
  serverId: string | null;
  // interactive vs scheduled/unattended; null when unknown.
  turnContext: PolicyTurnContext | null;
};

// The minimal rule shape the engine needs — a subset of the stored rule,
// so the engine stays pure and trivially testable without a DB.
export type EvaluableRule = {
  ruleId: string;
  name: string;
  priority: number;
  enabled: boolean;
  effect: PolicyEffect;
  conditions: PolicyConditions;
  reason: string | null;
};

export type PolicyEvaluation = {
  outcome: PolicyEffect;
  matchedRuleId: string | null;
  matchedRuleName: string | null;
  // Whether the matched effect is one that gates the action (block /
  // require_approval). This is the rule's INTENT — whether it actually gates
  // depends on the tenant's enforcement mode, which the caller applies. `allow`
  // and a no-match never gate.
  gating: boolean;
  explanation: string | null;
};

// The default when no rule matches: allow. Policy Center is additive — absent
// an explicit rule, behavior is unchanged from the pre-Policy-Center baseline
// (the runtime's own approval policy still applies independently).
const DEFAULT_OUTCOME: PolicyEffect = "allow";

function arrayMatches(
  values: readonly string[] | undefined,
  candidate: string | null
): boolean {
  // An omitted/empty dimension matches anything. Defensive: conditions arrive
  // from JSONB (see toConditions) and could be malformed — a non-array here
  // would otherwise crash `.includes()` on the hot path and block every tool
  // call for the tenant. Treat anything that isn't a non-empty array as "no
  // constraint" so a bad row degrades to a catch-all match, never a throw.
  if (!Array.isArray(values) || values.length === 0) return true;
  if (candidate === null) return false;
  return values.includes(candidate);
}

function ruleMatches(rule: EvaluableRule, action: PolicyActionContext): boolean {
  const { conditions } = rule;
  return (
    arrayMatches(conditions.toolNames, action.toolName) &&
    arrayMatches(conditions.categories, action.category) &&
    arrayMatches(conditions.severities, action.severity) &&
    arrayMatches(conditions.turnContexts, action.turnContext)
  );
}

/** True for effects that gate the action when the tenant is enforcing. */
export function isGatingEffect(effect: PolicyEffect): boolean {
  return effect === "block" || effect === "require_approval";
}

/**
 * Evaluate an action against an ordered set of rules. The first enabled rule
 * (by ascending priority, then ruleId for stable ties) whose conditions all
 * match decides the outcome. No match → default allow.
 *
 * Pure: callers' sort/filter is not assumed — the engine sorts defensively so a
 * mis-ordered input list can't change the decision. Whether a gating outcome is
 * actually enforced is the caller's call (tenant enforcement mode).
 */
export function evaluatePolicy(
  rules: readonly EvaluableRule[],
  action: PolicyActionContext
): PolicyEvaluation {
  const candidates = rules
    .filter((rule) => rule.enabled)
    .slice()
    .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.ruleId.localeCompare(b.ruleId)));

  for (const rule of candidates) {
    if (!ruleMatches(rule, action)) continue;
    return {
      outcome: rule.effect,
      matchedRuleId: rule.ruleId,
      matchedRuleName: rule.name,
      gating: isGatingEffect(rule.effect),
      explanation: rule.reason ?? defaultExplanation(rule)
    };
  }

  return {
    outcome: DEFAULT_OUTCOME,
    matchedRuleId: null,
    matchedRuleName: null,
    gating: false,
    explanation: null
  };
}

function defaultExplanation(rule: EvaluableRule): string {
  let verb: string;
  if (rule.effect === "block") {
    verb = "blocked";
  } else if (rule.effect === "require_approval") {
    verb = "routed for approval";
  } else {
    verb = "allowed";
  }
  return `Action ${verb} by policy rule "${rule.name}".`;
}
