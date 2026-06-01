import type { FastifyInstance } from "fastify";

import {
  PolicyDecisionDetailResponseSchema,
  PolicyDecisionFiltersSchema,
  PolicyDecisionsListResponseSchema,
  PolicyLintResponseSchema,
  PolicyReorderRequestSchema,
  PolicyRuleEnvelopeSchema,
  PolicyRuleInputSchema,
  PolicyRulePatchSchema,
  PolicyRulesListResponseSchema,
  PolicySimulateRequestSchema,
  PolicySimulateResponseSchema,
  z
} from "@cogniplane/shared-types";
import type { PolicyDecisionFilters } from "@cogniplane/shared-types";

import { serialize } from "../../lib/serialize-response.js";
import type { AuditEventStore } from "../../services/audit-event-store.js";
import type { PolicyDecisionStore } from "../../services/policy/policy-decision-store.js";
import { lintRules } from "../../services/policy/policy-lint.js";
import {
  PolicyReorderMismatchError,
  type PolicyRuleStore
} from "../../services/policy/policy-rule-store.js";
import type { PolicyService } from "../../services/policy/policy-service.js";

import {
  configError,
  createAdminAuditEvent,
  parseAdminBody,
  respondAdminMutationError,
  respondAdminNotFound,
  withAdmin
} from "./admin-route-helpers.js";

export type PolicyRouteStores = {
  policyRules: PolicyRuleStore;
  policyDecisions: PolicyDecisionStore;
  policyService: PolicyService;
  auditEvents: AuditEventStore;
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
  // List rules (evaluation order).
  app.get("/admin/policy/rules", withAdmin(app, async (request) => {
    const rules = await stores.policyRules.list(request.auth.tenantId);
    return serialize(PolicyRulesListResponseSchema, { rules });
  }));

  // Create a rule.
  app.post("/admin/policy/rules", withAdmin(app, async (request, reply) => {
    const parsed = parseAdminBody(reply, PolicyRuleInputSchema, request.body);
    if (!parsed.ok) return parsed.response;

    try {
      const rule = await stores.policyRules.create(
        request.auth.tenantId,
        parsed.value,
        request.auth.userId
      );
      // Drop the hot-path rule cache so the new rule takes effect immediately.
      stores.policyService.invalidate(request.auth.tenantId);
      await createAdminAuditEvent(stores.auditEvents, {
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        type: "admin.policy_rule.created",
        payload: { ruleId: rule.ruleId, effect: rule.effect, enabled: rule.enabled },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
      return serialize(PolicyRuleEnvelopeSchema, { rule });
    } catch (error) {
      return respondAdminMutationError(reply, error, "Failed to create policy rule.");
    }
  }));

  // Update a rule (partial).
  app.patch("/admin/policy/rules/:ruleId", withAdmin(app, async (request, reply) => {
    const params = ruleIdParamsSchema.safeParse(request.params);
    if (!params.success) return respondAdminNotFound(reply, "policy_rule_not_found");

    const parsed = parseAdminBody(reply, PolicyRulePatchSchema, request.body);
    if (!parsed.ok) return parsed.response;

    try {
      const rule = await stores.policyRules.update(
        request.auth.tenantId,
        params.data.ruleId,
        parsed.value
      );
      if (!rule) return respondAdminNotFound(reply, "policy_rule_not_found");
      stores.policyService.invalidate(request.auth.tenantId);
      await createAdminAuditEvent(stores.auditEvents, {
        tenantId: request.auth.tenantId,
        userId: request.auth.userId,
        type: "admin.policy_rule.updated",
        payload: { ruleId: rule.ruleId, effect: rule.effect, enabled: rule.enabled },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]
      });
      return serialize(PolicyRuleEnvelopeSchema, { rule });
    } catch (error) {
      return respondAdminMutationError(reply, error, "Failed to update policy rule.");
    }
  }));

  // Delete a rule.
  app.delete("/admin/policy/rules/:ruleId", withAdmin(app, async (request, reply) => {
    const params = ruleIdParamsSchema.safeParse(request.params);
    if (!params.success) return respondAdminNotFound(reply, "policy_rule_not_found");

    const deleted = await stores.policyRules.delete(request.auth.tenantId, params.data.ruleId);
    if (!deleted) return respondAdminNotFound(reply, "policy_rule_not_found");
    stores.policyService.invalidate(request.auth.tenantId);
    await createAdminAuditEvent(stores.auditEvents, {
      tenantId: request.auth.tenantId,
      userId: request.auth.userId,
      type: "admin.policy_rule.deleted",
      payload: { ruleId: params.data.ruleId },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    reply.code(204);
    return null;
  }));

  // Simulate: evaluate a hypothetical action without recording or gating.
  app.post("/admin/policy/simulate", withAdmin(app, async (request, reply) => {
    const parsed = parseAdminBody(reply, PolicySimulateRequestSchema, request.body);
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
  //   sessionId, outcomes (csv), enforced (true|false), toolNames (csv),
  //   severities (csv), from/to (YYYY-MM-DD UTC, `to` inclusive of the day),
  //   before (ISO upper bound to keep paging stable), limit, offset.
  app.get("/admin/policy/decisions", withAdmin(app, async (request, reply) => {
    const filters = parseDecisionFilters(request.query as DecisionsQuery);
    if (!filters) {
      reply.code(400);
      return configError("Invalid decisions filter.");
    }
    const result = await stores.policyDecisions.list(request.auth.tenantId, filters);
    return serialize(PolicyDecisionsListResponseSchema, result);
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
    const parsed = parseAdminBody(reply, PolicyReorderRequestSchema, request.body);
    if (!parsed.ok) return parsed.response;

    let rules;
    try {
      rules = await stores.policyRules.reorder(request.auth.tenantId, parsed.value.ruleIds);
    } catch (error) {
      if (error instanceof PolicyReorderMismatchError) {
        reply.code(409);
        return configError(error.message);
      }
      return respondAdminMutationError(reply, error, "Failed to reorder policy rules.");
    }

    stores.policyService.invalidate(request.auth.tenantId);
    await createAdminAuditEvent(stores.auditEvents, {
      tenantId: request.auth.tenantId,
      userId: request.auth.userId,
      type: "admin.policy_rule.reordered",
      payload: { ruleIds: parsed.value.ruleIds },
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
    return serialize(PolicyRulesListResponseSchema, { rules });
  }));
}
