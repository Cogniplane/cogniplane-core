import { describe, expect, test } from "vitest";

import type { PolicyConditions, PolicyEffect } from "@cogniplane/shared-types";

import { type EvaluableRule, evaluatePolicy, type PolicyActionContext } from "./policy-engine.js";
import { MAX_WORK, weakensPolicy } from "./policy-weakening.js";

function rule(ruleId: string, effect: PolicyEffect, priority: number, conditions: PolicyConditions = {}, enabled = true): EvaluableRule {
  return { ruleId, name: ruleId, priority, enabled, effect, conditions, reason: null };
}

const BLOCK_EXPORT = rule("r-block", "block", 10, { toolNames: ["export_customers"] });
const APPROVE_WRITES = rule("r-approve", "require_approval", 20, { severities: ["file_change"] });
const ALLOW_ALL = rule("r-allow", "allow", 30);
const RULES = [BLOCK_EXPORT, APPROVE_WRITES, ALLOW_ALL];

function replace(rules: EvaluableRule[], next: EvaluableRule): EvaluableRule[] {
  return rules.map((candidate) => (candidate.ruleId === next.ruleId ? next : candidate));
}

describe("weakensPolicy", () => {
  test("a new rule is weaker only when it gives some tool call a less strict outcome", () => {
    // Before the block rule: the export tool is allowed.
    const allowFirst = rule("r-new", "allow", 0);
    expect(weakensPolicy(RULES, [...RULES, allowFirst], [allowFirst])).toBe(true);
    // At the end: it matches only what was already allowed.
    const allowLast = rule("r-new", "allow", 40);
    expect(weakensPolicy(RULES, [...RULES, allowLast], [allowLast])).toBe(false);
    // A block rule anywhere is never weaker.
    const blockFirst = rule("r-new", "block", 0);
    expect(weakensPolicy(RULES, [...RULES, blockFirst], [blockFirst])).toBe(false);
    // Approval before the block rule makes the export tool less strict.
    const approveFirst = rule("r-new", "require_approval", 0);
    expect(weakensPolicy(RULES, [...RULES, approveFirst], [approveFirst])).toBe(true);
    // An allow rule first that matches no gated tool call is not weaker.
    const allowRead = rule("r-new", "allow", 0, { toolNames: ["read_file"], severities: ["read_only"] });
    expect(weakensPolicy(RULES, [...RULES, allowRead], [allowRead])).toBe(false);
    // A new rule that is off matches nothing.
    const disabled = rule("r-new", "allow", 0, {}, false);
    expect(weakensPolicy(RULES, [...RULES, disabled], [disabled])).toBe(false);
  });

  test("removing or turning off a gating rule is weaker; an allow rule is not", () => {
    expect(weakensPolicy(RULES, RULES.filter((r) => r !== BLOCK_EXPORT), [BLOCK_EXPORT])).toBe(true);
    expect(weakensPolicy(RULES, RULES.filter((r) => r !== ALLOW_ALL), [ALLOW_ALL])).toBe(false);
    const off = { ...BLOCK_EXPORT, enabled: false };
    expect(weakensPolicy(RULES, replace(RULES, off), [BLOCK_EXPORT, off])).toBe(true);
    // A rule that was already off changes nothing when it goes.
    const before = replace(RULES, off);
    expect(weakensPolicy(before, before.filter((r) => r.ruleId !== off.ruleId), [off])).toBe(false);
  });

  test("a later block rule that covers what a removed block rule matched keeps the policy as strict", () => {
    const blockAll = rule("r-block-all", "block", 5);
    const rules = [blockAll, ...RULES];
    expect(weakensPolicy(rules, rules.filter((r) => r !== BLOCK_EXPORT), [BLOCK_EXPORT])).toBe(false);
  });

  test("an edit is weaker when the effect goes down or the matched calls lose a gate", () => {
    const toApproval = { ...BLOCK_EXPORT, effect: "require_approval" as const };
    expect(weakensPolicy(RULES, replace(RULES, toApproval), [BLOCK_EXPORT, toApproval])).toBe(true);
    const toAllow = { ...APPROVE_WRITES, effect: "allow" as const };
    expect(weakensPolicy(RULES, replace(RULES, toAllow), [APPROVE_WRITES, toAllow])).toBe(true);
    const stricter = { ...APPROVE_WRITES, effect: "block" as const };
    expect(weakensPolicy(RULES, replace(RULES, stricter), [APPROVE_WRITES, stricter])).toBe(false);
    // A narrower block rule lets the tool it no longer names through.
    const narrower = { ...BLOCK_EXPORT, conditions: { toolNames: ["export_customers"], turnContexts: ["scheduled" as const] } };
    expect(weakensPolicy(RULES, replace(RULES, narrower), [BLOCK_EXPORT, narrower])).toBe(true);
    // A broader block rule is stricter.
    const broader = { ...BLOCK_EXPORT, conditions: { toolNames: ["export_customers", "delete_customers"] } };
    expect(weakensPolicy(RULES, replace(RULES, broader), [BLOCK_EXPORT, broader])).toBe(false);
    // A block rule moved after the allow rule never matches again.
    const later = { ...BLOCK_EXPORT, priority: 40 };
    expect(weakensPolicy(RULES, replace(RULES, later), [BLOCK_EXPORT, later])).toBe(true);
  });

  test("a rename or a new reason is not weaker", () => {
    const renamed = { ...BLOCK_EXPORT, name: "Block customer exports", reason: "Data stays here." };
    expect(weakensPolicy(RULES, replace(RULES, renamed), [BLOCK_EXPORT, renamed])).toBe(false);
  });

  test("a new order is weaker only when an allow or approval rule moves before a stricter rule that it overlaps", () => {
    const reordered = (ids: string[]) => RULES.map((r) => ({ ...r, priority: ids.indexOf(r.ruleId) * 10 }));
    const moved = (after: EvaluableRule[]) => RULES.filter((r) => after.find((a) => a.ruleId === r.ruleId)!.priority !== r.priority);
    const allowFirst = reordered(["r-allow", "r-block", "r-approve"]);
    expect(weakensPolicy(RULES, allowFirst, moved(allowFirst))).toBe(true);
    // The block and approval rules overlap (the export tool can write), so
    // approval before block is weaker for the export tool's writes.
    const approvalFirst = reordered(["r-approve", "r-block", "r-allow"]);
    expect(weakensPolicy(RULES, approvalFirst, moved(approvalFirst))).toBe(true);
    // The same order, with new priorities.
    const same = reordered(["r-block", "r-approve", "r-allow"]);
    expect(weakensPolicy(RULES, same, moved(same))).toBe(false);
  });

  test("tool names match without regard to case, as in the engine", () => {
    const allowUpper = rule("r-new", "allow", 0, { toolNames: ["EXPORT_CUSTOMERS"] });
    expect(weakensPolicy(RULES, [...RULES, allowUpper], [allowUpper])).toBe(true);
  });

  // The sample for "a tool that no rule names" must not equal a listed name
  // in another case, or it would stand for that name instead.
  test("the sample of an unlisted tool differs from every listed name, also without regard to case", () => {
    const blockNamed = rule("r-named", "block", 0, { toolNames: ["COGNIPLANE-UNLISTED"] });
    const blockAll = rule("r-all", "block", 10);
    const rules = [blockNamed, blockAll];
    expect(weakensPolicy(rules, [blockNamed], [blockAll])).toBe(true);
  });

  test("a check with too much work counts as weaker", () => {
    const many = Array.from({ length: 80 }, (_, index) => rule(`r-${index}`, "block", index, {
      toolNames: [`tool_${index}`], categories: [`server_${index}`]
    }));
    // At the end, this rule is not weaker, but its samples (81 tool names x
    // 82 categories with no value x 2 severities x 2 turn contexts) times the
    // 161 enabled rules before and after are over the limit.
    const allowAll = rule("r-new", "allow", 1000);
    expect(81 * 82 * 2 * 2 * 161).toBeGreaterThan(MAX_WORK);
    expect(weakensPolicy(many, [...many, allowAll], [allowAll])).toBe(true);
    // A rule that names one tool and one server stays well under it.
    const allowOne = rule("r-new", "allow", 1000, { toolNames: ["tool_1"], categories: ["server_1"] });
    expect(weakensPolicy(many, [...many, allowOne], [allowOne])).toBe(false);
  });

  // The samples must cover every case the rules can tell apart. Compare with
  // the engine on many actions, for random rule changes.
  test("agrees with the engine on random rule changes and random actions", () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const pick = <T>(values: readonly T[]) => values[random(values.length)]!;
    const tools = ["a", "B", "c"];
    const categories = ["x", "y"];
    const effects: PolicyEffect[] = ["allow", "require_approval", "block"];
    const randomConditions = (): PolicyConditions => {
      const conditions: PolicyConditions = {};
      if (random(2)) conditions.toolNames = [pick(tools)];
      if (random(2)) conditions.categories = [pick(categories)];
      if (random(3) === 0) conditions.severities = [pick(["read_only", "file_change"] as const)];
      if (random(3) === 0) conditions.turnContexts = [pick(["interactive", "scheduled"] as const)];
      return conditions;
    };
    const randomRule = (id: string) => rule(id, pick(effects), random(5) * 10, randomConditions(), random(5) !== 0);
    const actions: PolicyActionContext[] = [];
    for (const toolName of [...tools, "A", "b", "other"]) {
      for (const category of [...categories, "z", null]) {
        for (const severity of ["read_only", "file_change", null] as const) {
          for (const turnContext of ["interactive", "scheduled", null] as const) {
            actions.push({ toolName, category, severity, serverId: null, turnContext });
          }
        }
      }
    }
    const strictness = { allow: 0, require_approval: 1, block: 2 };
    for (let round = 0; round < 300; round += 1) {
      const before = Array.from({ length: 1 + random(4) }, (_, index) => randomRule(`r${index}`));
      const target = before[random(before.length)]!;
      const edited = { ...randomRule(target.ruleId) };
      const after = replace(before, edited);
      const truth = actions.some((action) =>
        strictness[evaluatePolicy(after, action).outcome] < strictness[evaluatePolicy(before, action).outcome]);
      expect(weakensPolicy(before, after, [target, edited]), JSON.stringify({ before, after })).toBe(truth);
    }
  });
});
