import { createHash, randomUUID } from "node:crypto";

export const POLICY_APPROVAL_REQUEST_METHOD = "policy/toolApproval";
export const POLICY_APPROVAL_MARKER_KEY = "__cogniplanePolicyApproval";
// Approval metadata in tool arguments. Nothing reads either key as a proof.
// The runtime sends its proof in the request `_meta`. The runtime and the
// gateway strip both keys as a guard against model-supplied or old
// checkpointed values.
const POLICY_APPROVAL_METADATA_KEYS = [POLICY_APPROVAL_MARKER_KEY, "policyApprovalId"];
// Transport keys, at the ROOT of a call's arguments only. A model writes a
// `toolContextId`, because the managed schemas require one, and it can write
// the approval keys. The gateway stamps `toolContextId` for the handler. So the
// hash leaves them out at the root and nowhere else. A nested key with one of
// these names is data that the user approved, and the hash includes it.
const TRANSPORT_KEYS: readonly string[] = ["toolContextId", ...POLICY_APPROVAL_METADATA_KEYS];

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

// Sorts keys at every level, so the order that a caller wrote them in does not matter.
// It keeps every key. Transport keys are removed once, at the root, by policyArgsHash.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

export function policyArgsHash(args: Record<string, unknown>): string {
  const caller = Object.fromEntries(Object.entries(args).filter(([key]) => !TRANSPORT_KEYS.includes(key)));
  return createHash("sha256").update(JSON.stringify(canonicalize(caller))).digest("hex");
}

// Callers retain their own identity and approval-status checks.
export function matchesPolicyApprovalAction(
  proof: Pick<PolicyApprovalProof, "toolName" | "serverId" | "argsHash">,
  action: { toolName: string; serverId: string; args: Record<string, unknown> }
): boolean {
  return proof.toolName === action.toolName &&
    proof.serverId === action.serverId &&
    proof.argsHash === policyArgsHash(action.args);
}

export function createPolicyApprovalProof(input: {
  toolContextId: string;
  toolCallId: string;
  toolName: string;
  serverId: string;
  args: Record<string, unknown>;
  ruleId: string | null;
  explanation: string;
}): PolicyApprovalProof {
  const argsHash = policyArgsHash(input.args);
  return {
    // One approval per proposed call. A repeated identical call must prompt again.
    approvalId: `polapr_${randomUUID().replaceAll("-", "")}`,
    toolContextId: input.toolContextId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    serverId: input.serverId,
    argsHash,
    ruleId: input.ruleId,
    explanation: input.explanation
  };
}

/** Removes the gateway metadata keys from `args` in place. */
export function stripPolicyApprovalMetadata(args: Record<string, unknown>): void {
  for (const key of POLICY_APPROVAL_METADATA_KEYS) delete args[key];
}

export function withoutPolicyApprovalMetadata(
  args: Record<string, unknown>
): Record<string, unknown> {
  const cleaned = { ...args };
  stripPolicyApprovalMetadata(cleaned);
  return cleaned;
}
