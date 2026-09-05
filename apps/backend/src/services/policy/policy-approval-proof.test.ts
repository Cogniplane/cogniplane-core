import { describe, expect, it } from "vitest";

import {
  createPolicyApprovalProof,
  policyArgsHash,
  readPolicyApprovalMarker,
  withoutPolicyApprovalMetadata
} from "./policy-approval-proof.js";

describe("policy approval proof", () => {
  it("hashes canonical caller arguments and ignores gateway metadata", () => {
    expect(policyArgsHash({ b: 2, a: { y: 2, x: 1 } })).toBe(
      policyArgsHash({ a: { x: 1, y: 2 }, b: 2, toolContextId: "ctx", policyApprovalId: "proof" })
    );
    expect(policyArgsHash({ a: 1 })).not.toBe(policyArgsHash({ a: 2 }));
  });

  it("creates a stable call-bound approval id", () => {
    const input = {
      tenantId: "tenant-1",
      sessionId: "session-1",
      toolContextId: "context-1",
      toolCallId: "call-1",
      toolName: "github_write_file",
      serverId: "github",
      args: { path: "README.md", content: "hello" },
      ruleId: "rule-1",
      explanation: "Review the write"
    };
    const proof = createPolicyApprovalProof(input);
    expect(proof.approvalId).toMatch(/^polapr_[0-9a-f]{32}$/);
    expect(createPolicyApprovalProof({ ...input, args: { content: "hello", path: "README.md" } }))
      .toEqual(proof);
    expect(createPolicyApprovalProof({ ...input, toolCallId: "call-2" }).approvalId)
      .not.toBe(proof.approvalId);
  });

  it("reads and strips only valid internal metadata", () => {
    const proof = createPolicyApprovalProof({
      tenantId: "tenant-1",
      sessionId: "session-1",
      toolContextId: "context-1",
      toolCallId: "call-1",
      toolName: "search",
      serverId: "notion",
      args: { query: "roadmap" },
      ruleId: null,
      explanation: "Review"
    });
    const args = { query: "roadmap", __cogniplanePolicyApproval: proof, policyApprovalId: proof.approvalId };
    expect(readPolicyApprovalMarker(args)).toEqual(proof);
    expect(withoutPolicyApprovalMetadata(args)).toEqual({ query: "roadmap" });
    expect(readPolicyApprovalMarker({ __cogniplanePolicyApproval: { approvalId: "bad" } })).toBeNull();
  });
});
