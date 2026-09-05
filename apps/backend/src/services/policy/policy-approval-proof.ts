import { createHash } from "node:crypto";

export const POLICY_APPROVAL_REQUEST_METHOD = "policy/toolApproval";
export const POLICY_APPROVAL_MARKER_KEY = "__cogniplanePolicyApproval";

export type PolicyApprovalProof = {
  approvalId: string;
  toolContextId: string;
  toolCallId: string;
  toolName: string;
  serverId: string;
  argsHash: string;
  ruleId: string | null;
  explanation: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          key !== "toolContextId" &&
          key !== "policyApprovalId" &&
          key !== POLICY_APPROVAL_MARKER_KEY
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

export function policyArgsHash(args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(args))).digest("hex");
}

export function createPolicyApprovalProof(input: {
  tenantId: string;
  sessionId: string;
  toolContextId: string;
  toolCallId: string;
  toolName: string;
  serverId: string;
  args: Record<string, unknown>;
  ruleId: string | null;
  explanation: string;
}): PolicyApprovalProof {
  const argsHash = policyArgsHash(input.args);
  const digest = createHash("sha256")
    .update(
      [
        input.tenantId,
        input.sessionId,
        input.toolContextId,
        input.toolCallId,
        input.toolName,
        input.serverId,
        argsHash
      ].join("\0")
    )
    .digest("hex");
  return {
    approvalId: `polapr_${digest.slice(0, 32)}`,
    toolContextId: input.toolContextId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    serverId: input.serverId,
    argsHash,
    ruleId: input.ruleId,
    explanation: input.explanation
  };
}

export function readPolicyApprovalMarker(args: Record<string, unknown>): PolicyApprovalProof | null {
  const value = args[POLICY_APPROVAL_MARKER_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proof = value as Partial<PolicyApprovalProof>;
  if (
    typeof proof.approvalId !== "string" ||
    typeof proof.toolContextId !== "string" ||
    typeof proof.toolCallId !== "string" ||
    typeof proof.toolName !== "string" ||
    typeof proof.serverId !== "string" ||
    typeof proof.argsHash !== "string" ||
    (proof.ruleId !== null && typeof proof.ruleId !== "string") ||
    typeof proof.explanation !== "string"
  ) {
    return null;
  }
  return proof as PolicyApprovalProof;
}

export function withoutPolicyApprovalMetadata(
  args: Record<string, unknown>
): Record<string, unknown> {
  const cleaned = { ...args };
  delete cleaned[POLICY_APPROVAL_MARKER_KEY];
  delete cleaned.policyApprovalId;
  return cleaned;
}
