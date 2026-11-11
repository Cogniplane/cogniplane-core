import { describe, expect, test } from "vitest";

import type { PolicyRule } from "@cogniplane/shared-types";

import {
  decisionFiltersFromDraft,
  describeConditions,
  draftConditions,
  draftFromRule,
  draftToInput,
  draftToPatch,
  EFFECT_LABELS,
  emptyDraft,
  isDraftValid,
  keepDraftChanges,
  parseCsv,
  reorderedRuleIds,
  ruleConflictRows,
  toggleInList,
  type DecisionFilterDraft,
  type PolicyRuleDraft
} from "./admin-policy-form.logic";

function rule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    ruleId: "pol_1",
    tenantId: "t1",
    name: "Block GH writes",
    description: null,
    priority: 50,
    enabled: true,
    effect: "block",
    conditions: { toolNames: ["github_write_file"], categories: ["github"], severities: ["file_change"] },
    reason: "External writes need review.",
    createdBy: "admin",
    revision: 1,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    ...overrides
  };
}

describe("emptyDraft", () => {
  test("defaults to require_approval and empty conditions", () => {
    const d = emptyDraft();
    expect(d.ruleId).toBeNull();
    expect(d.effect).toBe("require_approval");
    expect(d.severities).toEqual([]);
    expect(d.turnContexts).toEqual([]);
  });
});

test("require_approval is labeled as actor confirmation", () => {
  expect(EFFECT_LABELS.require_approval).toBe("Require actor confirmation");
});

describe("draftFromRule / draftToInput round-trip", () => {
  test("draftFromRule flattens conditions into editable text + checkbox sets", () => {
    const d = draftFromRule(rule());
    expect(d.ruleId).toBe("pol_1");
    expect(d.toolNamesText).toBe("github_write_file");
    expect(d.categoriesText).toBe("github");
    expect(d.severities).toEqual(["file_change"]);
    expect(d.reason).toBe("External writes need review.");
  });

  test("draftToInput normalizes text back into condition arrays", () => {
    const input = draftToInput(draftFromRule(rule()));
    expect(input.conditions).toEqual({
      toolNames: ["github_write_file"],
      categories: ["github"],
      severities: ["file_change"]
    });
    expect(input.effect).toBe("block");
    expect(input.reason).toBe("External writes need review.");
  });

  test("round-trips a turnContexts condition", () => {
    const d = draftFromRule(rule({ conditions: { turnContexts: ["scheduled"] } }));
    expect(d.turnContexts).toEqual(["scheduled"]);
    expect(draftToInput(d).conditions).toEqual({ turnContexts: ["scheduled"] });
  });
});

describe("draftConditions", () => {
  test("trims and drops empty CSV entries", () => {
    const d = { ...emptyDraft(), toolNamesText: " a , , b ,", categoriesText: "" };
    expect(draftConditions(d)).toEqual({ toolNames: ["a", "b"] });
  });

  test("omits empty dimensions entirely (catch-all rule)", () => {
    expect(draftConditions(emptyDraft())).toEqual({});
  });

  test("carries severities and turnContexts checkbox sets", () => {
    const conditions = draftConditions({
      ...emptyDraft(),
      severities: ["file_change"],
      turnContexts: ["scheduled"]
    });
    expect(conditions).toMatchObject({ severities: ["file_change"], turnContexts: ["scheduled"] });
  });
});

describe("draftToInput", () => {
  test("blank reason normalizes to null", () => {
    const input = draftToInput({ ...emptyDraft(), name: "R", reason: "   " });
    expect(input.reason).toBeNull();
  });

  test("never sends mode/priority/transform (tenant-level mode + drag-order)", () => {
    const input = draftToInput({ ...emptyDraft(), name: "R" });
    expect("mode" in input).toBe(false);
    expect("priority" in input).toBe(false);
    expect("transform" in input).toBe(false);
  });
});

describe("toggleInList", () => {
  test("adds idempotently and removes", () => {
    expect(toggleInList<string>([], "a", true)).toEqual(["a"]);
    expect(toggleInList(["a"], "a", true)).toEqual(["a"]);
    expect(toggleInList(["a", "b"], "a", false)).toEqual(["b"]);
  });
});

describe("parseCsv", () => {
  test("splits, trims, and drops empties", () => {
    expect(parseCsv("a, b ,, c")).toEqual(["a", "b", "c"]);
  });
});

describe("isDraftValid", () => {
  test("requires a non-empty name", () => {
    expect(isDraftValid({ ...emptyDraft(), name: "" })).toBe(false);
    expect(isDraftValid({ ...emptyDraft(), name: "  " })).toBe(false);
    expect(isDraftValid({ ...emptyDraft(), name: "Rule" })).toBe(true);
  });
});

describe("describeConditions", () => {
  test("summarizes populated dimensions", () => {
    expect(describeConditions(rule().conditions)).toBe(
      "tools: github_write_file · categories: github · severity: file_change"
    );
  });

  test("renders turnContexts", () => {
    expect(describeConditions({ turnContexts: ["scheduled"] })).toBe("turn: scheduled");
  });

  test("empty conditions read as 'any action'", () => {
    expect(describeConditions({})).toBe("any action");
  });
});

describe("decisionFiltersFromDraft", () => {
  test("drops 'any'/empty dimensions and wraps single selects into arrays", () => {
    const draft: DecisionFilterDraft = {
      outcome: "block",
      enforced: "true",
      severity: "any",
      toolText: "a, b",
      from: "",
      to: "2026-05-31"
    };
    expect(decisionFiltersFromDraft(draft)).toEqual({
      outcomes: ["block"],
      enforced: true,
      severities: undefined,
      toolNames: ["a", "b"],
      from: undefined,
      to: "2026-05-31"
    });
  });

  test("an all-'any' draft yields an all-undefined filter", () => {
    const draft: DecisionFilterDraft = {
      outcome: "any",
      enforced: "any",
      severity: "any",
      toolText: "",
      from: "",
      to: ""
    };
    expect(decisionFiltersFromDraft(draft)).toEqual({
      outcomes: undefined,
      enforced: undefined,
      severities: undefined,
      toolNames: undefined,
      from: undefined,
      to: undefined
    });
  });
});

describe("reorderedRuleIds", () => {
  const rules = [rule({ ruleId: "a" }), rule({ ruleId: "b" }), rule({ ruleId: "c" })];

  test("moves the dragged rule into the place of the rule it was dropped on", () => {
    expect(reorderedRuleIds(rules, "a", "c")).toEqual(["b", "c", "a"]);
    expect(reorderedRuleIds(rules, "c", "a")).toEqual(["c", "a", "b"]);
    expect(reorderedRuleIds(rules, "b", "c")).toEqual(["a", "c", "b"]);
  });

  test("changes nothing for a drop on itself or on an unknown rule", () => {
    expect(reorderedRuleIds(rules, "b", "b")).toBeNull();
    expect(reorderedRuleIds(rules, "missing", "a")).toBeNull();
    expect(reorderedRuleIds(rules, "a", "missing")).toBeNull();
  });

  test("leaves the given list unchanged", () => {
    reorderedRuleIds(rules, "a", "c");
    expect(rules.map((r) => r.ruleId)).toEqual(["a", "b", "c"]);
  });
});

describe("draftToPatch", () => {
  test("sends every form field and the revision of the rule that the draft started from", () => {
    const base = rule({ revision: 4 });
    const draft = { ...draftFromRule(base), name: "  Block all GH writes " };
    expect(draftToPatch(draft, base)).toEqual({ ...draftToInput(draft), name: "Block all GH writes", expectedRevision: 4 });
  });
});

// Admin A opened `base`. Admin B saved `saved`. A's form is `draft`.
describe("rule conflict review", () => {
  const base = rule({ name: "Allow exports", effect: "allow", enabled: false, conditions: { toolNames: ["export_customers"] }, reason: null });
  const saved = rule({ name: "Allow exports", effect: "block", enabled: true, conditions: { toolNames: ["export_customers"] }, reason: null, revision: 2 });

  test("lists each field where the saved rule and the draft differ, and who changed it", () => {
    const draft = { ...draftFromRule(base), name: "Allow customer exports", effect: "require_approval" as const };
    expect(ruleConflictRows(base, saved, draft)).toEqual([
      { field: "name", label: "Name", saved: "Allow exports", draft: "Allow customer exports", changedBy: "you" },
      { field: "effect", label: "Effect", saved: "Block", draft: "Require actor confirmation", changedBy: "both" },
      { field: "enabled", label: "Enabled", saved: "On", draft: "Off", changedBy: "someone else" }
    ]);
  });

  test("compares stored values, not how the form spells them", () => {
    const sameBase = rule({ conditions: { categories: ["github"], severities: ["read_only", "file_change"] } });
    const draft: PolicyRuleDraft = {
      ...draftFromRule(sameBase), name: ` ${sameBase.name} `, categoriesText: "github, ", severities: ["file_change", "read_only"]
    };
    expect(ruleConflictRows(sameBase, { ...sameBase, revision: 2 }, draft)).toEqual([]);
  });

  test("keep my changes: the fields that the admin changed stay, every other field takes the saved value", () => {
    const draft = { ...draftFromRule(base), name: "Allow customer exports", reason: "Exports go to the CRM." };
    const kept = keepDraftChanges(base, saved, draft);
    expect(kept).toEqual({
      ...draftFromRule(saved),
      name: "Allow customer exports",
      reason: "Exports go to the CRM."
    });
    // The newer save's stricter values are not reverted.
    expect(draftToPatch(kept, saved)).toMatchObject({ effect: "block", enabled: true, expectedRevision: 2 });
  });

  test("keep my changes keeps the admin's value of a field that both changed, as typed", () => {
    const draft = { ...draftFromRule(base), effect: "require_approval" as const, toolNamesText: "export_customers,  export_orders" };
    const kept = keepDraftChanges(base, { ...saved, conditions: { toolNames: ["export_all"] } }, draft);
    expect(kept.effect).toBe("require_approval");
    expect(kept.toolNamesText).toBe("export_customers,  export_orders");
    expect(kept.enabled).toBe(true);
  });
});


test("conflict merging distinguishes literal labels from absent conditions and explanation", () => {
  const base = rule({ conditions: {}, reason: null });
  const saved = rule({ conditions: {}, reason: null, revision: 2, effect: "require_approval" });
  const draft = { ...draftFromRule(base), toolNamesText: "Any", reason: "None" };
  expect(ruleConflictRows(base, saved, draft).map(row => row.field)).toContain("toolNames");
  expect(ruleConflictRows(base, saved, draft).map(row => row.field)).toContain("reason");
  expect(keepDraftChanges(base, saved, draft)).toMatchObject({ toolNamesText: "Any", reason: "None" });
});
