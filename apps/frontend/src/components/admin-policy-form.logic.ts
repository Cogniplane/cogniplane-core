import {
  POLICY_EFFECTS,
  POLICY_SEVERITIES,
  POLICY_TURN_CONTEXTS,
  type PolicyConditions,
  type PolicyEffect,
  type PolicyRule,
  type PolicyRuleInput,
  type PolicySeverity,
  type PolicyTurnContext
} from "@cogniplane/shared-types";

// A rule's editable form state. Conditions are edited as comma-separated text for
// tool names / categories + checkbox sets for severities and turn contexts, then
// normalized on submit. Priority is NOT edited here — new rules append to the end
// and ordering is changed by drag-and-drop in the list.
export type PolicyRuleDraft = {
  ruleId: string | null;
  name: string;
  enabled: boolean;
  effect: PolicyEffect;
  toolNamesText: string;
  categoriesText: string;
  severities: PolicySeverity[];
  turnContexts: PolicyTurnContext[];
  reason: string;
};

// The UI's checkbox/select option lists are the schema's enum constants verbatim
// — aliased (not re-typed) so a new enum value added to the Zod schema renders a
// control here automatically and can never drift from the server's accepted set.
export const ALL_SEVERITIES = POLICY_SEVERITIES;
export const ALL_TURN_CONTEXTS = POLICY_TURN_CONTEXTS;
export const ALL_EFFECTS = POLICY_EFFECTS;

export function emptyDraft(): PolicyRuleDraft {
  return {
    ruleId: null,
    name: "",
    enabled: true,
    effect: "require_approval",
    toolNamesText: "",
    categoriesText: "",
    severities: [],
    turnContexts: [],
    reason: ""
  };
}

export function draftFromRule(rule: PolicyRule): PolicyRuleDraft {
  return {
    ruleId: rule.ruleId,
    name: rule.name,
    enabled: rule.enabled,
    effect: rule.effect,
    toolNamesText: (rule.conditions.toolNames ?? []).join(", "),
    categoriesText: (rule.conditions.categories ?? []).join(", "),
    severities: rule.conditions.severities ?? [],
    turnContexts: rule.conditions.turnContexts ?? [],
    reason: rule.reason ?? ""
  };
}

export function parseCsv(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// The decisions-card filter bar's local draft state (enum singles edited as a
// select with an "any" sentinel, tool names as comma-separated text, dates as
// YYYY-MM-DD strings). Mapped to the API filter shape on "Apply".
export type DecisionFilterDraft = {
  outcome: PolicyEffect | "any";
  enforced: "any" | "true" | "false";
  severity: PolicySeverity | "any";
  toolText: string;
  from: string;
  to: string;
};

export type DecisionFilterValue = {
  outcomes?: PolicyEffect[];
  enforced?: boolean;
  severities?: PolicySeverity[];
  toolNames?: string[];
  from?: string;
  to?: string;
};

// Translate the filter-bar draft into the API filter object: drop "any"/empty
// dimensions entirely (an omitted dimension matches anything), wrap the single
// enum selects into the multi-value arrays the API takes.
export function decisionFiltersFromDraft(draft: DecisionFilterDraft): DecisionFilterValue {
  const toolNames = parseCsv(draft.toolText);
  return {
    outcomes: draft.outcome === "any" ? undefined : [draft.outcome],
    enforced: draft.enforced === "any" ? undefined : draft.enforced === "true",
    severities: draft.severity === "any" ? undefined : [draft.severity],
    toolNames: toolNames.length > 0 ? toolNames : undefined,
    from: draft.from || undefined,
    to: draft.to || undefined
  };
}

export function draftConditions(draft: PolicyRuleDraft): PolicyConditions {
  const conditions: PolicyConditions = {};
  const toolNames = parseCsv(draft.toolNamesText);
  const categories = parseCsv(draft.categoriesText);
  if (toolNames.length > 0) conditions.toolNames = toolNames;
  if (categories.length > 0) conditions.categories = categories;
  if (draft.severities.length > 0) conditions.severities = draft.severities;
  if (draft.turnContexts.length > 0) conditions.turnContexts = draft.turnContexts;
  return conditions;
}

export function draftToInput(draft: PolicyRuleDraft): PolicyRuleInput {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    effect: draft.effect,
    conditions: draftConditions(draft),
    reason: draft.reason.trim() ? draft.reason.trim() : null
  };
}

// Add/remove a value from a checkbox-set dimension, idempotently. Generic over
// the dimension's value type (severities/turnContexts both use it).
export function toggleInList<T>(list: T[], value: T, on: boolean): T[] {
  if (on) {
    return list.includes(value) ? list : [...list, value];
  }
  return list.filter((entry) => entry !== value);
}

/** A draft is submittable with a non-empty name. */
export function isDraftValid(draft: PolicyRuleDraft): boolean {
  return draft.name.trim().length > 0;
}

// Human-readable one-liner describing what a rule matches, for the list view.
export function describeConditions(conditions: PolicyConditions): string {
  const parts: string[] = [];
  if (conditions.toolNames?.length) parts.push(`tools: ${conditions.toolNames.join(", ")}`);
  if (conditions.categories?.length) parts.push(`categories: ${conditions.categories.join(", ")}`);
  if (conditions.severities?.length) parts.push(`severity: ${conditions.severities.join(", ")}`);
  if (conditions.turnContexts?.length) parts.push(`turn: ${conditions.turnContexts.join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : "any action";
}

export const EFFECT_LABELS: Record<PolicyEffect, string> = {
  allow: "Allow",
  require_approval: "Require approval",
  block: "Block"
};

export const SEVERITY_LABELS: Record<PolicySeverity, string> = {
  read_only: "Read-only",
  file_change: "File change",
  command_execution: "Command"
};

export const TURN_CONTEXT_LABELS: Record<PolicyTurnContext, string> = {
  interactive: "Interactive",
  scheduled: "Scheduled / unattended"
};
