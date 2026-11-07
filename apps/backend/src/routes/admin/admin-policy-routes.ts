import { parseRequestInput } from "../../lib/route-validation.js";
import type { FastifyInstance } from "fastify";

import {
  PolicyDecisionDetailResponseSchema,
  PolicyDecisionFiltersSchema,
  PolicyDecisionsListResponseSchema,
  PolicyLintResponseSchema,
  PolicyMonitorSummaryResponseSchema,
  PolicyReorderRequestSchema,
  PolicyRuleEnvelopeSchema,
  PolicyRuleInputSchema,
  PolicyRulePatchSchema,
  PolicyRulesListResponseSchema,
  PolicySimulateRequestSchema,
  PolicySimulateResponseSchema,
  z
} from "@cogniplane/shared-types";
import type { PolicyDecisionFilters, PolicyRule } from "@cogniplane/shared-types";
import type { FastifyRequest } from "fastify";

import { serialize } from "../../lib/serialize-response.js";
import type { AuditEventInput } from "../../services/audit-event-store.js";
import type { AuditEventType } from "../../services/audit-event-types.js";
import type { DataRouteControl } from "../../services/data-route-control.js";
import type { PolicyRuleChange } from "../../services/mail/setting-change-notices.js";
import type { PolicyDecisionStore } from "../../services/policy/policy-decision-store.js";
import { lintRules } from "../../services/policy/policy-lint.js";
import {
  PolicyReorderMismatchError,
  type PolicyRuleStore
} from "../../services/policy/policy-rule-store.js";
import type { PolicyService } from "../../services/policy/policy-service.js";

import {
  configError,
  respondAdminMutationError,
  respondAdminNotFound,
  withAdmin
} from "./admin-route-helpers.js";

export type PolicyRouteStores = {
  policyRules: Pick<
    PolicyRuleStore,
    "create" | "delete" | "list" | "listForLint" | "reorder" | "update"
  >;
  policyDecisions: Pick<PolicyDecisionStore, "get" | "list" | "summarizeMonitor">;
  policyService: Pick<PolicyService, "evaluate" | "invalidate">;
  /**
   * Step-up and owner notice of a rule change that makes the policy weaker
   * (policy-weakening.ts): a stolen admin token must not open a tool that a
   * rule blocks or routes for approval. The store classifies the change in
   * its transaction; other changes need neither.
   */
  dataRoutes: Pick<DataRouteControl, "writeWithStepUpIfWeaker" | "ownerNotice">;
  /** Clock for the monitor summary window. Tests pin it. */
  now?: () => Date;
};

const ruleIdParamsSchema = z.object({ ruleId: z.string().min(1) });
const decisionIdParamsSchema = z.object({ decisionId: z.string().min(1) });

// Fastify parses a repeated query param (?k=a&k=b) into a string[]; a single
// occurrence is a string. Both forms are accepted here.
type QueryValue = string | string[] | undefined;

/** Collapse a possibly-repeated scalar param to a single value (last wins). */
function scalarParam(value: QueryValue): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.at(-1) : value;
}

/** A finite integer parsed from a (possibly repeated) query param, or undefined. */
function parseIntParam(value: QueryValue): number | undefined {
  const scalar = scalarParam(value);
  if (scalar === undefined) return undefined;
  const n = Number.parseInt(scalar, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalize a multi-value filter param into trimmed, non-empty parts. Accepts
 * both comma-separated single values (?k=a,b) and repeated params (?k=a&k=b) —
 * and any mix — so a client can use whichever convention it likes.
 */
function parseCsvParam(value: QueryValue): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const parts = raw
    .flatMap((entry) => entry.split(","))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}

type DecisionsQuery = {
  sessionId?: QueryValue;
  matchedRuleId?: QueryValue;
  evidence?: QueryValue;
  outcomes?: QueryValue;
  enforced?: QueryValue;
  toolNames?: QueryValue;
  severities?: QueryValue;
  from?: QueryValue;
  to?: QueryValue;
  before?: QueryValue;
  limit?: QueryValue;
  offset?: QueryValue;
};

/**
 * Translate the raw decisions query string into a validated PolicyDecisionFilters.
 * Returns null on any invalid value (e.g. an outcome outside the enum) so the
 * route can answer 400 rather than silently dropping the filter.
 */
function parseDecisionFilters(query: DecisionsQuery): PolicyDecisionFilters | null {
  const enforcedRaw = scalarParam(query.enforced);
  const enforced =
    enforcedRaw === undefined ? undefined : enforcedRaw === "true" ? true : enforcedRaw === "false" ? false : null;
  if (enforced === null) return null;

  const parsed = PolicyDecisionFiltersSchema.safeParse({
    sessionId: scalarParam(query.sessionId),
    matchedRuleId: scalarParam(query.matchedRuleId),
    evidence: scalarParam(query.evidence),
    outcomes: parseCsvParam(query.outcomes),
    enforced,
    toolNames: parseCsvParam(query.toolNames),
    severities: parseCsvParam(query.severities),
    from: scalarParam(query.from),
    to: scalarParam(query.to),
    before: scalarParam(query.before),
    limit: parseIntParam(query.limit),
    offset: parseIntParam(query.offset)
  });
  return parsed.success ? parsed.data : null;
}

export async function registerAdminPolicyRoutes(
  app: FastifyInstance,
  stores: PolicyRouteStores
): Promise<void> {
  /**
   * The audit event of a rule change, written in the change's transaction.
   * A change that makes the policy weaker also queues the owner notice there.
   */
  const ruleAudit = <T>(request: FastifyRequest, type: AuditEventType, change: (saved: T) => PolicyRuleChange,
    payload: (saved: T) => Record<string, unknown>) =>
    (saved: T, weaker: boolean): AuditEventInput => ({
      tenantId: request.auth.tenantId,
      sessionId: null,
      userId: request.auth.userId,
      type,
      payload: { ...payload(saved), weaker },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      alsoInTransaction: weaker ? stores.dataRoutes.ownerNotice(request, change(saved)) : undefined
    });
  const ruleChange = (change: PolicyRuleChange["change"]) => (rule: PolicyRule): PolicyRuleChange =>
    ({ setting: "policy_rules", change, ruleId: rule.ruleId, ruleName: rule.name });

  // List rules (evaluation order).
  app.get("/admin/policy/rules", withAdmin(app, async (request) => {
    const rules = await stores.policyRules.list(request.auth.tenantId);
    return serialize(PolicyRulesListResponseSchema, { rules });
  }));

  app.post("/admin/policy/rules", withAdmin(app, async (request, reply) => {
    const parsed = parseRequestInput(reply, PolicyRuleInputSchema, request.body);
    if (!parsed.ok) return parsed.response;

    try {
      const audit = ruleAudit(request, "admin.policy_rule.created", ruleChange("rule_added"),
        (rule: PolicyRule) => ({ ruleId: rule.ruleId, effect: rule.effect, enabled: rule.enabled }));
      const written = await stores.dataRoutes.writeWithStepUpIfWeaker(request, reply, "POST /admin/policy/rules",
        (allowWeaker) => stores.policyRules.create(request.auth.tenantId, parsed.value, request.auth.userId, { allowWeaker, audit }));
      if (!written) return reply;
      const rule = written.saved;
      // Drop the hot-path rule cache so the new rule takes effect immediately.
      await stores.policyService.invalidate(request.auth.tenantId);
      return serialize(PolicyRuleEnvelopeSchema, { rule });
    } catch (error) {
      return respondAdminMutationError(reply, error, "Failed to create policy rule.");
    }
  }));

  // Update a rule (partial).
  app.patch("/admin/policy/rules/:ruleId", withAdmin(app, async (request, reply) => {
    const params = ruleIdParamsSchema.safeParse(request.params);
    if (!params.success) return respondAdminNotFound(reply, "policy_rule_not_found");

    const parsed = parseRequestInput(reply, PolicyRulePatchSchema, request.body);
    if (!parsed.ok) return parsed.response;

    try {
      const audit = ruleAudit(request, "admin.policy_rule.updated", ruleChange("rule_changed"),
        (rule: PolicyRule) => ({ ruleId: rule.ruleId, effect: rule.effect, enabled: rule.enabled }));
      // A missing rule answers 404 before any classification: it spends no step-up token.
      const written = await stores.dataRoutes.writeWithStepUpIfWeaker(request, reply, "PATCH /admin/policy/rules/:ruleId",
        (allowWeaker) => stores.policyRules.update(request.auth.tenantId, params.data.ruleId, parsed.value, { allowWeaker, audit }));
      if (!written) return reply;
      const rule = written.saved;
      if (!rule) return respondAdminNotFound(reply, "policy_rule_not_found");
      await stores.policyService.invalidate(request.auth.tenantId);
      return serialize(PolicyRuleEnvelopeSchema, { rule });
    } catch (error) {
      return respondAdminMutationError(reply, error, "Failed to update policy rule.");
    }
  }));

  app.delete("/admin/policy/rules/:ruleId", withAdmin(app, async (request, reply) => {
    const params = ruleIdParamsSchema.safeParse(request.params);
    if (!params.success) return respondAdminNotFound(reply, "policy_rule_not_found");

    const audit = ruleAudit(request, "admin.policy_rule.deleted", ruleChange("rule_removed"),
      (rule: PolicyRule) => ({ ruleId: rule.ruleId }));
    const written = await stores.dataRoutes.writeWithStepUpIfWeaker(request, reply, "DELETE /admin/policy/rules/:ruleId",
      (allowWeaker) => stores.policyRules.delete(request.auth.tenantId, params.data.ruleId, { allowWeaker, audit }));
    if (!written) return reply;
    if (!written.saved) return respondAdminNotFound(reply, "policy_rule_not_found");
    await stores.policyService.invalidate(request.auth.tenantId);
    reply.code(204);
    return null;
  }));

  // Simulate: evaluate a hypothetical action without recording or gating.
  app.post("/admin/policy/simulate", withAdmin(app, async (request, reply) => {
    const parsed = parseRequestInput(reply, PolicySimulateRequestSchema, request.body);
    if (!parsed.ok) return parsed.response;

    const evaluation = await stores.policyService.evaluate(request.auth.tenantId, {
      toolName: parsed.value.toolName,
      category: parsed.value.category ?? null,
      severity: parsed.value.severity ?? null,
      serverId: parsed.value.serverId ?? null,
      turnContext: parsed.value.turnContext ?? null
    });

    return serialize(PolicySimulateResponseSchema, {
      outcome: evaluation.outcome,
      matchedRuleId: evaluation.matchedRuleId,
      matchedRuleName: evaluation.matchedRuleName,
      // `gating` is the rule's intent (block/require_approval). The simulator is
      // mode-agnostic — it shows what the rule does, not whether the tenant is
      // currently enforcing.
      enforced: evaluation.gating,
      explanation: evaluation.explanation
    });
  }));

  // Decisions (evidence), filtered + paginated. Query params (all optional):
  //   sessionId, matchedRuleId, evidence (monitor_gateway), outcomes (csv),
  //   enforced (true|false), toolNames (csv), severities (csv),
  //   from/to (YYYY-MM-DD UTC, `to` inclusive of the day; `from` also takes an
  //   exact ISO timestamp), before (inclusive ISO upper bound), limit, offset.
  app.get("/admin/policy/decisions", withAdmin(app, async (request, reply) => {
    const filters = parseDecisionFilters(request.query as DecisionsQuery);
    if (!filters) {
      reply.code(400);
      return configError("Invalid decisions filter.");
    }
    const result = await stores.policyDecisions.list(request.auth.tenantId, filters);
    return serialize(PolicyDecisionsListResponseSchema, result);
  }));

  // Monitor evidence for the last seven days, grouped by rule. The window ends
  // at request time. The response echoes it so that links can list the same
  // rows with from=windowStart, before=windowEnd, evidence=monitor_gateway.
  app.get("/admin/policy/monitor-summary", withAdmin(app, async (request) => {
    const windowEnd = stores.now?.() ?? new Date();
    const summary = await stores.policyDecisions.summarizeMonitor(request.auth.tenantId, windowEnd);
    return serialize(PolicyMonitorSummaryResponseSchema, summary);
  }));

  // Single decision with its (re-redacted) action snapshot for the detail view.
  app.get("/admin/policy/decisions/:decisionId", withAdmin(app, async (request, reply) => {
    const params = decisionIdParamsSchema.safeParse(request.params);
    if (!params.success) return respondAdminNotFound(reply, "policy_decision_not_found");

    const decision = await stores.policyDecisions.get(request.auth.tenantId, params.data.decisionId);
    if (!decision) return respondAdminNotFound(reply, "policy_decision_not_found");
    return serialize(PolicyDecisionDetailResponseSchema, { decision });
  }));

  // Conflict/overlap lint: pure analysis of the active rule set for unreachable
  // rules, duplicates, and unknown condition keys. Reads through the same cached
  // rule set the gateway uses.
  app.get("/admin/policy/lint", withAdmin(app, async (request) => {
    // listForLint carries the RAW conditions_json (not the normalized form) so
    // the unknown_condition check can see typo'd/unknown dimension keys that
    // toConditions() would otherwise have dropped.
    const rules = await stores.policyRules.listForLint(request.auth.tenantId);
    const warnings = lintRules(rules);
    return serialize(PolicyLintResponseSchema, { warnings });
  }));

  // Reorder: rewrite priorities to match a desired evaluation order. The body
  // must list EXACTLY the tenant's current rule IDs (a drifted view is rejected
  // 409 so the UI refetches), then the engine cache is dropped so the new order
  // takes effect immediately.
  app.put("/admin/policy/rules/order", withAdmin(app, async (request, reply) => {
    const parsed = parseRequestInput(reply, PolicyReorderRequestSchema, request.body);
    if (!parsed.ok) return parsed.response;

    const audit = ruleAudit(request, "admin.policy_rule.reordered",
      (): PolicyRuleChange => ({ setting: "policy_rules", change: "order_changed", ruleId: null, ruleName: null }),
      () => ({ ruleIds: parsed.value.ruleIds }));
    let rules;
    try {
      // A drifted view answers 409 before any classification: it spends no step-up token.
      const written = await stores.dataRoutes.writeWithStepUpIfWeaker(request, reply, "PUT /admin/policy/rules/order",
        (allowWeaker) => stores.policyRules.reorder(request.auth.tenantId, parsed.value.ruleIds, { allowWeaker, audit }));
      if (!written) return reply;
      rules = written.saved;
    } catch (error) {
      if (error instanceof PolicyReorderMismatchError) {
        reply.code(409);
        return configError(error.message);
      }
      return respondAdminMutationError(reply, error, "Failed to reorder policy rules.");
    }

    await stores.policyService.invalidate(request.auth.tenantId);
    return serialize(PolicyRulesListResponseSchema, { rules });
  }));
}
