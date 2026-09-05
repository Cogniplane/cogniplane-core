import type { FastifyBaseLogger } from "fastify";

import {
  POLICY_TURN_CONTEXTS,
  type PolicySeverity,
  type PolicyTurnContext
} from "@cogniplane/shared-types";

import type { ApprovalRecord, ApprovalStore } from "../auth/approval-store.js";
import type { PolicyService } from "../policy/policy-service.js";
import {
  POLICY_APPROVAL_REQUEST_METHOD,
  policyArgsHash,
  type PolicyApprovalProof
} from "../policy/policy-approval-proof.js";
import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";
import { parseRuntimePolicySnapshot, type ResolvedRuntimePolicy } from "../admin-config-records.js";

export function getRuntimePolicySnapshot(context: ToolExecutionContext): ResolvedRuntimePolicy {
  return parseRuntimePolicySnapshot(context.metadata.runtimePolicy, {
    toolContextId: context.toolContextId
  });
}

// Dependencies the Policy Center hook needs at the tool-call choke point.
export type PolicyGate = {
  policyService: Pick<PolicyService, "gateAction" | "evaluate">;
  approvals: Pick<ApprovalStore, "get">;
  logger: Pick<FastifyBaseLogger, "warn">;
};

/**
 * Derive the policy severity for a tool action.
 *
 * The only signal is one boolean: `ManagedToolDefinition.readOnly` for managed
 * tools, the upstream `annotations.readOnlyHint` learned from `tools/list` for
 * proxy tools. Literal `true` gives `read_only`; false, missing, and unknown
 * all give the conservative `file_change`.
 *
 * This deliberately never returns `command_execution`. The shell built-in that
 * severity describes runs inside the graph and is gated by the runtime's own
 * native HITL interrupt, not by the MCP gateway, so no gateway action can
 * carry it. `PolicySeverity` keeps the value for stored rules and decision
 * rows — see the comment on POLICY_SEVERITIES in shared-types.
 */
export function deriveActionSeverity(
  _toolName: string,
  readOnly?: boolean | null
): PolicySeverity {
  return readOnly === true ? "read_only" : "file_change";
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
 *   - verifies the checkpointed approval proof for an enforce-mode
 *     `require_approval` (approved → proceed, missing/mismatched → throw); or
 *   - throws {@link PolicyBlockedError} for an enforce-mode `block`.
 *
 * Whether a gating rule actually gates is the tenant's `policyEnforcementMode`,
 * read from the runtime-policy snapshot already on the tool-execution context.
 */
// The signal that varies per managed/forwarded path and isn't on the
// ToolExecutionContext: the tool's read/write flag (drives severity).
// For managed tools, read from the catalog. For forwarded/proxy tools,
// read from the proxy-tool-metadata cache (or null if unannotated/uncached,
// which defaults to "file_change").
export type PolicyToolFacts = {
  readOnly: boolean | null;
};

function storedPolicyProof(record: ApprovalRecord): PolicyApprovalProof | null {
  const value = record.requestPayload.policyApproval;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as PolicyApprovalProof)
    : null;
}

export function approvalDispositionForToolCall(input: {
  approval: ApprovalRecord | null;
  context: ToolExecutionContext;
  toolName: string;
  serverId: string;
  args: Record<string, unknown>;
}): "approve" | "reject" | "expired" | undefined {
  const { approval, context, toolName, serverId, args } = input;
  if (!approval) return undefined;
  if (
    approval.requestMethod !== POLICY_APPROVAL_REQUEST_METHOD ||
    approval.sessionId !== context.sessionId ||
    approval.userId !== context.userId
  ) {
    return undefined;
  }
  const proof = storedPolicyProof(approval);
  if (
    !proof ||
    proof.approvalId !== approval.approvalId ||
    proof.toolContextId !== context.toolContextId ||
    proof.toolName !== toolName ||
    proof.serverId !== serverId ||
    proof.argsHash !== policyArgsHash(args)
  ) {
    return undefined;
  }
  if (approval.status === "approved" && approval.decision === "approve") return "approve";
  if (approval.status === "rejected" && approval.decision === "reject") return "reject";
  if (approval.status === "expired") return "expired";
  return undefined;
}

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
  // (see sse-stream-writer-agui / scheduler), so the hot path reads it with no extra
  // DB lookup. A malformed snapshot degrades to null ("no constraint").
  const turnContext = parsePolicyTurnContext(context.metadata.turnContext);
  // The tenant-level monitor/enforce switch rides on the runtime-policy snapshot
  // already on the context — no extra DB call.
  const enforcementMode = getRuntimePolicySnapshot(context).policyEnforcementMode;
  const approvalId = typeof args.policyApprovalId === "string" ? args.policyApprovalId : null;
  const approval = approvalId
    ? await gate.approvals.get(context.tenantId, approvalId, context.userId)
    : null;
  const approvalDisposition = approvalDispositionForToolCall({
    approval,
    context,
    toolName,
    serverId,
    args
  });
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
      argumentKeys: Object.keys(args).filter(
        (key) => key !== "toolContextId" && key !== "policyApprovalId"
      )
    },
    approvalDisposition
  });
}
