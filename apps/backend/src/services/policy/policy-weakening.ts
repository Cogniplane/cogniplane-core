import type { PolicyEffect } from "@cogniplane/shared-types";

import {
  type EvaluableRule,
  evaluatePolicy,
  normalizeToolName,
  type PolicyActionContext
} from "./policy-engine.js";

// When a change of the Policy Center rules makes the policy weaker
// (docs/ARCHITECTURE.md, "Data routes"). Only such a change needs step-up and
// sends the owner notice: a stolen admin token must not open a tool that a
// rule blocks or routes for approval.
//
// Weaker: after the change, at least one tool call gets a less strict outcome
// than before. Strictness: allow < require_approval < block. The tenant's
// enforcement mode does not count: rules made weaker in monitor mode are
// weaker when the tenant enforces them.
//
// The check runs the real engine (evaluatePolicy) on the rules before and
// after the change, for a finite set of sample actions. A rule compares each
// dimension of an action only with the values that it lists: tool names
// without regard to case or Unicode form, the other dimensions exactly, and an
// action with no value never matches a listed dimension. So two actions that
// equal the same listed values in each dimension get the same outcome from
// any of these rules. For each dimension the samples take each listed value,
// one value that no rule lists, and no value (a tool call always has a tool
// name). This covers every case that the rules can tell apart, so the result
// is exact, not an estimate.
//
// Only an action that a changed rule matches (its version before or after the
// change) can get a different outcome. For any other action, the same enabled
// rules match, in the same order.
//
// The check runs in the request, so its work has a limit (MAX_WORK). Above the
// limit, the change counts as weaker (fail closed). So a change of a broad rule
// in a large rule set needs step-up. A rule that names a few tools stays well
// under the limit.

/** The most work for one check: sample actions times enabled rules, before and after. Above it, the change counts as weaker. */
export const MAX_WORK = 200_000;

const STRICTNESS: Record<PolicyEffect, number> = { allow: 0, require_approval: 1, block: 2 };

type Dimension = "toolNames" | "categories" | "severities" | "turnContexts";
const DIMENSIONS: readonly Dimension[] = ["toolNames", "categories", "severities", "turnContexts"];

/** The values of a dimension that a rule lists, or null when the rule does not constrain it (the engine's rule). */
function listedValues(rule: EvaluableRule, dimension: Dimension): string[] | null {
  const values: unknown = rule.conditions[dimension];
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.filter((value): value is string => typeof value === "string");
}

/** One value per class: tool names that differ only in case or Unicode form are one class. */
function sameClass(dimension: Dimension): (value: string) => string {
  return dimension === "toolNames" ? normalizeToolName : (value) => value;
}

/**
 * The sample values of each dimension: each value that an enabled rule lists
 * (one per class), a value that no rule lists, and null where an action can
 * have no value.
 */
function sampleValues(rules: readonly EvaluableRule[]): Record<Dimension, Array<string | null>> {
  const samples = {} as Record<Dimension, Array<string | null>>;
  for (const dimension of DIMENSIONS) {
    const key = sameClass(dimension);
    const listed = new Map<string, string>();
    for (const rule of rules) {
      if (!rule.enabled) continue;
      for (const value of listedValues(rule, dimension) ?? []) {
        if (!listed.has(key(value))) listed.set(key(value), value);
      }
    }
    let unlisted = "cogniplane-unlisted";
    for (let index = 1; listed.has(key(unlisted)); index += 1) unlisted = `cogniplane-unlisted-${index}`;
    samples[dimension] = [...listed.values(), unlisted, ...(dimension === "toolNames" ? [] : [null])];
  }
  return samples;
}

/** The sample values of each dimension for the actions that `rule` matches. */
function matchedSamples(rule: EvaluableRule, all: Record<Dimension, Array<string | null>>): Record<Dimension, Array<string | null>> {
  const samples = {} as Record<Dimension, Array<string | null>>;
  for (const dimension of DIMENSIONS) {
    const listed = listedValues(rule, dimension);
    if (!listed) {
      samples[dimension] = all[dimension];
      continue;
    }
    const key = sameClass(dimension);
    samples[dimension] = [...new Map(listed.map((value) => [key(value), value])).values()];
  }
  return samples;
}

function* actions(samples: Record<Dimension, Array<string | null>>): Generator<PolicyActionContext> {
  for (const toolName of samples.toolNames) {
    for (const category of samples.categories) {
      for (const severity of samples.severities) {
        for (const turnContext of samples.turnContexts) {
          yield {
            toolName: toolName ?? "",
            category,
            severity: severity as PolicyActionContext["severity"],
            serverId: null,
            turnContext: turnContext as PolicyActionContext["turnContext"]
          };
        }
      }
    }
  }
}

/**
 * True when the rules `after` give at least one tool call a less strict
 * outcome than the rules `before`. `changed`: each version, before and after,
 * of the rules that the change adds, removes, or edits (for a new order: the
 * rules whose priority changed). A disabled version matches nothing.
 */
export function weakensPolicy(
  before: readonly EvaluableRule[],
  after: readonly EvaluableRule[],
  changed: readonly EvaluableRule[]
): boolean {
  const all = sampleValues([...before, ...after]);
  const regions = changed.filter((rule) => rule.enabled).map((rule) => matchedSamples(rule, all));
  const count = regions.reduce((sum, region) =>
    sum + DIMENSIONS.reduce((product, dimension) => product * region[dimension].length, 1), 0);
  const rulesChecked = [...before, ...after].filter((rule) => rule.enabled).length;
  if (count * Math.max(1, rulesChecked) > MAX_WORK) return true;

  for (const region of regions) {
    for (const action of actions(region)) {
      if (STRICTNESS[evaluatePolicy(after, action).outcome] < STRICTNESS[evaluatePolicy(before, action).outcome]) return true;
    }
  }
  return false;
}
