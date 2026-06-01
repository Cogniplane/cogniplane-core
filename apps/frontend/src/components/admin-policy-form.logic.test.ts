import { describe, expect, test } from "vitest";

import type { PolicyRule } from "@cogniplane/shared-types";

import {
  decisionFiltersFromDraft,
  describeConditions,
  draftConditions,
  draftFromRule,
  draftToInput,
  emptyDraft,
  isDraftValid,
  parseCsv,
  toggleInList,
  type DecisionFilterDraft
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
