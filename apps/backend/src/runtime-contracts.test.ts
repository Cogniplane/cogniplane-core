import { describe, expect, it } from "vitest";
import { resolveTurnApprovalSettings } from "./runtime-contracts.js";
import { testRuntimePolicy } from "./test-helpers/test-runtime-policy.js";

describe("project approval mode resolution", () => {
  it("inherits the organization's native approval behavior by default", () => {
    expect(resolveTurnApprovalSettings(testRuntimePolicy, "organization_default")).toEqual({
      gate: true,
      autoApproveReadOnly: true
    });
  });

  it("makes manual approval explicit and does not auto-approve read-only tools", () => {
    expect(resolveTurnApprovalSettings(testRuntimePolicy, "manual")).toEqual({
      gate: true,
      autoApproveReadOnly: false
    });
  });

  it("does not weaken the organization's native approval gate in automatic mode", () => {
    expect(resolveTurnApprovalSettings(testRuntimePolicy, "automatic")).toEqual({
      gate: true,
      autoApproveReadOnly: true
    });
  });

  it("preserves a granular organization's native approval floor in automatic mode", () => {
    expect(resolveTurnApprovalSettings({
      ...testRuntimePolicy,
      approvalPolicy: {
        granular: {
          sandbox_approval: true,
          mcp_elicitations: true,
          rules: true,
          request_permissions: true,
          skill_approval: true
        }
      },
      autoApproveReadOnlyTools: false
    }, "automatic")).toEqual({
      gate: true,
      autoApproveReadOnly: false
    });
  });

  it("allows automatic mode to skip native prompts only when the organization disables them", () => {
    expect(resolveTurnApprovalSettings({
      ...testRuntimePolicy,
      approvalPolicy: "never",
      autoApproveReadOnlyTools: false
    }, "automatic")).toEqual({
      gate: false,
      autoApproveReadOnly: false
    });
  });

  it("inherits the organization behavior when approvals are disabled", () => {
    expect(resolveTurnApprovalSettings({ ...testRuntimePolicy, approvalPolicy: "never" }, "organization_default")).toEqual({
      gate: false,
      autoApproveReadOnly: true
    });
  });
});
