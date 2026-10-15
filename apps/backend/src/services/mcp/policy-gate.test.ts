import { describe, expect, it } from "vitest";

import { createPolicyApprovalProof, POLICY_APPROVAL_REQUEST_METHOD } from "../policy/policy-approval-proof.js";
import { approvalDispositionForToolCall, enforcePolicyCenter, type PolicyGate } from "./policy-gate.js";

type Input = Parameters<typeof approvalDispositionForToolCall>[0];

function approvedCall(): Input & { approval: NonNullable<Input["approval"]> } {
  const args = { path: "README.md", content: "hello" };
  const proof = createPolicyApprovalProof({
    toolContextId: "original-context",
    toolCallId: "call-1", toolName: "write_artifact", serverId: "managed", args,
    ruleId: "rule-1", explanation: "Review this write."
  });
  return {
    context: {
      toolContextId: "original-context", tenantId: "tenant-1", sessionId: "session-1",
      userId: "user-1", runtimeId: "runtime-1", runtimePolicyId: "policy-1",
      messageId: null, credentialEnvelope: {}, metadata: {},
      expiresAt: "2099-01-01T00:00:00Z", createdAt: "2026-10-06T00:00:00Z"
    },
    toolName: "write_artifact", serverId: "managed", args: {
      content: "hello", path: "README.md", toolContextId: "model-context",
      policyApprovalId: proof.approvalId
    },
    approval: {
      approvalId: proof.approvalId, tenantId: "tenant-1", sessionId: "session-1",
      userId: "user-1", runtimeId: "runtime-1", turnId: "turn-1", itemId: proof.approvalId,
      requestMethod: POLICY_APPROVAL_REQUEST_METHOD, requestId: proof.approvalId,
      kind: "mcp_tool", title: "Approve write_artifact", summary: "Review this write.",
      status: "approved", decision: "approve", requestPayload: { policyApproval: proof },
      createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
      resolvedAt: "2026-10-06T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z"
    }
  };
}

describe("stored policy approval disposition", () => {
  it.each([
    ["approved", "approve", "approve"],
    ["rejected", "reject", "reject"],
    ["expired", null, "expired"]
  ] as const)("accepts the matching stored %s disposition", (status, decision, expected) => {
    const input = approvedCall();
    input.approval.status = status;
    input.approval.decision = decision;
    expect(approvalDispositionForToolCall(input)).toBe(expected);
  });

  const invalid: Array<[string, (input: ReturnType<typeof approvedCall>) => void]> = [
    ["request method", (input) => { input.approval.requestMethod = "deepagents/write_artifact"; }],
    ["session", (input) => { input.approval.sessionId = "other-session"; }],
    ["user", (input) => { input.approval.userId = "other-user"; }],
    ["approval id", (input) => { input.approval.approvalId = "other-approval"; }],
    ["original context", (input) => { input.context.toolContextId = "replacement-context"; }],
    ["tool", (input) => { input.toolName = "other-tool"; }],
    ["server", (input) => { input.serverId = "other-server"; }],
    ["arguments", (input) => { input.args.content = "changed"; }],
    ["missing proof", (input) => { input.approval.requestPayload = {}; }],
    ["pending status", (input) => { input.approval.status = "pending"; }],
    ["approve decision", (input) => { input.approval.decision = "reject"; }],
    ["reject decision", (input) => { input.approval.status = "rejected"; }]
  ];
  it.each(invalid)("refuses a stored approval with a mismatching %s", (_field, change) => {
    const input = approvedCall();
    change(input);
    expect(approvalDispositionForToolCall(input)).toBeUndefined();
  });

  it("binds a nested transport-named key: only the approved nested value is accepted", () => {
    const approvedArgs = { path: "README.md", options: { toolContextId: "approved nested value", list: [{ policyApprovalId: "one" }] } };
    const input = approvedCall();
    const proof = createPolicyApprovalProof({
      toolContextId: "original-context", toolCallId: "call-1", toolName: "write_artifact", serverId: "managed",
      args: approvedArgs, ruleId: "rule-1", explanation: "Review this write."
    });
    input.approval.approvalId = proof.approvalId;
    input.approval.itemId = proof.approvalId;
    input.approval.requestId = proof.approvalId;
    input.approval.requestPayload = { policyApproval: proof };
    // The root keys are the ones that the runtime and the gateway add.
    const dispatched = { ...approvedArgs, toolContextId: "model-context", policyApprovalId: proof.approvalId };

    expect(approvalDispositionForToolCall({ ...input, args: dispatched })).toBe("approve");
    for (const options of [
      { toolContextId: "another nested value", list: [{ policyApprovalId: "one" }] },
      { toolContextId: "approved nested value", list: [{ policyApprovalId: "two" }] },
      { toolContextId: "approved nested value", list: [{}] },
      { list: [{ policyApprovalId: "one" }] }
    ]) {
      expect(approvalDispositionForToolCall({ ...input, args: { ...dispatched, options } })).toBeUndefined();
    }
  });

  it("does not infer authority from a matching action without a stored row", () => {
    expect(approvalDispositionForToolCall({ ...approvedCall(), approval: null })).toBeUndefined();
  });
});

describe("enforcePolicyCenter outcome", () => {
  // The call is the one `approvedCall` describes. The gate claims the approval once, like ApprovalStore.consume.
  function gateFor(input: ReturnType<typeof approvedCall>) {
    let claimed = false;
    const consume = async () => {
      if (claimed || input.approval.status !== "approved") return false;
      claimed = true;
      return true;
    };
    const gate: PolicyGate = {
      policyService: {
        async gateAction() {
          return { evaluation: { outcome: "allow", matchedRuleId: null, matchedRuleName: null, gating: false, explanation: null }, enforced: false };
        },
        async evaluate() {
          return { outcome: "allow", matchedRuleId: null, matchedRuleName: null, gating: false, explanation: null };
        }
      },
      approvals: { get: async () => input.approval, consume },
      logger: { warn() {} }
    };
    return gate;
  }
  const policySnapshot = { policyEnforcementMode: "monitor" };

  function run(input: ReturnType<typeof approvedCall>, gate: PolicyGate) {
    return enforcePolicyCenter(
      gate,
      { ...input.context, metadata: { runtimePolicy: { ...policySnapshot, id: "p", version: 1, hash: "h", enabledToolIds: [], enabledMcpServers: [] } } } as never,
      input.toolName, input.serverId, { readOnly: false }, input.args
    );
  }

  it("reports the claimed approval once and a replay as consumed, in any enforcement mode", async () => {
    const input = approvedCall();
    const gate = gateFor(input);

    const first = await run(input, gate);
    expect(first.approvalDisposition).toBe("approve");
    expect(first.approval).toBe(input.approval);

    const replay = await run(input, gate);
    expect(replay).toEqual({ approvalDisposition: "consumed", approval: null });
  });

  it("reports no approval for a changed argument, and does not claim the approval", async () => {
    const input = approvedCall();
    const gate = gateFor(input);

    expect(await run({ ...input, args: { ...input.args, content: "changed" } }, gate))
      .toEqual({ approvalDisposition: undefined, approval: null });
    expect((await run(input, gate)).approvalDisposition).toBe("approve");
  });

  it("reports no approval when the call names none", async () => {
    const input = approvedCall();
    const { policyApprovalId: _dropped, ...args } = input.args;

    expect(await run({ ...input, args }, gateFor(input))).toEqual({ approvalDisposition: undefined, approval: null });
  });

  it("does not hand over a declined approval", async () => {
    const input = approvedCall();
    input.approval.status = "rejected";
    input.approval.decision = "reject";

    expect(await run(input, gateFor(input))).toEqual({ approvalDisposition: "reject", approval: null });
  });
});
