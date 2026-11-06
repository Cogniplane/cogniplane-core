import { describe, expect, it } from "vitest";
import { resolveTurnApprovalSettings } from "./runtime-contracts.js";
import type { ResolvedRuntimePolicy } from "./services/admin-config-records.js";
import { testRuntimePolicy } from "./test-helpers/test-runtime-policy.js";

describe("project approval mode resolution", () => {
  describe.each([
    { name: "disabled approvals", approvalPolicy: "never", gate: false },
    { name: "on-request approvals", approvalPolicy: "on-request", gate: true },
    {
      name: "all granular approvals enabled",
      approvalPolicy: { granular: {
        sandbox_approval: true, mcp_elicitations: true, rules: true,
        request_permissions: true, skill_approval: true
      } },
      gate: true
    },
    {
      name: "all granular approvals disabled",
      approvalPolicy: { granular: {
        sandbox_approval: false, mcp_elicitations: false, rules: false,
        request_permissions: false, skill_approval: false
      } },
      gate: true
    },
    {
      name: "mixed granular approvals",
      approvalPolicy: { granular: {
        sandbox_approval: false, mcp_elicitations: true, rules: false,
        request_permissions: true, skill_approval: false
      } },
      gate: true
    },
    {
      name: "granular approvals without the optional skill setting",
      approvalPolicy: { granular: {
        sandbox_approval: true, mcp_elicitations: false, rules: true,
        request_permissions: false
      } },
      gate: true
    }
  ] satisfies Array<{ name: string; approvalPolicy: ResolvedRuntimePolicy["approvalPolicy"]; gate: boolean }>)("$name", ({ approvalPolicy, gate }) => {
    it.each([
      { autoApproveReadOnlyTools: false, policyEnforcementMode: "monitor" },
      { autoApproveReadOnlyTools: true, policyEnforcementMode: "monitor" },
      { autoApproveReadOnlyTools: false, policyEnforcementMode: "enforce" },
      { autoApproveReadOnlyTools: true, policyEnforcementMode: "enforce" }
    ] as const)("keeps automatic equivalent to organization default with read-only bypass $autoApproveReadOnlyTools and Policy Center $policyEnforcementMode", (settings) => {
      const policy = { ...testRuntimePolicy, ...settings, approvalPolicy };
      const organizationDefault = resolveTurnApprovalSettings(policy, "organization_default");
      expect(organizationDefault).toEqual({ gate, autoApproveReadOnly: settings.autoApproveReadOnlyTools });
      expect(resolveTurnApprovalSettings(policy, "automatic")).toEqual(organizationDefault);
      expect(resolveTurnApprovalSettings(policy)).toEqual(organizationDefault);
      expect(resolveTurnApprovalSettings(policy, "manual")).toEqual({ gate: true, autoApproveReadOnly: false });
    });
  });

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
