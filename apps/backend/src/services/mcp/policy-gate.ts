import type { FastifyBaseLogger } from "fastify";

import {
  POLICY_TURN_CONTEXTS,
  type PolicySeverity,
  type PolicyTurnContext
} from "@cogniplane/shared-types";

import type {
  PolicyApprovalDisposition,
  PolicyApprovalRouteInput,
  RuntimeApprovalKind
} from "../../runtime-contracts.js";
import { classifyToolSeverity } from "../tool-classification.js";
import type { PolicyService } from "../policy/policy-service.js";
import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";
import { parseRuntimePolicySnapshot, type ResolvedRuntimePolicy } from "../admin-config-records.js";

// Routes a Policy Center require_approval to whichever adapter owns the
// session. Returns the human disposition, or null when no adapter could host
// the approval (no active turn) — the gateway then degrades to a deny.
export type GatewayPolicyApprovalRouter = (
  input: PolicyApprovalRouteInput
) => Promise<PolicyApprovalDisposition | null>;

export function getRuntimePolicySnapshot(context: ToolExecutionContext): ResolvedRuntimePolicy {
  return parseRuntimePolicySnapshot(context.metadata.runtimePolicy, {
    toolContextId: context.toolContextId
  });
}

// Dependencies the Policy Center hook needs at the tool-call choke point.
export type PolicyGate = {
  policyService: PolicyService;
  requestPolicyApproval: GatewayPolicyApprovalRouter;
  /** Aborts when the gateway's HTTP response dies before the tool call returns. */
  clientDisconnectSignal?: AbortSignal;
  logger: Pick<FastifyBaseLogger, "warn">;
};

/**
 * Derive the policy severity for a tool action.
 *
 * Managed tools carry an authoritative `readOnly` boolean (from the catalog):
 * read-only → `read_only`, otherwise it's a state-changing call → `file_change`.
 * We deliberately do NOT name-classify managed tools — `classifyToolSeverity`
 * only knows Claude SDK native names (Read/Write/Bash/…), so a managed write
 * like `github_write_file` would mis-classify as `command_execution` and a
 * `file_change` rule would silently never match it.
 *
 * Forwarded/proxy tools have no catalog entry (`readOnly === null`), so their
 * severity is genuinely unknown — name-based classification is the only signal
 * available and is used as a best-effort fallback.
 */
export function deriveActionSeverity(
  toolName: string,
  readOnly: boolean | null
): PolicySeverity {
  if (readOnly === true) return "read_only";
  if (readOnly === false) return "file_change";
  return classifyToolSeverity(toolName);
}

// Map the policy severity onto the approval `kind` the SSE prompt + approvals
// row use. A read-only or state-changing tool surfaces as a "file_change"
// approval (it isn't a shell command); command_execution maps through directly.
function severityToApprovalKind(severity: PolicySeverity): RuntimeApprovalKind {
  return severity === "command_execution" ? "command_execution" : "file_change";
}

// Read a policy turn-context off the tool-execution context metadata, validating
// against the enum. Anything unexpected (missing, stale, malformed) degrades to
// null so the dimension acts as "no constraint" instead of throwing.
function parsePolicyTurnContext(value: unknown): PolicyTurnContext | null {
  return typeof value === "string" && (POLICY_TURN_CONTEXTS as readonly string[]).includes(value)
    ? (value as PolicyTurnContext)
    : null;
}

/**
 * Policy Center gate at the runtime choke point. Evaluates the proposed action
 * against the tenant's rules, records a decision as evidence (audit +
 * policy_decision), and either:
 *   - proceeds (returns) — for allow / monitor mode / no-match; or
 *   - routes a human approval for an enforce-mode `require_approval`, holding
 *     this gateway HTTP response open until the decision lands (approve →
 *     proceed, reject/expire → throw); or
 *   - throws {@link PolicyBlockedError} for an enforce-mode `block`.
 *
 * Whether a gating rule actually gates is the tenant's `policyEnforcementMode`,
 * read from the runtime-policy snapshot already on the tool-execution context.
 */
// The signal that varies per managed/forwarded path and isn't on the
// ToolExecutionContext: the tool's read/write flag (drives severity). Null for
// forwarded tools (no catalog entry → name-based severity classification).
export type PolicyToolFacts = {
  readOnly: boolean | null;
};

export async function enforcePolicyCenter(
  gate: PolicyGate,
  context: ToolExecutionContext,
  toolName: string,
  serverId: string,
  facts: PolicyToolFacts,
  args: Record<string, unknown>,
  // Policy Center `category` the rule engine matches on. For managed tools this
  // is the tool's bound domain (github/notion/session), NOT the URL serverId —
  // so a `categories` rule can't be dodged by calling the tool through another
  // enabled managed server's URL. Defaults to serverId for proxy/forwarded
  // tools, which have no domain binding.
  category: string = serverId
): Promise<void> {
  const severity = deriveActionSeverity(toolName, facts.readOnly);
  // Turn context is snapshotted into the tool-execution context at creation time
  // (see sse-stream-writer / scheduler), so the hot path reads it with no extra
  // DB lookup. A malformed snapshot degrades to null ("no constraint").
  const turnContext = parsePolicyTurnContext(context.metadata.turnContext);
  // The tenant-level monitor/enforce switch rides on the runtime-policy snapshot
  // already on the context — no extra DB call.
  const enforcementMode = getRuntimePolicySnapshot(context).policyEnforcementMode;
  await gate.policyService.gateAction({
    tenantId: context.tenantId,
    sessionId: context.sessionId,
    userId: context.userId,
    runtimeId: context.runtimeId,
    toolName,
    // For managed tools this is the tool's bound domain; for proxy tools it
    // defaults to the serverId. Recorded as the policy `category`.
    category,
    severity,
    serverId,
    turnContext,
    enforcementMode,
    // `toolContextId` is stamped into args by the gateway, not supplied by the
    // model — exclude it so the evidence snapshot reflects the caller's real
    // argument set.
    actionSnapshot: {
      argumentKeys: Object.keys(args).filter((key) => key !== "toolContextId")
    },
    approvalRouter: async (request) => {
      const disposition = await gate.requestPolicyApproval({
        tenantId: request.tenantId,
        sessionId: request.sessionId ?? "",
        userId: request.userId ?? "",
        runtimeId: request.runtimeId,
        toolName: request.toolName,
        serverId: request.serverId,
        kind: severityToApprovalKind(request.severity ?? severity),
        explanation: request.explanation,
        signal: gate.clientDisconnectSignal
      });
      if (disposition === null) {
        // No adapter could host the approval (no active turn) — deny.
        gate.logger.warn(
          { toolName, serverId, sessionId: context.sessionId },
          "policy require_approval: no runtime adapter to host approval — denying"
        );
        return "reject";
      }
      return disposition;
    }
  });
}
