import type {
  PolicyEnforcementMode,
  PolicySeverity,
  PolicyTurnContext
} from "@cogniplane/shared-types";

import { redactSecrets } from "../redact-secrets.js";

import {
  evaluatePolicy,
  type EvaluableRule,
  type PolicyActionContext,
  type PolicyEvaluation
} from "./policy-engine.js";
import type { PolicyDecisionStore } from "./policy-decision-store.js";
import type { PolicyRuleStore } from "./policy-rule-store.js";
import type { PolicyInvalidationBus } from "./policy-cache-invalidation.js";

type PolicyApprovalDisposition = "approve" | "reject" | "expired" | "consumed";

// Raised when an enforce-mode rule refuses the action: a `block`, or a
// `require_approval` without a matching approved graph-interrupt proof. The MCP gateway
// turns this into a JSON-RPC error so the model sees an explained refusal
// rather than a silent drop.
export class PolicyBlockedError extends Error {
  readonly explanation: string;
  readonly matchedRuleId: string | null;
  constructor(explanation: string, matchedRuleId: string | null) {
    super(explanation);
    this.name = "PolicyBlockedError";
    this.explanation = explanation;
    this.matchedRuleId = matchedRuleId;
  }
}

/** The refusal of an approved, enforced action whose evidence could not be saved. Fixed text: no database error reaches the model. */
export const POLICY_EVIDENCE_UNAVAILABLE =
  "The policy decision for this action could not be recorded, so the action was denied. Try again.";

export type PolicyEvaluationInput = {
  tenantId: string;
  sessionId: string | null;
  userId: string | null;
  runtimeId: string | null;
  toolName: string;
  category: string | null;
  severity: PolicySeverity | null;
  serverId: string | null;
  // interactive vs scheduled, snapshotted into the tool-execution context.
  turnContext: PolicyTurnContext | null;
  // Redacted snapshot of the action (e.g. argument keys) for replay evidence.
  actionSnapshot?: Record<string, unknown>;
};

// What the gateway passes when it wants the action gated. Policy Center
// approvals are collected by the graph before this call; the gateway receives
// only the verified disposition.
export type PolicyGateInput = PolicyEvaluationInput & {
  // The tenant-level Policy Center switch. In `monitor` the gate records a
  // would-have decision and never gates; in `enforce` a matching block /
  // require_approval rule actually gates the action.
  enforcementMode: PolicyEnforcementMode;
  approvalDisposition?: PolicyApprovalDisposition;
};

export type PolicyGateResult = {
  evaluation: PolicyEvaluation;
  // True when the matched gating effect is actually being enforced (tenant in
  // enforce mode). False for monitor mode / allow / no-match.
  enforced: boolean;
};

export class PolicyService {
  // Short-TTL per-tenant cache of the compiled rule set. gateAction runs on the
  // tool-call hot path, so without a cache every action would query `policy_rule`.
  // The TTL bounds staleness. invalidate() clears an entry on this replica. The
  // invalidation bus, when set, clears it on the other replicas.
  private readonly ruleCache = new Map<string, { rules: EvaluableRule[]; expiresAt: number }>();

  private readonly rules: PolicyRuleStore;
  private readonly decisions: Pick<PolicyDecisionStore, "record">;
  // Evidence failures are logged. They never let a gated action run: see
  // recordEvidence.
  private readonly logger: { warn: (msg: string, meta?: unknown) => void };
  private readonly ruleCacheTtlMs: number;
  private readonly invalidationBus?: PolicyInvalidationBus;
  private invalidationUnsubscribe: (() => Promise<void>) | null = null;

  constructor(options: {
    rules: PolicyRuleStore;
    decisions: Pick<PolicyDecisionStore, "record">;
    logger?: { warn: (msg: string, meta?: unknown) => void };
    ruleCacheTtlMs?: number;
    invalidationBus?: PolicyInvalidationBus;
  }) {
    this.rules = options.rules;
    this.decisions = options.decisions;
    this.logger = options.logger ?? { warn: (msg, meta) => console.warn(msg, meta) };
    this.ruleCacheTtlMs = options.ruleCacheTtlMs ?? 5_000;
    this.invalidationBus = options.invalidationBus;
  }

  /**
   * Subscribe to cross-replica cache invalidations. Call once at boot, before
   * serving traffic. A subscription failure is logged, not thrown — pub/sub is
   * a consistency optimization and the short rule-cache TTL remains the
   * fallback (see {@link invalidate}).
   */
  async start(): Promise<void> {
    if (!this.invalidationBus || this.invalidationUnsubscribe) return;
    try {
      this.invalidationUnsubscribe = await this.invalidationBus.subscribe((tenantId) =>
        this.ruleCache.delete(tenantId)
      );
    } catch (error) {
      this.logger.warn("policy: failed to subscribe to cache invalidations", { error });
    }
  }

  private async loadRules(tenantId: string): Promise<EvaluableRule[]> {
    const cached = this.ruleCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.rules;
    }
    const rules = (await this.rules.list(tenantId)).map(toEvaluable);
    this.ruleCache.set(tenantId, { rules, expiresAt: Date.now() + this.ruleCacheTtlMs });
    return rules;
  }

  /**
   * Drop the cached rule set for a tenant so the next evaluation reloads from
   * the store. Call after a rule mutation to make the change take effect
   * immediately instead of waiting out the TTL.
   */
  async invalidate(tenantId: string): Promise<void> {
    this.ruleCache.delete(tenantId);
    if (!this.invalidationBus) return;
    try {
      await this.invalidationBus.publish(tenantId);
    } catch (error) {
      // The short local TTL remains the fallback if Redis is unavailable or a
      // replica misses a pub/sub message while reconnecting.
      this.logger.warn("policy: failed to broadcast cache invalidation", { error, tenantId });
    }
  }

  async close(): Promise<void> {
    await this.invalidationUnsubscribe?.();
    this.invalidationUnsubscribe = null;
  }

  /** Pure evaluation against the tenant's active rules (used by the simulator). */
  async evaluate(tenantId: string, action: PolicyActionContext): Promise<PolicyEvaluation> {
    return evaluatePolicy(await this.loadRules(tenantId), action);
  }

  /**
   * Gate an action at the MCP gateway choke point: evaluate it, verify any
   * graph-resolved `require_approval`, persist replay evidence, emit an audit
   * event, and either return (proceed) or throw {@link PolicyBlockedError}.
   *
   * Outcomes:
   *   no match / monitor / allow → proceed
   *   block (enforce)            → throw PolicyBlockedError
   *   require_approval (enforce) → proceed only with a verified approval proof
   */
  async gateAction(input: PolicyGateInput): Promise<PolicyGateResult> {
    const action: PolicyActionContext = {
      toolName: input.toolName,
      category: input.category,
      severity: input.severity,
      serverId: input.serverId,
      turnContext: input.turnContext
    };

    const evaluation = evaluatePolicy(await this.loadRules(input.tenantId), action);
    const enforced = input.enforcementMode === "enforce" && evaluation.gating;

    // Non-enforcing outcomes (no match, monitor mode, allow) proceed untouched.
    // Record evidence when a rule matched; never for a default-allow no-match
    // (that would write a row per tool call and drown the table). An outcome
    // that does not gate proceeds when its evidence cannot be written: the
    // failure is logged, so an unwritable table can't turn a monitor rule into
    // an outage.
    if (!enforced) {
      if (evaluation.matchedRuleId !== null) {
        await this.recordEvidence(input, evaluation, enforced, null);
      }
      return { evaluation, enforced };
    }

    if (evaluation.outcome === "block") {
      await this.recordEvidence(input, evaluation, enforced, null);
      throw new PolicyBlockedError(
        evaluation.explanation ?? "Action blocked by policy.",
        evaluation.matchedRuleId
      );
    }

    // Enforce-mode require_approval → accept only the gateway-verified proof.
    if (evaluation.outcome === "require_approval") {
      // Scheduled turns are unattended. Creating an approval would pause the
      // graph until the scheduler timeout, so reject the action immediately.
      if (input.turnContext === "scheduled") {
        this.logger.warn("policy: require_approval matched on a scheduled turn; denying", {
          tenantId: input.tenantId,
          toolName: input.toolName,
          matchedRuleId: evaluation.matchedRuleId
        });
        await this.recordEvidence(input, evaluation, enforced, "reject");
        throw new PolicyBlockedError(
          `${evaluation.explanation ?? "Action requires approval."} Approval is not available on scheduled runs, so the action was denied.`.trim(),
          evaluation.matchedRuleId
        );
      }
      const disposition = input.approvalDisposition ?? "reject";
      const recorded = await this.recordEvidence(input, evaluation, enforced, disposition);
      if (disposition === "approve") {
        // Fail closed: an approved action that the rule gates runs only with
        // its evidence committed.
        if (!recorded) {
          throw new PolicyBlockedError(POLICY_EVIDENCE_UNAVAILABLE, evaluation.matchedRuleId);
        }
        return { evaluation, enforced };
      }
      const why =
        disposition === "expired"
          ? "Approval request expired before a decision was made."
          : disposition === "consumed"
            ? "This approval was already used for an earlier call."
          : input.approvalDisposition === "reject"
            ? "Action denied by approver."
            : "No matching approved graph action was provided.";
      throw new PolicyBlockedError(
        `${evaluation.explanation ?? "Action requires approval."} ${why}`.trim(),
        evaluation.matchedRuleId
      );
    }

    // Defensive: an enforced outcome we don't have a branch for. Proceed.
    return { evaluation, enforced };
  }

  /** Recheck access to a resource from a completed tool call and record matched rules. */
  async gateCompletedToolResource(input: PolicyGateInput): Promise<PolicyGateResult> {
    const evaluation = evaluatePolicy(await this.loadRules(input.tenantId), {
      toolName: input.toolName,
      category: input.category,
      severity: input.severity,
      serverId: input.serverId,
      turnContext: input.turnContext
    });
    const enforced = input.enforcementMode === "enforce" && evaluation.outcome === "block";
    if (evaluation.matchedRuleId !== null) {
      await this.recordEvidence(input, evaluation, enforced, null);
    }
    if (enforced) {
      throw new PolicyBlockedError(evaluation.explanation ?? "Action blocked by policy.", evaluation.matchedRuleId);
    }
    return { evaluation, enforced };
  }

  /**
   * Saves the decision row and its audit event in one transaction
   * (`PolicyDecisionStore.record`). Returns false when they could not be
   * saved; the failure is logged, never thrown. The caller decides:
   *
   * - an outcome that does not gate (allow, monitor mode) proceeds;
   * - an enforced block or denial is refused anyway;
   * - an enforced `require_approval` with an approval is refused
   *   (`POLICY_EVIDENCE_UNAVAILABLE`), so no gated action runs without evidence.
   */
  private async recordEvidence(
    input: PolicyEvaluationInput,
    evaluation: PolicyEvaluation,
    enforced: boolean,
    // For require_approval: the resolved human decision. Null otherwise.
    disposition: PolicyApprovalDisposition | null
  ): Promise<boolean> {
    try {
      const snapshot: Record<string, unknown> = redactSecrets({
        toolName: input.toolName,
        category: input.category,
        ...(input.turnContext ? { turnContext: input.turnContext } : {}),
        severity: input.severity,
        serverId: input.serverId,
        ...(disposition ? { approvalDisposition: disposition } : {}),
        ...(input.actionSnapshot ?? {})
      });

      await this.decisions.record(input.tenantId, {
        sessionId: input.sessionId,
        userId: input.userId,
        runtimeId: input.runtimeId,
        toolName: input.toolName,
        toolCategory: input.category,
        severity: input.severity,
        serverId: input.serverId,
        matchedRuleId: evaluation.matchedRuleId,
        outcome: evaluation.outcome,
        enforced,
        explanation: evaluation.explanation,
        actionSnapshot: snapshot
      }, (decision) => ({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        type: enforced ? "policy.decision.enforced" : "policy.decision.recorded",
        payload: {
          decisionId: decision.decisionId,
          toolName: input.toolName,
          serverId: input.serverId,
          matchedRuleId: evaluation.matchedRuleId,
          outcome: evaluation.outcome,
          enforced,
          ...(disposition ? { approvalDisposition: disposition } : {})
        }
      }));
      return true;
    } catch (error) {
      this.logger.warn("policy: failed to persist decision evidence", {
        tenantId: input.tenantId,
        toolName: input.toolName,
        matchedRuleId: evaluation.matchedRuleId,
        enforced,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }
}

function toEvaluable(rule: {
  ruleId: string;
  name: string;
  priority: number;
  enabled: boolean;
  effect: EvaluableRule["effect"];
  conditions: EvaluableRule["conditions"];
  reason: string | null;
}): EvaluableRule {
  return {
    ruleId: rule.ruleId,
    name: rule.name,
    priority: rule.priority,
    enabled: rule.enabled,
    effect: rule.effect,
    conditions: rule.conditions,
    reason: rule.reason
  };
}
