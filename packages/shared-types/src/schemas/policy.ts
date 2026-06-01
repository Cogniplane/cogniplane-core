import { z } from "zod";

import { IsoDateSchema } from "./_helpers.js";

// ── Policy Center primitives ────────────────────────────────────────────────
//
// A policy rule is a tenant-scoped condition→effect statement evaluated for
// each proposed tool action at the MCP gateway choke point. Conditions match on
// tool name, managed-tool category (= the MCP server id), read/write severity,
// and whether the turn is interactive or scheduled.
//
// Effects:
//   allow            — let the action through (explicit, for an early-wins rule)
//   require_approval — pause the action, route a human approval, resume/deny
//   block            — refuse the action with an explanation
//
// Whether a rule actually gates (enforce) or only records a would-have decision
// (monitor) is a TENANT-LEVEL setting (`policyEnforcementMode` on
// tenant_settings), not a per-rule flag: a tenant watches decisions in monitor
// mode, then flips the whole tenant to enforce once the rules are trusted.

export const POLICY_EFFECTS = ["allow", "require_approval", "block"] as const;
export const PolicyEffectSchema = z.enum(POLICY_EFFECTS);
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

// Tenant-level switch. monitor: evaluate + record but never gate. enforce: gate
// matching actions. Lives on tenant_settings; the gateway reads it from the
// runtime-policy snapshot already on the tool-execution context (no extra DB
// call on the hot path).
export const POLICY_ENFORCEMENT_MODES = ["monitor", "enforce"] as const;
export const PolicyEnforcementModeSchema = z.enum(POLICY_ENFORCEMENT_MODES);
export type PolicyEnforcementMode = (typeof POLICY_ENFORCEMENT_MODES)[number];

export const POLICY_SEVERITIES = ["read_only", "file_change", "command_execution"] as const;
export const PolicySeveritySchema = z.enum(POLICY_SEVERITIES);
export type PolicySeverity = (typeof POLICY_SEVERITIES)[number];

// Whether the turn is interactive (a user in the loop) or a scheduled/unattended
// run (the scheduler firing a synthetic turn). Lets a rule treat unattended
// actions more strictly — e.g. block external writes when no human can approve.
export const POLICY_TURN_CONTEXTS = ["interactive", "scheduled"] as const;
export const PolicyTurnContextSchema = z.enum(POLICY_TURN_CONTEXTS);
export type PolicyTurnContext = (typeof POLICY_TURN_CONTEXTS)[number];

// Conditions are AND-ed together; within a dimension the listed values are
// OR-ed. An empty/omitted dimension means "matches anything" for that
// dimension. An all-empty condition set matches every action (a catch-all).
//
// Dimensions:
//   toolNames    — the tool being called (e.g. github_write_file)
//   categories   — the MCP server id the tool is hosted on (one connector per
//                  server today, so this == serverId)
//   severities   — read_only / file_change / command_execution
//   turnContexts — interactive vs scheduled/unattended
//
// The schema is `.passthrough()` so a future dimension (connector, role, PII,
// team/group) can be stored and matched without a schema rewrite — the engine
// learns it, the lint warns on anything outside POLICY_CONDITION_KEYS.
export const PolicyConditionsSchema = z
  .object({
    toolNames: z.array(z.string().min(1)).optional(),
    categories: z.array(z.string().min(1)).optional(),
    severities: z.array(PolicySeveritySchema).optional(),
    turnContexts: z.array(PolicyTurnContextSchema).optional()
  })
  .passthrough();
export type PolicyConditions = z.infer<typeof PolicyConditionsSchema>;

// The dimension keys the engine actually evaluates. `PolicyConditionsSchema` is
// `.passthrough()` so a future dimension can be stored before the engine learns
// it — but that same openness means a typo'd key (e.g. `toolName` instead of
// `toolNames`) is silently dropped by `toConditions` and the rule becomes a
// catch-all. The conflict lint warns on any key outside this set.
export const POLICY_CONDITION_KEYS = [
  "toolNames",
  "categories",
  "severities",
  "turnContexts"
] as const;
export type PolicyConditionKey = (typeof POLICY_CONDITION_KEYS)[number];

export const PolicyRuleSchema = z
  .object({
    ruleId: z.string(),
    tenantId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    priority: z.number().int(),
    enabled: z.boolean(),
    effect: PolicyEffectSchema,
    conditions: PolicyConditionsSchema,
    reason: z.string().nullable(),
    createdBy: z.string().nullable(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema
  })
  .passthrough();
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyRulesListResponseSchema = z
  .object({
    rules: z.array(PolicyRuleSchema)
  })
  .passthrough();
export type PolicyRulesListResponse = z.infer<typeof PolicyRulesListResponseSchema>;

// Single source of truth for rule-body fields, all optional. Create and patch
// are both derived from this so a new field can't be added to one and forgotten
// in the other. `name`/`effect` are made required on the create schema below.
const policyRuleFields = {
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  priority: z.number().int().min(0).max(100000).optional(),
  enabled: z.boolean().optional(),
  effect: PolicyEffectSchema.optional(),
  conditions: PolicyConditionsSchema.optional(),
  reason: z.string().trim().max(2000).nullable().optional()
} as const;

// Create body. `name` and `effect` are required; priority/enabled default
// server-side when omitted.
export const PolicyRuleInputSchema = z
  .object(policyRuleFields)
  .required({ name: true, effect: true })
  .strict();
export type PolicyRuleInput = z.infer<typeof PolicyRuleInputSchema>;

// Patch body — every field optional so a partial update (e.g. just `enabled`)
// is valid. Omitted fields preserve the stored value.
//
// `.strict()` (not `.passthrough()`) so an unknown/typo'd key is rejected with
// 400 rather than passing the non-empty check and producing a silent no-op
// UPDATE + a false "rule updated" audit event. After strict-stripping, the
// refine guarantees the body carried at least one real field.
export const PolicyRulePatchSchema = z
  .object(policyRuleFields)
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Patch must include at least one field to update."
  });
export type PolicyRulePatch = z.infer<typeof PolicyRulePatchSchema>;

export const PolicyRuleEnvelopeSchema = z
  .object({
    rule: PolicyRuleSchema
  })
  .passthrough();
export type PolicyRuleEnvelope = z.infer<typeof PolicyRuleEnvelopeSchema>;

// ── Decisions (evidence) ─────────────────────────────────────────────────────

export const PolicyDecisionSchema = z
  .object({
    decisionId: z.string(),
    tenantId: z.string(),
    sessionId: z.string().nullable(),
    userId: z.string().nullable(),
    runtimeId: z.string().nullable(),
    toolName: z.string(),
    toolCategory: z.string().nullable(),
    severity: PolicySeveritySchema.nullable(),
    serverId: z.string().nullable(),
    matchedRuleId: z.string().nullable(),
    outcome: PolicyEffectSchema,
    enforced: z.boolean(),
    explanation: z.string().nullable(),
    createdAt: IsoDateSchema
  })
  .passthrough();
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

// Server-side filtering + paging for the evidence log. All dimensions are AND-ed;
// within a multi-value dimension the values are OR-ed. Empty/omitted dimensions
// match anything. `before` pins a stable upper time bound so offset paging does
// not drift as new decisions arrive between page loads (captured on first load).
export const POLICY_DECISIONS_PAGE_SIZE = 25;
export const POLICY_DECISIONS_MAX_LIMIT = 500;
// Cap offset so a hand-crafted ?offset=99999999 can't force an expensive deep scan.
export const POLICY_DECISIONS_MAX_OFFSET = 100_000;

export const PolicyDecisionFiltersSchema = z
  .object({
    sessionId: z.string().trim().min(1).optional(),
    outcomes: z.array(PolicyEffectSchema).optional(),
    // Tri-state: omitted = any; true = enforce-mode effects that gated the
    // action; false = recorded-only decisions.
    enforced: z.boolean().optional(),
    toolNames: z.array(z.string().trim().min(1)).optional(),
    severities: z.array(PolicySeveritySchema).optional(),
    // Date-only (YYYY-MM-DD) UTC bounds. `to` is treated as inclusive of the whole
    // day by the store (half-open: created_at < to+1day), so the picked end-day counts.
    from: z.string().optional(),
    to: z.string().optional(),
    before: z.string().optional(),
    limit: z.number().int().min(1).max(POLICY_DECISIONS_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).max(POLICY_DECISIONS_MAX_OFFSET).optional()
  })
  .passthrough();
export type PolicyDecisionFilters = z.infer<typeof PolicyDecisionFiltersSchema>;

export const PolicyDecisionsListResponseSchema = z
  .object({
    decisions: z.array(PolicyDecisionSchema),
    // Total rows matching the filters (ignoring limit/offset); approximate under
    // concurrent inserts, fine for an admin evidence log.
    total: z.number().int().min(0),
    hasMore: z.boolean(),
    // Echo of the clamped paging the server actually applied.
    limit: z.number().int().min(1),
    offset: z.number().int().min(0)
  })
  .passthrough();
export type PolicyDecisionsListResponse = z.infer<typeof PolicyDecisionsListResponseSchema>;

// Detail view: the row plus the redacted action snapshot (omitted from list rows
// to keep payloads lean). The snapshot carries the redacted args and the
// approval disposition when applicable.
export const PolicyDecisionDetailSchema = PolicyDecisionSchema.extend({
  actionSnapshot: z.record(z.string(), z.unknown())
}).passthrough();
export type PolicyDecisionDetail = z.infer<typeof PolicyDecisionDetailSchema>;

export const PolicyDecisionDetailResponseSchema = z
  .object({
    decision: PolicyDecisionDetailSchema
  })
  .passthrough();
export type PolicyDecisionDetailResponse = z.infer<typeof PolicyDecisionDetailResponseSchema>;

// ── Simulator ────────────────────────────────────────────────────────────────
//
// POST /policies/simulate: evaluate a hypothetical action against active rules
// without recording a decision or gating anything.

export const PolicySimulateRequestSchema = z
  .object({
    toolName: z.string().trim().min(1),
    category: z.string().trim().min(1).nullable().optional(),
    severity: PolicySeveritySchema.optional(),
    serverId: z.string().trim().min(1).nullable().optional(),
    turnContext: PolicyTurnContextSchema.nullable().optional()
  })
  .passthrough();
export type PolicySimulateRequest = z.infer<typeof PolicySimulateRequestSchema>;

export const PolicySimulateResponseSchema = z
  .object({
    outcome: PolicyEffectSchema,
    matchedRuleId: z.string().nullable(),
    matchedRuleName: z.string().nullable(),
    // Whether this outcome WOULD gate the action when the tenant is in enforce
    // mode (block / require_approval). The simulator is mode-agnostic — it shows
    // what the rule does, not whether the tenant is currently enforcing.
    enforced: z.boolean(),
    explanation: z.string().nullable()
  })
  .passthrough();
export type PolicySimulateResponse = z.infer<typeof PolicySimulateResponseSchema>;

// ── Conflict / overlap lint ──────────────────────────────────────────────────
//
// GET /admin/policy/lint: a pure analysis of the active rule set for rules that
// can never fire (shadowed by a higher-priority rule whose conditions subsume
// theirs), exact duplicates, and unknown/typo'd condition keys. Conservative by
// design — it reports only what is provable from the condition sets and the
// engine's first-match-wins semantics, never a partial-overlap guess.

export const POLICY_LINT_KINDS = ["shadowed", "duplicate", "unknown_condition"] as const;
export const PolicyLintKindSchema = z.enum(POLICY_LINT_KINDS);
export type PolicyLintKind = (typeof POLICY_LINT_KINDS)[number];

export const PolicyLintWarningSchema = z
  .object({
    kind: PolicyLintKindSchema,
    // The rule the warning is about (the one that can never fire / has the bad key).
    ruleId: z.string(),
    ruleName: z.string(),
    // The higher-priority rule that shadows/duplicates it. Null for unknown_condition.
    conflictsWithRuleId: z.string().nullable(),
    conflictsWithRuleName: z.string().nullable(),
    message: z.string()
  })
  .passthrough();
export type PolicyLintWarning = z.infer<typeof PolicyLintWarningSchema>;

export const PolicyLintResponseSchema = z
  .object({
    warnings: z.array(PolicyLintWarningSchema)
  })
  .passthrough();
export type PolicyLintResponse = z.infer<typeof PolicyLintResponseSchema>;

// ── Reorder (bulk priority rewrite) ──────────────────────────────────────────
//
// PUT /admin/policy/rules/order: the admin sends the full set of the tenant's
// rule IDs in the desired evaluation order; the server rewrites priorities to
// index*10 (gaps for future single inserts) in one transaction. The list must
// be EXACTLY the tenant's current rule set — a missing/extra/unknown ID means
// the admin's view drifted, so the reorder is rejected rather than applied to a
// stale set.

export const PolicyReorderRequestSchema = z
  .object({
    ruleIds: z.array(z.string().min(1)).min(1)
  })
  .passthrough()
  .refine((body) => new Set(body.ruleIds).size === body.ruleIds.length, {
    message: "ruleIds must not contain duplicates."
  });
export type PolicyReorderRequest = z.infer<typeof PolicyReorderRequestSchema>;
