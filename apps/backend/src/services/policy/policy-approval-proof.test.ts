import { describe, expect, it } from "vitest";

import {
  createPolicyApprovalProof,
  matchesPolicyApprovalAction,
  policyArgsHash,
  POLICY_APPROVAL_MARKER_KEY,
  withoutPolicyApprovalMetadata
} from "./policy-approval-proof.js";

// The keys that the runtime and the gateway add to the ROOT of a call's arguments.
const TRANSPORT_KEYS = ["toolContextId", "policyApprovalId", POLICY_APPROVAL_MARKER_KEY] as const;

describe("policy approval proof", () => {
  it("hashes canonical caller arguments and ignores gateway metadata", () => {
    expect(policyArgsHash({ b: 2, a: { y: 2, x: 1 } })).toBe(
      policyArgsHash({ a: { x: 1, y: 2 }, b: 2, toolContextId: "ctx", policyApprovalId: "proof" })
    );
    expect(policyArgsHash({ a: 1 })).not.toBe(policyArgsHash({ a: 2 }));
  });

  it.each(TRANSPORT_KEYS)("leaves a root %s out of the hash, whatever its value", (key) => {
    const approved = { name: "units", metadata: { source: "chat" }, list: [1, { a: 2 }] };

    expect(policyArgsHash({ ...approved, [key]: "any value" })).toBe(policyArgsHash(approved));
    expect(policyArgsHash({ ...approved, [key]: { approvalId: "forged", toolContextId: "ctx" } })).toBe(policyArgsHash(approved));
    expect(policyArgsHash({ ...approved, [key]: ["x"] })).toBe(policyArgsHash(approved));
  });

  it.each(TRANSPORT_KEYS)("hashes a nested %s, because it is data that the user approved", (key) => {
    const approved = { name: "units", metadata: { [key]: "approved value" } };

    // A different value, no key at all, and the key moved one level down each change the hash.
    expect(policyArgsHash({ name: "units", metadata: { [key]: "another value" } })).not.toBe(policyArgsHash(approved));
    expect(policyArgsHash({ name: "units", metadata: {} })).not.toBe(policyArgsHash(approved));
    expect(policyArgsHash({ name: "units", metadata: { deeper: { [key]: "approved value" } } })).not.toBe(policyArgsHash(approved));
    // Inside arrays, at any depth.
    expect(policyArgsHash({ items: [{ [key]: "1" }] })).not.toBe(policyArgsHash({ items: [{ [key]: "2" }] }));
    expect(policyArgsHash({ items: [{ [key]: "1" }] })).not.toBe(policyArgsHash({ items: [{}] }));
    expect(policyArgsHash({ a: { b: { c: [{ [key]: { d: 1 } }] } } })).not.toBe(policyArgsHash({ a: { b: { c: [{ [key]: { d: 2 } }] } } }));
    // The order in which a caller wrote the keys still does not matter.
    expect(policyArgsHash({ a: { [key]: "1", z: 2 } })).toBe(policyArgsHash({ a: { z: 2, [key]: "1" } }));
  });

  it("keeps the hash of arguments with no nested transport key, so an approval made earlier still matches", () => {
    // These values come from the earlier algorithm, which dropped the transport keys at every level.
    // They must not change: an approval that was made but not yet used holds one of them.
    expect(policyArgsHash({
      name: "units",
      content: "Prefère le système métrique ✓",
      metadata: { source: "chat", n: 1, nested: { b: 2, a: [3, 1, 2] }, note: "Ünïcode — ✓" },
      toolContextId: "ctx",
      policyApprovalId: "polapr_1"
    })).toBe("203860a0eb965d4441f2a5f2988473a4f4e5ca0a569963b3d91fd18546e513f1");
    expect(policyArgsHash({ b: 2, a: { y: 2, x: 1 }, list: [{ z: 1, k: [true, null, "s"] }, 3] }))
      .toBe("dc917ccf35d2d828718ffc925a407586b2ac498d345724287abb8de447b31fd9");
    expect(policyArgsHash({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });

  it("matches the call as approved when the runtime adds transport keys at the root, and no other call", () => {
    const approvedArgs = { name: "units", metadata: { toolContextId: "nested data", inner: { policyApprovalId: "nested id" } } };
    const proof = createPolicyApprovalProof({ toolContextId: "ctx", toolCallId: "call-1", toolName: "memory_save",
      serverId: "managed", args: approvedArgs, ruleId: null, explanation: "Saves data." });
    const action = (args: Record<string, unknown>) => ({ toolName: "memory_save", serverId: "managed", args });
    // The dispatch hook adds the context and the approval id at the root, as the gateway does.
    const dispatched = { ...approvedArgs, toolContextId: "backend ctx", policyApprovalId: proof.approvalId };

    expect(matchesPolicyApprovalAction(proof, action(dispatched))).toBe(true);
    expect(matchesPolicyApprovalAction(proof, action(approvedArgs))).toBe(true);
    for (const metadata of [
      { toolContextId: "changed", inner: { policyApprovalId: "nested id" } },
      { toolContextId: "nested data", inner: { policyApprovalId: "changed" } },
      { toolContextId: "nested data", inner: {} },
      { inner: { policyApprovalId: "nested id" } }
    ]) {
      expect(matchesPolicyApprovalAction(proof, action({ ...dispatched, metadata }))).toBe(false);
    }
  });

  it("creates a new approval id for each proposed call", () => {
    const input = {
      toolContextId: "context-1",
      toolCallId: "call-1",
      toolName: "github_write_file",
      serverId: "github",
      args: { path: "README.md", content: "hello" },
      ruleId: "rule-1",
      explanation: "Review the write"
    };
    const proof = createPolicyApprovalProof(input);
    const repeat = createPolicyApprovalProof({ ...input, args: { content: "hello", path: "README.md" } });
    expect(proof.approvalId).toMatch(/^polapr_[0-9a-f]{32}$/);
    expect(repeat.approvalId).not.toBe(proof.approvalId);
    expect({ ...repeat, approvalId: proof.approvalId }).toEqual(proof);
  });

  it("strips internal metadata from caller arguments", () => {
    const args = { query: "roadmap", __cogniplanePolicyApproval: { approvalId: "forged" }, policyApprovalId: "forged" };
    expect(withoutPolicyApprovalMetadata(args)).toEqual({ query: "roadmap" });
  });
});
