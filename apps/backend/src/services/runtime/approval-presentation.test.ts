import { describe, expect, it } from "vitest";

import { createPolicyApprovalProof } from "../policy/policy-approval-proof.js";
import type { ApprovalRequest } from "./approval-coordinator.js";
import { approvalPresentation } from "./approval-presentation.js";

function artifact(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { name: "write_artifact", kind: "mcp_tool", server: { id: "tenant-managed", mode: "managed" },
    args: { name: "report.md", content: "é🙂", toolContextId: "private-context", credentials: "private-credential" },
    ...overrides };
}

describe("readable artifact approval", () => {
  it("names the file, destination and exact UTF-8 size without disclosing content or context", () => {
    const presentation = approvalPresentation(artifact(), null);
    expect(presentation.title).toBe('Save "report.md" to Artifacts');
    expect(presentation.summary).toBe("The agent wants to save 6 bytes of inline text as a file in this chat. " +
      "If saved, you can open or download it from the Artifacts panel. Reason: This tool requires approval.");
    for (const hidden of ["é🙂", "private-context", "private-credential", "toolContextId", "credentials"])
      expect(JSON.stringify(presentation)).not.toContain(hidden);
  });

  it.each([
    ["controls", "re\npo\trt\u0000.md", "report.md"],
    ["bidi and zero width", "re\u202eport\u2066\u200b\u200d\ufeff.md", "report.md"],
    ["unpaired surrogate", "report\ud800.md", "report.md"],
    ["normalization", "cafe\u0301.md", "café.md"],
    ["quotes", 'my"report.md', 'my"report.md'],
    ["long Unicode", "🙂".repeat(130) + ".md", "🙂".repeat(117) + "..."],
    ["inline credential", "ghp_abcdefghi0123456789.md", "[REDACTED].md"],
    ["split credential", "ghp_abcd\u200befghi0123456789.md", "[REDACTED].md"]
  ])("cleans and bounds a display filename with %s", (_case, name, expected) => {
    const action = artifact({ args: { name, content: "private body" } });
    expect(approvalPresentation(action, null).title).toBe(`Save ${JSON.stringify(expected)} to Artifacts`);
    expect(action.args.name).toBe(name);
    expect(action.args.content).toBe("private body");
  });

  it("uses a cleaned, bounded historical reason without proof fields or credentials", () => {
    const action = artifact();
    const proof = createPolicyApprovalProof({ toolContextId: "original-context",
      toolCallId: "private-call", toolName: action.name, serverId: action.server!.id, args: action.args,
      ruleId: "historical-rule", explanation: "Review\nthis\twrite \u202eghp_abcdefghi0123456789 " + "🙂".repeat(310) });
    const presentation = approvalPresentation({ ...action, policyApproval: proof }, null);
    expect(presentation.summary).toContain("Reason: Review this write [REDACTED] ");
    expect(presentation.summary).toMatch(/\.\.\.$/);
    expect(Array.from(presentation.summary.split("Reason: ")[1]!)).toHaveLength(300);
    for (const hidden of [proof.argsHash, proof.approvalId, proof.toolContextId, proof.toolCallId, proof.ruleId!, "ghp_"])
      expect(presentation.summary).not.toContain(hidden);
  });

  it("uses the policy reason fallback when display cleaning removes the explanation", () => {
    const action = artifact();
    const proof = createPolicyApprovalProof({ toolContextId: "ctx",
      toolCallId: "call", toolName: action.name, serverId: action.server!.id, args: action.args,
      ruleId: null, explanation: "\u202e\u0000\u200b" });
    expect(approvalPresentation({ ...action, policyApproval: proof }, null).summary)
      .toContain("Reason: Policy Center requires approval.");
  });

  const unsupported: Array<[string, Partial<ApprovalRequest>, string | null]> = [
    ["proxy collision", { server: { id: "proxy", mode: "proxy" } }, null],
    ["unknown server", { server: undefined }, null],
    ["different tool", { name: "other_tool" }, null],
    ["non MCP kind", { kind: "permissions" }, null],
    ["project", {}, "project-1"],
    ...["/workspace/report.md", "", null, undefined].map((filePath): typeof unsupported[number] =>
      ["filePath present", { args: { name: "report.md", content: "private body", filePath } }, null]),
    ["missing content", { args: { name: "report.md" } }, null],
    ["empty content", { args: { name: "report.md", content: "" } }, null],
    ["non string content", { args: { name: "report.md", content: 42 } }, null],
    ["empty filename", { args: { name: "\u200b\u0000 ", content: "body" } }, null],
    ["non string filename", { args: { name: 42, content: "body" } }, null]
  ];
  it.each(unsupported)("keeps accurate redacted JSON fallback for %s", (_case, overrides, projectId) => {
    const action = artifact(overrides);
    const result = approvalPresentation(action, projectId);
    expect(result.title).toBe(`Approve ${action.name}`);
    expect(JSON.parse(result.summary)).toMatchObject(action.args.credentials ? { credentials: "[REDACTED]" } : {});
    expect(result.summary).not.toContain("private-credential");
    expect(result.summary).not.toContain("Artifacts panel");
  });

  it.each(["server", "tool"] as const)("keeps fallback for a policy proof with a different %s", (field) => {
    const action = artifact();
    const proof = createPolicyApprovalProof({ toolContextId: "ctx",
      toolCallId: "call", toolName: field === "tool" ? "other-tool" : action.name,
      serverId: field === "server" ? "other-server" : action.server!.id, args: action.args,
      ruleId: null, explanation: "Review" });
    expect(approvalPresentation({ ...action, policyApproval: proof }, null).title).toBe("Approve write_artifact");
  });
});
