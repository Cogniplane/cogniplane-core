import type {
  PolicyEnforcementMode,
  PolicySeverity,
  PolicyTurnContext
} from "@cogniplane/shared-types";

import type { PolicyApprovalDisposition } from "../../runtime-contracts.js";
import type { AuditEventStore } from "../audit-event-store.js";
import { redactSecrets } from "../redact-secrets.js";

import {
  evaluatePolicy,
  type EvaluableRule,
  type PolicyActionContext,
  type PolicyEvaluation
} from "./policy-engine.js";
import type { PolicyDecisionStore } from "./policy-decision-store.js";
import type { PolicyRuleStore } from "./policy-rule-store.js";

// Raised when an enforce-mode rule refuses the action: a `block`, or a
// `require_approval` whose human decision was reject/expire. The MCP gateway
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

// What the gateway passes when it wants the action GATED (not just evaluated):
// the tenant's enforcement mode plus an approval router the service calls to
// pause-and-resume an enforce-mode `require_approval`.
export type PolicyGateInput = PolicyEvaluationInput & {
  // The tenant-level Policy Center switch. In `monitor` the gate records a
  // would-have decision and never gates; in `enforce` a matching block /
  // require_approval rule actually gates the action.
  enforcementMode: PolicyEnforcementMode;
  // Routes a human approval and resolves when the decision (or TTL) lands.
  // Omitted by callers that can't host approvals (e.g. a context with no active
  // turn) — in that case an enforce-mode `require_approval` degrades to a block.
  approvalRouter?: PolicyApprovalRouter;
};

// Supplied by the gateway, backed by the owning runtime adapter. Emits the
// `framework:approval_required` SSE event to the active turn, persists the
// approval row (reusing ApprovalStore + TTL/sweep), and resolves when
// `POST /approvals/:id/decision` settles it or the TTL expires.
export type PolicyApprovalRouter = (request: {
  tenantId: string;
  sessionId: string | null;
  userId: string | null;
  runtimeId: string | null;
  toolName: string;
  serverId: string | null;
  severity: PolicySeverity | null;
  matchedRuleId: string | null;
  explanation: string;
}) => Promise<PolicyApprovalDisposition>;

// Single source: runtime-contracts. Re-exported so existing importers of this
// module's PolicyApprovalDisposition keep working.
export type { PolicyApprovalDisposition };

// The result of gating an action that may proceed.
export type PolicyGateResult = {
  evaluation: PolicyEvaluation;
  // True when the matched gating effect is actually being enforced (tenant in
  // enforce mode). False for monitor mode / allow / no-match.
  enforced: boolean;
};

export class PolicyService {
  // Short-TTL per-tenant cache of the compiled rule set. gateAction runs on
  // the tool-call hot path (once per action); without this every action issues
  // a fresh `SELECT * FROM policy_rule`. The TTL bounds staleness so admin edits
  // take effect within a few seconds without any cross-layer invalidation
  // wiring — acceptable for a config surface.
  private readonly ruleCache = new Map<string, { rules: EvaluableRule[]; expiresAt: number }>();

  private readonly rules: PolicyRuleStore;
  private readonly decisions: PolicyDecisionStore;
  private readonly auditEvents: AuditEventStore;
  // Persisting a decision is best-effort evidence — a write failure must not
  // change whether the action is gated. Failures are logged, never thrown.
  private readonly logger: { warn: (msg: string, meta?: unknown) => void };
  private readonly ruleCacheTtlMs: number;

  constructor(options: {
    rules: PolicyRuleStore;
    decisions: PolicyDecisionStore;
    auditEvents: AuditEventStore;
    logger?: { warn: (msg: string, meta?: unknown) => void };
    ruleCacheTtlMs?: number;
  }) {
    this.rules = options.rules;
    this.decisions = options.decisions;
    this.auditEvents = options.auditEvents;
    this.logger = options.logger ?? { warn: (msg, meta) => console.warn(msg, meta) };
    this.ruleCacheTtlMs = options.ruleCacheTtlMs ?? 5_000;
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
  invalidate(tenantId: string): void {
    this.ruleCache.delete(tenantId);
  }

  /** Pure evaluation against the tenant's active rules (used by the simulator). */
  async evaluate(tenantId: string, action: PolicyActionContext): Promise<PolicyEvaluation> {
    return evaluatePolicy(await this.loadRules(tenantId), action);
  }

  /**
   * Gate an action at the MCP gateway choke point: evaluate it, route any
   * `require_approval` (in enforce mode), persist replay evidence, emit an audit
   * event, and either return (proceed) or throw {@link PolicyBlockedError}.
   *
   * Outcomes:
   *   no match / monitor / allow → proceed
   *   block (enforce)            → throw PolicyBlockedError
   *   require_approval (enforce) → route a human approval, then proceed
   *                                (approve) or throw (reject / expired). If no
   *                                approvalRouter is available the action
   *                                degrades to a block.
   *
   * The gateway holds its HTTP response open while this awaits the approval —
   * both Codex and Claude call managed tools over HTTP, so an `await` here is a
   * legitimate pause without touching the runtime's native approval coordinator
   * (which gates shell/file actions on an entirely separate path).
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
    // (that would write a row per tool call and drown the table). Evidence is
    // best-effort — a write failure is logged, never thrown, so an unwritable
    // table can't turn a monitor rule into an outage.
    if (!enforced) {
      if (evaluation.matchedRuleId !== null) {
        await this.recordEvidence(input, evaluation, enforced, null);
      }
      return { evaluation, enforced };
    }

    // Enforce-mode block → refuse immediately.
    if (evaluation.outcome === "block") {
      await this.recordEvidence(input, evaluation, enforced, null);
      throw new PolicyBlockedError(
        evaluation.explanation ?? "Action blocked by policy.",
        evaluation.matchedRuleId
      );
    }

    // Enforce-mode require_approval → route a human approval and resume/deny.
    if (evaluation.outcome === "require_approval") {
      const disposition = await this.routeApproval(input, evaluation);
      await this.recordEvidence(input, evaluation, enforced, disposition);
      if (disposition === "approve") {
        return { evaluation, enforced };
      }
      const why =
        disposition === "expired"
          ? "Approval request expired before a decision was made."
          : "Action denied by approver.";
      throw new PolicyBlockedError(
        `${evaluation.explanation ?? "Action requires approval."} ${why}`.trim(),
        evaluation.matchedRuleId
      );
    }

    // Defensive: an enforced outcome we don't have a branch for. Proceed.
    return { evaluation, enforced };
  }

  /**
   * Drive the injected approval router. When the gateway can't host approvals
   * (no router available — e.g. a context with no active turn), an enforce-mode
   * require_approval degrades to a deny rather than letting the action through.
   */
  private async routeApproval(
    input: PolicyGateInput,
    evaluation: PolicyEvaluation
  ): Promise<PolicyApprovalDisposition> {
    if (!input.approvalRouter) {
      this.logger.warn("policy: require_approval matched but no approval router available — denying", {
        tenantId: input.tenantId,
        toolName: input.toolName,
        matchedRuleId: evaluation.matchedRuleId
      });
      return "reject";
    }
    return input.approvalRouter({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      userId: input.userId,
      runtimeId: input.runtimeId,
      toolName: input.toolName,
      serverId: input.serverId,
      severity: input.severity,
      matchedRuleId: evaluation.matchedRuleId,
      explanation: evaluation.explanation ?? "Action requires approval."
    });
  }

  private async recordEvidence(
    input: PolicyEvaluationInput,
    evaluation: PolicyEvaluation,
    enforced: boolean,
    // For require_approval: the resolved human decision. Null otherwise.
    disposition: PolicyApprovalDisposition | null
  ): Promise<void> {
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

      const decision = await this.decisions.record(input.tenantId, {
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
      });

      await this.auditEvents.create({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        userId: input.userId ?? "system",
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
      });
    } catch (error) {
      this.logger.warn("policy: failed to persist decision evidence (action not affected)", {
        tenantId: input.tenantId,
        toolName: input.toolName,
        matchedRuleId: evaluation.matchedRuleId,
        error: error instanceof Error ? error.message : String(error)
      });
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
