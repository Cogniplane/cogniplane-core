import { test, expect } from "vitest";

import { evaluatePolicy, type EvaluableRule, type PolicyActionContext } from "./policy-engine.js";

function rule(overrides: Partial<EvaluableRule> = {}): EvaluableRule {
  return {
    ruleId: "pol_1",
    name: "Rule",
    priority: 100,
    enabled: true,
    effect: "block",
    conditions: {},
    reason: null,
    ...overrides
  };
}

const action: PolicyActionContext = {
  toolName: "github_write_file",
  category: "github",
  severity: "file_change",
  serverId: "github",
  turnContext: "interactive"
};

test("no rules → default allow, nothing matched, not gating", () => {
  const result = evaluatePolicy([], action);
  expect(result.outcome).toBe("allow");
  expect(result.matchedRuleId).toBeNull();
  expect(result.gating).toBe(false);
  expect(result.explanation).toBeNull();
});

test("a catch-all rule (empty conditions) matches every action", () => {
  const result = evaluatePolicy([rule({ conditions: {}, effect: "block" })], action);
  expect(result.outcome).toBe("block");
  expect(result.matchedRuleId).toBe("pol_1");
  expect(result.gating).toBe(true);
});

test("toolNames condition matches by exact tool name", () => {
  const matched = evaluatePolicy(
    [rule({ conditions: { toolNames: ["github_write_file"] } })],
    action
  );
  expect(matched.matchedRuleId).toBe("pol_1");

  const notMatched = evaluatePolicy(
    [rule({ conditions: { toolNames: ["notion_create_page"] } })],
    action
  );
  expect(notMatched.matchedRuleId).toBeNull();
  expect(notMatched.outcome).toBe("allow");
});

test("conditions are AND-ed across dimensions", () => {
  // Tool matches but severity does not → no match.
  const result = evaluatePolicy(
    [rule({ conditions: { toolNames: ["github_write_file"], severities: ["read_only"] } })],
    action
  );
  expect(result.matchedRuleId).toBeNull();
});

test("values within a dimension are OR-ed", () => {
  const result = evaluatePolicy(
    [rule({ conditions: { severities: ["read_only", "file_change"] } })],
    action
  );
  expect(result.matchedRuleId).toBe("pol_1");
});

test("malformed conditions (non-array dimension) degrade to a catch-all, never throw", () => {
  // conditions arrive from JSONB and could be corrupt (object/string instead of
  // an array). The engine must not crash the hot path — a bad dimension is
  // treated as "no constraint" so the rule still matches rather than throwing.
  const badObject = evaluatePolicy(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [rule({ conditions: { toolNames: { x: 1 } } as any })],
    action
  );
  expect(badObject.matchedRuleId).toBe("pol_1");

  const badString = evaluatePolicy(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [rule({ conditions: { categories: "github" } as any })],
    action
  );
  expect(badString.matchedRuleId).toBe("pol_1");
});

test("a null action dimension never matches a constrained condition", () => {
  const result = evaluatePolicy(
    [rule({ conditions: { categories: ["github"] } })],
    {
      toolName: "x",
      category: null,
      severity: null,
      serverId: null,
      turnContext: null
    }
  );
  expect(result.matchedRuleId).toBeNull();
});

test("turnContexts dimension distinguishes scheduled from interactive", () => {
  const scheduled: PolicyActionContext = { ...action, turnContext: "scheduled" };
  const interactive: PolicyActionContext = { ...action, turnContext: "interactive" };
  const r = rule({ conditions: { turnContexts: ["scheduled"] } });
  expect(evaluatePolicy([r], scheduled).matchedRuleId).toBe("pol_1");
  expect(evaluatePolicy([r], interactive).matchedRuleId).toBeNull();
});

test("categories dimension matches the MCP server id", () => {
  const r = rule({ conditions: { categories: ["github"] } });
  expect(evaluatePolicy([r], action).matchedRuleId).toBe("pol_1");
  expect(
    evaluatePolicy([r], { ...action, category: "notion" }).matchedRuleId
  ).toBeNull();
});

test("dimensions AND together", () => {
  // Block file_change on scheduled turns via github.
  const r = rule({
    effect: "block",
    conditions: {
      categories: ["github"],
      severities: ["file_change"],
      turnContexts: ["scheduled"]
    }
  });
  const matching: PolicyActionContext = {
    ...action,
    category: "github",
    severity: "file_change",
    turnContext: "scheduled"
  };
  expect(evaluatePolicy([r], matching).gating).toBe(true);
  // Flip just the turn context → no match (AND across dimensions).
  expect(evaluatePolicy([r], { ...matching, turnContext: "interactive" }).matchedRuleId).toBeNull();
});

test("disabled rules are skipped", () => {
  const result = evaluatePolicy([rule({ enabled: false, effect: "block" })], action);
  expect(result.outcome).toBe("allow");
  expect(result.matchedRuleId).toBeNull();
});

test("lowest priority number wins; ruleId breaks ties deterministically", () => {
  const result = evaluatePolicy(
    [
      rule({ ruleId: "pol_b", priority: 10, effect: "block" }),
      rule({ ruleId: "pol_a", priority: 10, effect: "allow" }),
      rule({ ruleId: "pol_c", priority: 5, effect: "require_approval" })
    ],
    action
  );
  // priority 5 wins outright.
  expect(result.matchedRuleId).toBe("pol_c");
  expect(result.outcome).toBe("require_approval");
});

test("priority tie falls back to ruleId ascending", () => {
  const result = evaluatePolicy(
    [
      rule({ ruleId: "pol_b", priority: 10, effect: "block" }),
      rule({ ruleId: "pol_a", priority: 10, effect: "allow" })
    ],
    action
  );
  expect(result.matchedRuleId).toBe("pol_a");
  expect(result.outcome).toBe("allow");
});

test("engine sorts defensively even if input is mis-ordered", () => {
  // Same rules, reversed input order — decision must be identical.
  const rules = [
    rule({ ruleId: "pol_low", priority: 200, effect: "block" }),
    rule({ ruleId: "pol_high", priority: 1, effect: "allow" })
  ];
  expect(evaluatePolicy(rules, action).matchedRuleId).toBe("pol_high");
  expect(evaluatePolicy(rules.slice().reverse(), action).matchedRuleId).toBe("pol_high");
});

test("gating is the rule's intent: block / require_approval gate, allow does not", () => {
  expect(evaluatePolicy([rule({ effect: "block" })], action).gating).toBe(true);
  expect(evaluatePolicy([rule({ effect: "require_approval" })], action).gating).toBe(true);
  expect(evaluatePolicy([rule({ effect: "allow" })], action).gating).toBe(false);
  // No match → allow → not gating.
  expect(evaluatePolicy([], action).gating).toBe(false);
});

test("custom reason overrides the default explanation", () => {
  const result = evaluatePolicy(
    [rule({ effect: "block", reason: "GitHub writes require a ticket." })],
    action
  );
  expect(result.explanation).toBe("GitHub writes require a ticket.");
});

test("default explanation names the rule and effect", () => {
  const result = evaluatePolicy([rule({ name: "Block GH writes", effect: "block" })], action);
  expect(result.explanation).toContain("Block GH writes");
  expect(result.explanation).toContain("blocked");
});

test("require_approval explanation says the action is routed for approval", () => {
  const result = evaluatePolicy([rule({ effect: "require_approval" })], action);
  expect(result.explanation).toContain("routed for approval");
  expect(result.explanation).not.toContain("blocked");
});
