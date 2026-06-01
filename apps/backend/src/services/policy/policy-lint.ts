import {
  POLICY_CONDITION_KEYS,
  type PolicyConditions,
  type PolicyLintWarning
} from "@cogniplane/shared-types";

// A rule as the lint sees it — the subset of fields that affect reachability.
// Mirrors the engine's EvaluableRule but the lint only needs identity, order,
// enablement, and the condition set (not the effect — see below).
export type LintableRule = {
  ruleId: string;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: PolicyConditions;
};

const KNOWN_KEYS = new Set<string>(POLICY_CONDITION_KEYS);

// The condition dimensions, all array-valued OR-lists where empty/absent means
// "matches anything". (Kept in sync with POLICY_CONDITION_KEYS.)
const ARRAY_DIMENSIONS = [
  "toolNames",
  "categories",
  "severities",
  "turnContexts"
] as const;

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((v): v is string => typeof v === "string");
  return entries.length > 0 ? entries : undefined;
}

// Does dimension `outer` (a constraint) match every value dimension `inner`
// could match? An absent/empty `outer` is a wildcard (matches anything) so it
// subsumes any inner. Otherwise `outer` only subsumes when `inner` is a
// non-empty SUBSET of it: every value the inner rule admits, the outer rule
// also admits. (If inner is a wildcard but outer is constrained, outer does NOT
// subsume — inner admits values outside outer's list.)
function arrayDimensionSubsumes(outer: string[] | undefined, inner: string[] | undefined): boolean {
  if (!outer || outer.length === 0) return true;
  if (!inner || inner.length === 0) return false;
  const outerSet = new Set(outer);
  return inner.every((v) => outerSet.has(v));
}

/**
 * Does the `outer` condition set subsume the `inner` one — i.e. would every
 * action that matches `inner` also match `outer`? When true and `outer` belongs
 * to a higher-precedence enabled rule, the engine's first-match-wins means
 * `inner`'s rule can never fire (it is shadowed).
 *
 * This is a CONSERVATIVE, per-dimension check: subsumption holds only when it
 * holds for every dimension independently. It deliberately does NOT reason about
 * cross-dimension interactions, so it never claims a shadow it can't prove. It
 * is sound (no false "shadowed") but incomplete (misses some real shadows).
 *
 * Unknown/passthrough condition keys are ignored here — they're dropped before
 * the engine ever sees them (toConditions), so they don't affect matching. A
 * separate `unknown_condition` warning flags them as a likely typo.
 */
export function conditionsSubsume(outer: PolicyConditions, inner: PolicyConditions): boolean {
  for (const dim of ARRAY_DIMENSIONS) {
    if (!arrayDimensionSubsumes(asStringArray(outer[dim]), asStringArray(inner[dim]))) {
      return false;
    }
  }
  return true;
}

// Two condition sets are equivalent when each subsumes the other (same matched
// action space across the known dimensions).
function conditionsEquivalent(a: PolicyConditions, b: PolicyConditions): boolean {
  return conditionsSubsume(a, b) && conditionsSubsume(b, a);
}

function unknownConditionKeys(conditions: PolicyConditions): string[] {
  return Object.keys(conditions).filter((key) => !KNOWN_KEYS.has(key));
}

/**
 * Analyze a tenant's rule set for rules that can never fire, exact duplicates,
 * and unknown condition keys. Pure (no DB, no side effects) and ordered exactly
 * like the engine evaluates — `priority ASC, ruleId` — so a "shadowed" verdict
 * reflects real evaluation order, not the store's incidental ordering.
 *
 * What it reports (only the provable):
 *   - shadowed: a higher-precedence ENABLED rule whose conditions subsume this
 *     rule's, so the engine returns the earlier rule first and this one never
   *     fires. EFFECT-AGNOSTIC: the engine stops at the first match regardless
   *     of effect. Exact-condition duplicates are reported as `duplicate`
   *     instead.
 *   - duplicate: a higher-precedence enabled rule with an EQUIVALENT condition
 *     set — a clearer special case of shadowing (identical match space). The
   *     message notes the lower rule's effect can never apply.
 *   - unknown_condition: a condition key outside the known dimensions (a typo
 *     like `toolName` for `toolNames`), which `toConditions` silently drops —
 *     turning the rule into an unintended catch-all.
 *
 * What it deliberately does NOT report: partial cross-dimension overlaps (two
 * rules that overlap on some actions but neither subsumes the other). Those are
 * legitimate co-existing rules far more often than they are bugs, so flagging
 * them would train admins to ignore warnings.
 *
 * A DISABLED rule never shadows (the engine filters it out), so disabled rules
 * are skipped as potential shadowers but are still themselves checked for
 * unknown keys.
 */
export function lintRules(rules: readonly LintableRule[]): PolicyLintWarning[] {
  const ordered = rules
    .slice()
    .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.ruleId.localeCompare(b.ruleId)));

  const warnings: PolicyLintWarning[] = [];

  // Unknown-condition keys: independent of order/enablement.
  for (const rule of ordered) {
    const unknown = unknownConditionKeys(rule.conditions);
    if (unknown.length > 0) {
      warnings.push({
        kind: "unknown_condition",
        ruleId: rule.ruleId,
        ruleName: rule.name,
        conflictsWithRuleId: null,
        conflictsWithRuleName: null,
        message: `Rule "${rule.name}" has unrecognized condition ${
          unknown.length === 1 ? "key" : "keys"
        } ${unknown.map((k) => `"${k}"`).join(", ")} that the engine ignores — likely a typo (the dimension is dropped, so the rule matches more broadly than intended).`
      });
    }
  }

  // Shadowing / duplicate: for each enabled rule, find the FIRST higher-precedence
  // enabled rule whose conditions subsume it. Only the first matters — that's the
  // one the engine actually returns — so we stop at it and don't double-report.
  for (let i = 0; i < ordered.length; i += 1) {
    const rule = ordered[i];
    if (!rule.enabled) continue;
    for (let j = 0; j < i; j += 1) {
      const earlier = ordered[j];
      if (!earlier.enabled) continue;
      if (!conditionsSubsume(earlier.conditions, rule.conditions)) continue;

      const duplicate = conditionsEquivalent(earlier.conditions, rule.conditions);
      warnings.push({
        kind: duplicate ? "duplicate" : "shadowed",
        ruleId: rule.ruleId,
        ruleName: rule.name,
        conflictsWithRuleId: earlier.ruleId,
        conflictsWithRuleName: earlier.name,
        message: duplicate
          ? `Rule "${rule.name}" has the same conditions as higher-priority rule "${earlier.name}", which always matches first — so "${rule.name}"'s effect can never apply.`
          : `Rule "${rule.name}" is unreachable: higher-priority rule "${earlier.name}" matches every action "${rule.name}" would, so the engine never reaches it.`
      });
      break;
    }
  }

  return warnings;
}
