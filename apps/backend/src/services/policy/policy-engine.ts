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

// No rule matches: allow. The runtime's own approval policy still applies on its own.
const DEFAULT_OUTCOME: PolicyEffect = "allow";

function arrayMatches(
  values: readonly string[] | undefined,
  candidate: string | null
): boolean {
  // An omitted or empty dimension matches anything. Conditions come from JSONB
  // (see toConditions) and can be malformed. A throw here would block every tool
  // call for the tenant, so a bad value counts as "no constraint" and never throws.
  if (!Array.isArray(values) || values.length === 0) return true;
  if (candidate === null) return false;
  return values.includes(candidate);
}

// Tool names match without regard to case or Unicode form. Lint uses the same rule.
export function normalizeToolName(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function toolNameMatches(values: readonly string[] | undefined, candidate: string): boolean {
  if (!Array.isArray(values) || values.length === 0) return true;
  const normalizedCandidate = normalizeToolName(candidate);
  return values.some(
    (value) => typeof value === "string" && normalizeToolName(value) === normalizedCandidate
  );
}

function ruleMatches(rule: EvaluableRule, action: PolicyActionContext): boolean {
  const { conditions } = rule;
  return (
    toolNameMatches(conditions.toolNames, action.toolName) &&
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
 * The canonical rule evaluation order: ascending priority, then ruleId for a
 * stable tie-break. This is the ONE definition of evaluation order — the engine
 * sorts by it before first-match-wins, the lint sorts by it so a "shadowed"
 * verdict reflects real evaluation order, and it must mirror the store's SQL
 * `ORDER BY priority ASC, rule_id ASC` (policy-rule-store.ts). If these three
 * ever disagree, the lint validates an order the engine doesn't enforce.
 */
export function compareRuleEvaluationOrder(
  a: { priority: number; ruleId: string },
  b: { priority: number; ruleId: string }
): number {
  return a.priority !== b.priority ? a.priority - b.priority : a.ruleId.localeCompare(b.ruleId);
}

/**
 * The first enabled rule (ascending priority, then ruleId for ties) whose
 * conditions all match decides the outcome. No match means default allow.
 *
 * Pure. The engine sorts its input, so a mis-ordered list cannot change the decision.
 * The caller uses tenant enforcement mode to decide whether to enforce a gating outcome.
 */
export function evaluatePolicy(
  rules: readonly EvaluableRule[],
  action: PolicyActionContext
): PolicyEvaluation {
  const candidates = rules
    .filter((rule) => rule.enabled)
    .slice()
    .sort(compareRuleEvaluationOrder);

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
