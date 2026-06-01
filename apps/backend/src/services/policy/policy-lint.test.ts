import { describe, expect, it } from "vitest";

import type { PolicyConditions } from "@cogniplane/shared-types";

import { conditionsSubsume, lintRules, type LintableRule } from "./policy-lint.js";

// Build a lintable rule with sane defaults; override what a test cares about.
let seq = 0;
function rule(overrides: Partial<LintableRule> = {}): LintableRule {
  seq += 1;
  return {
    ruleId: overrides.ruleId ?? `pol_${seq}`,
    name: overrides.name ?? `rule-${seq}`,
    priority: overrides.priority ?? 100,
    enabled: overrides.enabled ?? true,
    conditions: overrides.conditions ?? {}
  };
}

describe("conditionsSubsume", () => {
  it("a wildcard (empty) outer subsumes any inner", () => {
    expect(conditionsSubsume({}, { toolNames: ["a"], severities: ["read_only"] })).toBe(true);
    expect(conditionsSubsume({}, {})).toBe(true);
  });

  it("a constrained outer does NOT subsume a wildcard inner", () => {
    // outer matches only github; inner matches everything → inner admits actions
    // outside outer's set, so outer can't subsume it.
    expect(conditionsSubsume({ categories: ["github"] }, {})).toBe(false);
  });

  it("subsumes when inner is a subset of outer on a dimension", () => {
    expect(
      conditionsSubsume({ categories: ["github", "notion"] }, { categories: ["github"] })
    ).toBe(true);
  });

  it("does not subsume when inner admits a value outside outer", () => {
    expect(
      conditionsSubsume({ categories: ["github"] }, { categories: ["github", "notion"] })
    ).toBe(false);
  });

  it("requires subsumption on EVERY dimension (AND)", () => {
    // outer subsumes on categories but constrains severities while inner doesn't.
    expect(
      conditionsSubsume(
        { categories: ["github"], severities: ["file_change"] },
        { categories: ["github"] }
      )
    ).toBe(false);
  });

  it("treats turnContexts like the other OR-list dimensions (subset)", () => {
    expect(
      conditionsSubsume(
        { turnContexts: ["interactive", "scheduled"] } as PolicyConditions,
        { turnContexts: ["scheduled"] } as PolicyConditions
      )
    ).toBe(true);
    expect(
      conditionsSubsume(
        { turnContexts: ["scheduled"] } as PolicyConditions,
        { turnContexts: ["interactive", "scheduled"] } as PolicyConditions
      )
    ).toBe(false);
  });
});

describe("lintRules — shadowing", () => {
  it("flags a lower-priority rule subsumed by a higher-priority one", () => {
    const high = rule({ ruleId: "pol_high", name: "all github", priority: 10, conditions: { categories: ["github"] } });
    const low = rule({ ruleId: "pol_low", name: "github writes", priority: 20, conditions: { categories: ["github"], severities: ["file_change"] } });
    const warnings = lintRules([low, high]); // pass out of order; lint re-sorts
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "shadowed",
      ruleId: "pol_low",
      conflictsWithRuleId: "pol_high"
    });
  });

  it("is effect-agnostic: structural subset at higher priority shadows regardless of effect", () => {
    // The engine returns the first matching ENABLED rule regardless of effect —
    // an earlier 'allow' consumes the match before a later 'block'. The lint
    // carries no effect, so this is structural: subset conditions at higher
    // priority => shadowed, full stop.
    const allow = rule({ ruleId: "pol_a", priority: 10, conditions: { categories: ["github"] } });
    const block = rule({ ruleId: "pol_b", priority: 20, conditions: { categories: ["github"] } });
    const warnings = lintRules([allow, block]);
    // Identical conditions → duplicate (a clearer shadow), not a generic shadow.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: "duplicate", ruleId: "pol_b", conflictsWithRuleId: "pol_a" });
  });

  it("does NOT flag partial cross-dimension overlap (neither subsumes the other)", () => {
    const a = rule({ priority: 10, conditions: { categories: ["github"] } });
    const b = rule({ priority: 20, conditions: { severities: ["file_change"] } });
    // They overlap on github+file_change actions, but neither matches a superset
    // of the other — a legitimate co-existence, so no warning.
    expect(lintRules([a, b])).toEqual([]);
  });

  it("a disabled higher-priority rule never shadows (engine filters it out)", () => {
    const disabledHigh = rule({ ruleId: "pol_dis", priority: 10, enabled: false, conditions: { categories: ["github"] } });
    const low = rule({ ruleId: "pol_low", priority: 20, conditions: { categories: ["github"] } });
    expect(lintRules([disabledHigh, low])).toEqual([]);
  });

  it("a disabled rule is not itself reported as shadowed", () => {
    const high = rule({ priority: 10, conditions: { categories: ["github"] } });
    const disabledLow = rule({ priority: 20, enabled: false, conditions: { categories: ["github"] } });
    expect(lintRules([high, disabledLow])).toEqual([]);
  });

  it("reports only the FIRST shadower, not every higher-priority superset", () => {
    const first = rule({ ruleId: "pol_1", priority: 10, conditions: {} });
    const second = rule({ ruleId: "pol_2", priority: 20, conditions: {} });
    const third = rule({ ruleId: "pol_3", priority: 30, conditions: {} });
    const warnings = lintRules([first, second, third]);
    // second shadowed by first; third shadowed by first (its first shadower).
    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => w.conflictsWithRuleId === "pol_1")).toBe(true);
  });

  it("uses priority/ruleId order, not input order, to decide precedence", () => {
    const a = rule({ ruleId: "pol_aaa", priority: 50, conditions: {} });
    const b = rule({ ruleId: "pol_bbb", priority: 50, conditions: {} });
    // Same priority → ruleId tie-break: pol_aaa precedes pol_bbb. So bbb is shadowed.
    const warnings = lintRules([b, a]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ ruleId: "pol_bbb", conflictsWithRuleId: "pol_aaa" });
  });
});

describe("lintRules — duplicate", () => {
  it("flags equivalent conditions as duplicate (the clearer shadow)", () => {
    const high = rule({ ruleId: "pol_h", priority: 10, conditions: { categories: ["github"], severities: ["file_change"] } });
    const low = rule({ ruleId: "pol_l", priority: 20, conditions: { severities: ["file_change"], categories: ["github"] } });
    const warnings = lintRules([high, low]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("duplicate");
    expect(warnings[0].message).toContain("same conditions");
  });
});

describe("lintRules — unknown_condition", () => {
  it("flags a typo'd condition key", () => {
    // `toolName` (singular) is not a known dimension; toConditions would drop it,
    // turning this into an unintended catch-all.
    const r = rule({ ruleId: "pol_typo", conditions: { toolName: ["github_write"] } as unknown as PolicyConditions });
    const warnings = lintRules([r]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: "unknown_condition", ruleId: "pol_typo", conflictsWithRuleId: null });
    expect(warnings[0].message).toContain("toolName");
  });

  it("flags unknown keys even on a disabled rule", () => {
    const r = rule({ enabled: false, conditions: { bogus: ["x"] } as unknown as PolicyConditions });
    expect(lintRules([r]).some((w) => w.kind === "unknown_condition")).toBe(true);
  });

  it("ignores known keys", () => {
    const r = rule({ conditions: { toolNames: ["a"], turnContexts: ["scheduled"] } });
    expect(lintRules([r])).toEqual([]);
  });
});

describe("lintRules — empty / clean sets", () => {
  it("returns no warnings for an empty rule set", () => {
    expect(lintRules([])).toEqual([]);
  });

  it("returns no warnings for non-overlapping rules", () => {
    const a = rule({ priority: 10, conditions: { categories: ["github"] } });
    const b = rule({ priority: 20, conditions: { categories: ["notion"] } });
    expect(lintRules([a, b])).toEqual([]);
  });
});
