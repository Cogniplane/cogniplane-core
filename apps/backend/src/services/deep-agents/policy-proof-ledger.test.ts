import { describe, expect, it } from "vitest";

import { PolicyProofLedger } from "./policy-proof-ledger.js";

const evaluated = { toolContextId: "ctx-1", ruleId: "rule-1", explanation: "Review writes." };
const call = { id: "call-1", name: "write_artifact", serverId: "managed", args: { name: "report.md" } };

function interrupted() {
  const ledger = new PolicyProofLedger();
  expect(ledger.begin(call).interrupt([call], evaluated)).toBe(true);
  const description = ledger.description(call.id);
  return { ledger, description, proof: ledger.forAction({ ...call, description })! };
}

describe("PolicyProofLedger", () => {
  it("creates a proof for an interrupted call and finds it through the description", () => {
    const { description, proof } = interrupted();
    expect(description).toBe("policy-proof:call-1");
    expect(proof).toMatchObject({ toolCallId: "call-1", toolName: "write_artifact", serverId: "managed",
      toolContextId: "ctx-1", ruleId: "rule-1", explanation: "Review writes." });
  });

  it.each([
    ["other arguments", { args: { name: "other.md" } }],
    ["other tool", { name: "other_tool" }],
    ["other server", { serverId: "proxy" }],
    ["unknown server", { serverId: undefined }],
    ["other description", { description: "policy-proof:call-2" }],
    ["model description", { description: "call-1" }]
  ])("finds no proof for an action with %s", (_case, change) => {
    const { ledger, description } = interrupted();
    expect(ledger.forAction({ ...call, description, ...change })).toBeUndefined();
  });

  it("gives a proof at dispatch only for the approved nested keys that are named like transport keys", () => {
    const nested = { ...call, args: { name: "report.md", metadata: { toolContextId: "nested", inner: [{ policyApprovalId: "one" }] } } };
    const ledger = new PolicyProofLedger();
    expect(ledger.begin(nested).interrupt([nested], evaluated)).toBe(true);
    const proof = ledger.forAction({ ...nested, description: ledger.description(nested.id) })!;

    // Root transport keys, such as the model's own `toolContextId`, do not change the match. The nested ones are the call's own.
    const dispatched = { ...nested.args, toolContextId: "backend context", policyApprovalId: proof.approvalId };
    expect(ledger.forDispatch(nested.id, { ...nested, args: dispatched })).toBe(proof);
    for (const metadata of [
      { toolContextId: "another", inner: [{ policyApprovalId: "one" }] },
      { toolContextId: "nested", inner: [{ policyApprovalId: "two" }] },
      { toolContextId: "nested", inner: [{}] },
      { inner: [{ policyApprovalId: "one" }] }
    ]) {
      expect(ledger.forDispatch(nested.id, { ...nested, args: { ...dispatched, metadata } })).toBeUndefined();
      expect(ledger.forAction({ ...nested, args: { ...nested.args, metadata }, description: ledger.description(nested.id) })).toBeUndefined();
    }
  });

  it("reuses the proof once on resume, then gives a repeated call a new proof", () => {
    const { ledger, description, proof } = interrupted();
    expect(ledger.begin(call).interrupt([call], evaluated)).toBe(true);
    expect(ledger.forAction({ ...call, description })).toBeUndefined();
    expect(ledger.forDispatch(call.id, call)).toBe(proof);

    expect(ledger.begin(call).interrupt([call], evaluated)).toBe(true);
    const repeated = ledger.forAction({ ...call, description })!;
    expect(repeated.approvalId).not.toBe(proof.approvalId);
  });

  it("keeps a live interrupt's proof when another call reuses its ID", () => {
    const { ledger, description, proof } = interrupted();
    const collision = { ...call, args: { name: "other.md" } };
    expect(ledger.begin(collision).interrupt([collision], evaluated)).toBe(false);
    ledger.begin(collision).release();
    expect(ledger.forAction({ ...call, description })).toBe(proof);
  });

  it("fixes ownership before evaluation, so a concurrent same-ID call cannot take the new proof", () => {
    const ledger = new PolicyProofLedger();
    const first = ledger.begin(call);
    const second = ledger.begin({ ...call });
    // Both predicates await policy evaluation; the first then creates its proof.
    expect(first.interrupt([call], evaluated)).toBe(true);
    expect(second.interrupt([call], evaluated)).toBe(false);
    expect(ledger.forAction({ ...call, description: ledger.description(call.id) })).toMatchObject({ toolCallId: "call-1" });
  });

  it("refuses a call whose ID repeats in the same model response", () => {
    const ledger = new PolicyProofLedger();
    expect(ledger.begin(call).interrupt([call, { ...call, args: { name: "other.md" } }], evaluated)).toBe(false);
    expect(ledger.forDispatch(call.id, call)).toBeUndefined();
  });

  it("refuses a call without an ID", () => {
    const ledger = new PolicyProofLedger();
    const anonymous = { ...call, id: undefined };
    expect(ledger.begin(anonymous).interrupt([anonymous], evaluated)).toBe(false);
    expect(ledger.description(undefined)).toBe("policy-proof:");
  });

  it("releases only a proof the call owns", () => {
    const { ledger } = interrupted();
    ledger.begin(call).release();
    expect(ledger.forDispatch(call.id, call)).toBeUndefined();
    // After release the ID is free: a new interrupt creates a new proof.
    expect(ledger.begin(call).interrupt([call], evaluated)).toBe(true);
  });

  it("gives a proof at dispatch only for the same tool, server and arguments", () => {
    const { ledger, proof } = interrupted();
    expect(ledger.forDispatch("call-1", call)).toBe(proof);
    expect(ledger.forDispatch("call-1", { ...call, args: { name: "other.md" } })).toBeUndefined();
    expect(ledger.forDispatch("call-1", { ...call, name: "other_tool" })).toBeUndefined();
    expect(ledger.forDispatch("call-1", { ...call, serverId: "proxy" })).toBeUndefined();
    expect(ledger.forDispatch("call-1", { ...call, serverId: undefined })).toBeUndefined();
    expect(ledger.forDispatch("call-2", call)).toBeUndefined();
    expect(ledger.forDispatch(undefined, call)).toBeUndefined();
  });

  it("forgets proofs and pending calls on reset", () => {
    const { ledger, description } = interrupted();
    ledger.reset();
    expect(ledger.forAction({ ...call, description })).toBeUndefined();
    expect(ledger.forDispatch(call.id, call)).toBeUndefined();
    // No stale pending mark survives: the ID is not treated as a collision.
    expect(ledger.begin({ ...call, args: { name: "other.md" } }).interrupt(undefined, evaluated)).toBe(true);
  });
});
