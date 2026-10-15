import { describe, expect, test } from "vitest";

import type { ApprovalPolicy, TenantSettings } from "@cogniplane/shared-types";

import { SANDBOX_EGRESS_DOMAINS_MAX } from "@cogniplane/shared-types/sandbox-egress";

import {
  buildDraft,
  defaultGranularFlags,
  formatRelativeTime,
  parseSandboxEgressText,
  toApprovalPolicy,
  toApprovalPolicyKind,
  toggleInArray,
  toGranularFlags
} from "./tenant-settings-form.logic";
import { makeTenantSettings } from "../test-helpers/tenant-settings";

const baseSettings = makeTenantSettings({ webSearchMode: "cached" });

describe("toApprovalPolicyKind / toGranularFlags / toApprovalPolicy", () => {
  test("scalar policies pass through", () => {
    expect(toApprovalPolicyKind("never")).toBe("never");
    expect(toApprovalPolicyKind("on-request")).toBe("on-request");
  });

  test("granular policy decodes its flags", () => {
    const policy: ApprovalPolicy = {
      granular: {
        sandbox_approval: true,
        mcp_elicitations: false,
        rules: true,
        request_permissions: true,
        skill_approval: false
      }
    };
    expect(toApprovalPolicyKind(policy)).toBe("granular");
    expect(toGranularFlags(policy)).toEqual({
      sandbox_approval: true,
      mcp_elicitations: false,
      rules: true,
      request_permissions: true,
      skill_approval: false
    });
  });

  test("scalar policy yields default granular flags", () => {
    expect(toGranularFlags("never")).toEqual(defaultGranularFlags);
  });

  test("toApprovalPolicy round-trips scalar kinds", () => {
    expect(toApprovalPolicy("never", defaultGranularFlags)).toBe("never");
    expect(toApprovalPolicy("on-request", defaultGranularFlags)).toBe("on-request");
  });

  test("toApprovalPolicy emits granular shape when kind is granular", () => {
    const flags = {
      sandbox_approval: true,
      mcp_elicitations: false,
      rules: true,
      request_permissions: false,
      skill_approval: true
    };
    expect(toApprovalPolicy("granular", flags)).toEqual({ granular: flags });
  });
});

describe("buildDraft", () => {
  test("clones tool/MCP id arrays so the original is not mutated", () => {
    const settings = {
      ...baseSettings,
      enabledToolIds: ["a"],
      enabledMcpServerIds: ["b"]
    };
    const draft = buildDraft(settings);
    draft.enabledToolIds.push("c");
    expect(settings.enabledToolIds).toEqual(["a"]);
  });

  test("carries webSearchMode through, defaulting to disabled when absent", () => {
    expect(buildDraft(baseSettings).webSearchMode).toBe("cached");
    expect(
      buildDraft({ ...baseSettings, webSearchMode: undefined } as unknown as TenantSettings)
        .webSearchMode
    ).toBe("disabled");
  });

  test("normalizes nullish developerInstructions to empty string", () => {
    const draft = buildDraft({ ...baseSettings, developerInstructions: null });
    expect(draft.developerInstructions).toBe("");
  });
});

describe("toggleInArray", () => {
  test("adds when enabling", () => {
    expect(toggleInArray(["a"], "b", true)).toEqual(["a", "b"]);
  });

  test("does not duplicate when already present", () => {
    expect(toggleInArray(["a"], "a", true)).toEqual(["a"]);
  });

  test("removes when disabling", () => {
    expect(toggleInArray(["a", "b"], "a", false)).toEqual(["b"]);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-09T12:00:00Z");

  test("returns 'just now' for sub-minute deltas", () => {
    expect(formatRelativeTime("2026-05-09T11:59:30Z", now)).toBe("just now");
  });

  test("uses minutes / hours / days bands", () => {
    expect(formatRelativeTime("2026-05-09T11:30:00Z", now)).toBe("30m ago");
    expect(formatRelativeTime("2026-05-09T08:00:00Z", now)).toBe("4h ago");
    expect(formatRelativeTime("2026-05-04T12:00:00Z", now)).toBe("5d ago");
  });

  test("falls back to a locale date for >30d deltas", () => {
    const out = formatRelativeTime("2026-01-01T12:00:00Z", now);
    expect(out).not.toMatch(/ago$/);
  });
});

describe("approved sandbox hosts text", () => {
  test("the draft starts from the saved list, one host per line", () => {
    const draft = buildDraft(makeTenantSettings({ approvedSandboxEgressDomains: ["*.example.com", "pypi.org"] }));
    expect(draft.sandboxEgressText).toBe("*.example.com\npypi.org");
    expect(buildDraft(makeTenantSettings()).sandboxEgressText).toBe("");
  });

  test("reads one host per line, and fixes spaces and upper case that a paste brings", () => {
    expect(parseSandboxEgressText("  PyPI.org \r\n\n*.Example.com\npypi.org\n")).toEqual({
      domains: ["*.example.com", "pypi.org"],
      errors: [],
      tooMany: false
    });
    expect(parseSandboxEgressText("")).toEqual({ domains: [], errors: [], tooMany: false });
  });

  test("also reads a comma-separated paste", () => {
    expect(parseSandboxEgressText("pypi.org, files.pythonhosted.org,registry.npmjs.org").domains)
      .toEqual(["files.pythonhosted.org", "pypi.org", "registry.npmjs.org"]);
  });

  test("names the line and the entry of every host that the server would refuse", () => {
    const parsed = parseSandboxEgressText("pypi.org\n*.com\nhttps://example.org\n\n93.184.216.34\nbad host");
    expect(parsed.domains).toEqual(["pypi.org"]);
    expect(parsed.errors.map((error) => [error.line, error.entry])).toEqual([
      [2, "*.com"],
      [3, "https://example.org"],
      [5, "93.184.216.34"],
      [6, "bad host"]
    ]);
    expect(parsed.errors[0]!.message).toContain("public suffix");
    expect(parsed.errors[1]!.message).toContain("scheme");
  });

  test("keeps the entry as typed in the error, with its upper case", () => {
    expect(parseSandboxEgressText("HTTPS://Example.org").errors[0]!.entry).toBe("HTTPS://Example.org");
  });

  test("flags a list over the limit, counted after duplicates are removed", () => {
    const many = Array.from({ length: SANDBOX_EGRESS_DOMAINS_MAX + 1 }, (_, i) => `host${i}.example.com`);
    expect(parseSandboxEgressText(many.join("\n")).tooMany).toBe(true);
    expect(parseSandboxEgressText([...many.slice(0, SANDBOX_EGRESS_DOMAINS_MAX), many[0]].join("\n")).tooMany).toBe(false);
  });
});
