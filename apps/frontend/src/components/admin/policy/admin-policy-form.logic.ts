import {
  POLICY_EFFECTS,
  POLICY_SEVERITIES,
  POLICY_TURN_CONTEXTS,
  type PolicyConditions,
  type PolicyEffect,
  type PolicyRule,
  type PolicyRuleInput,
  type PolicyRulePatch,
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

/**
 * The PATCH body of an edited rule: every form field, and the revision of the
 * saved rule that the draft started from. The server refuses the save when
 * the rule has another revision.
 */
export function draftToPatch(draft: PolicyRuleDraft, base: PolicyRule): PolicyRulePatch {
  return { ...draftToInput(draft), expectedRevision: base.revision };
}

/** A rule save: a new rule, or an edit with the revision that it is based on. */
export type PolicyRuleSave =
  | { ruleId: null; input: PolicyRuleInput }
  | { ruleId: string; patch: PolicyRulePatch };

/**
 * How a save ended. `conflict`: the rule has a newer revision. `missing`: the
 * rule was deleted. Both keep the draft; the editor shows why.
 */
export type PolicyRuleSaveResult = "saved" | "conflict" | "missing" | "failed";

// ── Stale edit review ────────────────────────────────────────────────────────
//
// After a newer revision, the editor shows the saved rule next to the draft.
// `base` is the saved rule that the draft started from. A field that differs
// from it was changed by the admin, by the newer save, or by both.

type RuleField = "name" | "effect" | "enabled" | "toolNames" | "categories" | "severities" | "turnContexts" | "reason";

// Each field and the draft key that holds it.
const RULE_FIELDS: ReadonlyArray<{ field: RuleField; label: string; key: keyof PolicyRuleDraft }> = [
  { field: "name", label: "Name", key: "name" },
  { field: "effect", label: "Effect", key: "effect" },
  { field: "enabled", label: "Enabled", key: "enabled" },
  { field: "toolNames", label: "Tool names", key: "toolNamesText" },
  { field: "categories", label: "Categories / servers", key: "categoriesText" },
  { field: "severities", label: "Severities", key: "severities" },
  { field: "turnContexts", label: "Turn context", key: "turnContexts" },
  { field: "reason", label: "Explanation", key: "reason" }
];

/** A field as the save stores it, in words. Equal text means an equal stored value. */
function fieldText(draft: PolicyRuleDraft, field: RuleField): string {
  switch (field) {
    case "name": return draft.name.trim();
    case "effect": return EFFECT_LABELS[draft.effect];
    case "enabled": return draft.enabled ? "On" : "Off";
    case "toolNames": return parseCsv(draft.toolNamesText).join(", ") || "Any";
    case "categories": return parseCsv(draft.categoriesText).join(", ") || "Any";
    case "severities": return ALL_SEVERITIES.filter((value) => draft.severities.includes(value)).map((value) => SEVERITY_LABELS[value]).join(", ") || "Any";
    case "turnContexts": return ALL_TURN_CONTEXTS.filter((value) => draft.turnContexts.includes(value)).map((value) => TURN_CONTEXT_LABELS[value]).join(", ") || "Any";
    case "reason": return draft.reason.trim() || "None";
  }
}

// Compare stored values separately from labels such as "Any" and "None".
function fieldValue(draft: PolicyRuleDraft, field: RuleField): string {
  const input = draftToInput(draft);
  const value = field === "toolNames" || field === "categories" || field === "severities" || field === "turnContexts"
    ? [...(input.conditions?.[field] ?? [])].sort()
    : input[field];
  return JSON.stringify(value);
}

export type RuleConflictRow = {
  field: RuleField;
  label: string;
  saved: string;
  draft: string;
  changedBy: "you" | "someone else" | "both";
};

/** The fields where the saved rule and the draft differ, in form order. */
export function ruleConflictRows(base: PolicyRule, saved: PolicyRule, draft: PolicyRuleDraft): RuleConflictRow[] {
  const baseDraft = draftFromRule(base);
  const savedDraft = draftFromRule(saved);
  return RULE_FIELDS.flatMap(({ field, label }) => {
    const savedText = fieldText(savedDraft, field);
    const draftText = fieldText(draft, field);
    if (fieldValue(savedDraft, field) === fieldValue(draft, field)) return [];
    const mine = fieldValue(draft, field) !== fieldValue(baseDraft, field);
    const theirs = fieldValue(savedDraft, field) !== fieldValue(baseDraft, field);
    return [{ field, label, saved: savedText, draft: draftText, changedBy: mine && theirs ? "both" : mine ? "you" : "someone else" }];
  });
}

/**
 * "Keep my changes": each field that the admin changed keeps the draft value,
 * as typed. Every other field takes the saved value, so the save does not
 * undo a field that only the newer save changed.
 */
export function keepDraftChanges(base: PolicyRule, saved: PolicyRule, draft: PolicyRuleDraft): PolicyRuleDraft {
  const baseDraft = draftFromRule(base);
  const next: PolicyRuleDraft = { ...draftFromRule(saved) };
  for (const { field, key } of RULE_FIELDS) {
    if (fieldValue(draft, field) !== fieldValue(baseDraft, field)) Object.assign(next, { [key]: draft[key] });
  }
  return next;
}

// Add/remove a value from a checkbox-set dimension, idempotently. Generic over
// the dimension's value type (severities/turnContexts both use it).
export function toggleInList<T>(list: T[], value: T, on: boolean): T[] {
  if (on) {
    return list.includes(value) ? list : [...list, value];
  }
  return list.filter((entry) => entry !== value);
}

/**
 * The rule order after a drag moves `activeId` onto `overId`'s place, or null
 * when the drop changes nothing (dropped on itself or outside a known rule).
 */
export function reorderedRuleIds(rules: readonly PolicyRule[], activeId: unknown, overId: unknown): string[] | null {
  if (activeId === overId) return null;
  const oldIndex = rules.findIndex((r) => r.ruleId === activeId);
  const newIndex = rules.findIndex((r) => r.ruleId === overId);
  if (oldIndex === -1 || newIndex === -1) return null;
  const ids = rules.map((r) => r.ruleId);
  const [moved] = ids.splice(oldIndex, 1);
  ids.splice(newIndex, 0, moved!);
  return ids;
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
  require_approval: "Require actor confirmation",
  block: "Block"
};

// `command_execution` never matches an action: the gateway derives severity
// from the tool's read/write flag alone, and the shell built-in is gated by the
// runtime's own approval interrupt instead. The label says so rather than
// hiding the option, because older rules and decisions can still carry it.
export const SEVERITY_LABELS: Record<PolicySeverity, string> = {
  read_only: "Read-only",
  file_change: "File change",
  command_execution: "Command (legacy — matches nothing)"
};

export const TURN_CONTEXT_LABELS: Record<PolicyTurnContext, string> = {
  interactive: "Interactive",
  scheduled: "Scheduled / unattended"
};
