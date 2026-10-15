import { describe, expect, test } from "vitest";

import type { TenantSettings } from "@cogniplane/shared-types";

import {
  affectsApprovals,
  deriveImpactHighlights,
  diffAgentBehavior,
  rebaseDraft,
  toBehaviorInput,
  type BehaviorChange
} from "./agent-behavior-impact";
import { buildDraft, type FormDraft } from "./tenant-settings-form.logic";
import { makeTenantSettings } from "../test-helpers/tenant-settings";

const saved = makeTenantSettings({
  approvalPolicy: "on-request",
  autoApproveReadOnlyTools: true,
  allowCommandExecution: false,
  developerInstructions: "Be brief.",
  enabledToolIds: ["search_docs", "read_file"]
});

function draftFrom(settings: TenantSettings, edit: Partial<FormDraft> = {}): FormDraft {
  return { ...buildDraft(settings), ...edit };
}

function change(changes: BehaviorChange[], field: string): BehaviorChange {
  const found = changes.find((entry) => entry.field === field);
  if (!found) throw new Error(`No change for ${field}`);
  return found;
}

describe("diffAgentBehavior normalization", () => {
  test("ignores edits that save the same value", () => {
    const base = buildDraft(saved);
    const draft = draftFrom(saved, {
      developerInstructions: "  Be brief.\n",
      enabledToolIds: ["read_file", "search_docs", "read_file"],
      // Category flags do not apply unless the policy is granular.
      granularFlags: { ...base.granularFlags, rules: true },
      // Fields that this page does not save.
      showEffortSelector: true,
      policyEnforcementMode: "enforce",
      enabledMcpServerIds: ["other"]
    });
    expect(diffAgentBehavior(base, draft)).toEqual([]);
  });

  test("treats missing optional granular flags as off", () => {
    const stored = makeTenantSettings({
      approvalPolicy: { granular: { sandbox_approval: true, mcp_elicitations: false, rules: false } }
    });
    const draft = draftFrom(stored, {
      granularFlags: {
        sandbox_approval: true,
        mcp_elicitations: false,
        rules: false,
        request_permissions: false,
        skill_approval: false
      }
    });
    expect(diffAgentBehavior(buildDraft(stored), draft)).toEqual([]);
  });

  test("an unticked granular policy only changes the mode", () => {
    const changes = diffAgentBehavior(buildDraft(saved), draftFrom(saved, { approvalPolicyKind: "granular" }));
    expect(changes.map((entry) => entry.field)).toEqual(["approvalPolicy"]);
  });
});

describe("diffAgentBehavior completeness", () => {
  test("lists every changed field in form order with before and after", () => {
    const draft = draftFrom(saved, {
      webSearchMode: "live",
      approvalPolicyKind: "granular",
      granularFlags: {
        sandbox_approval: true,
        mcp_elicitations: false,
        rules: true,
        request_permissions: false,
        skill_approval: false
      },
      approvalReviewer: "guardian_subagent",
      autoApproveReadOnlyTools: false,
      allowCommandExecution: true,
      sandboxEgressText: "pypi.org\n*.example.com",
      enabledToolIds: ["read_file", "write_report"],
      developerInstructions: "Cite sources."
    });
    const changes = diffAgentBehavior(buildDraft(saved), draft);

    expect(changes.map((entry) => entry.field)).toEqual([
      "webSearchMode",
      "approvalPolicy",
      "granularCategories",
      "approvalReviewer",
      "autoApproveReadOnlyTools",
      "allowCommandExecution",
      "approvedSandboxEgressDomains",
      "enabledToolIds",
      "developerInstructions"
    ]);
    expect(change(changes, "webSearchMode")).toMatchObject({ before: "Disabled", after: "Live" });
    expect(change(changes, "granularCategories")).toMatchObject({
      added: ["Sandbox operations", "Rules"],
      removed: []
    });
    expect(change(changes, "approvalReviewer")).toMatchObject({
      before: "User (human in the loop)",
      after: "Guardian sub-agent"
    });
    expect(change(changes, "enabledToolIds")).toMatchObject({
      added: ["write_report"],
      removed: ["search_docs"],
      tone: "widens"
    });
    expect(change(changes, "developerInstructions")).toMatchObject({
      before: "Be brief.",
      after: "Cite sources."
    });
  });

  test("reports granular categories turned off", () => {
    const stored = makeTenantSettings({
      approvalPolicy: { granular: { sandbox_approval: true, mcp_elicitations: true, rules: false } }
    });
    const draft = draftFrom(stored, {
      granularFlags: { ...buildDraft(stored).granularFlags, mcp_elicitations: false, skill_approval: true }
    });
    expect(change(diffAgentBehavior(buildDraft(stored), draft), "granularCategories")).toMatchObject({
      added: ["Skill invocations"],
      removed: ["MCP elicitations"]
    });
  });

  test("removing tools only narrows access", () => {
    const changes = diffAgentBehavior(buildDraft(saved), draftFrom(saved, { enabledToolIds: ["read_file"] }));
    expect(change(changes, "enabledToolIds")).toMatchObject({ added: [], removed: ["search_docs"], tone: "narrows" });
  });

  test("describes cleared and new instructions", () => {
    const cleared = diffAgentBehavior(buildDraft(saved), draftFrom(saved, { developerInstructions: "   " }));
    expect(change(cleared, "developerInstructions")).toMatchObject({ after: "" });
    expect(change(cleared, "developerInstructions").effect).toMatch(/stop using organization instructions/);

    const empty = makeTenantSettings({ developerInstructions: null });
    const added = diffAgentBehavior(buildDraft(empty), draftFrom(empty, { developerInstructions: "Hi" }));
    expect(change(added, "developerInstructions").effect).toMatch(/get these instructions in their system prompt/);
  });
});

describe("effects", () => {
  test("commands plus Never require approval run without a prompt", () => {
    const base = buildDraft(saved);
    const draft = draftFrom(saved, { approvalPolicyKind: "never", allowCommandExecution: true });
    const changes = diffAgentBehavior(base, draft);

    expect(change(changes, "approvalPolicy").tone).toBe("widens");
    expect(change(changes, "allowCommandExecution")).toMatchObject({ before: "Off", after: "On", tone: "widens" });
    expect(change(changes, "allowCommandExecution").effect).toMatch(/without asking for approval/);
    expect(change(changes, "allowCommandExecution").note).toMatch(/sandbox key \(E2B\)/);
    expect(deriveImpactHighlights(base, draft).map((entry) => entry.title)).toEqual([
      "All members' agents can run shell commands without approval."
    ]);
  });

  test("the highlight also appears when only the approval mode opens the gap", () => {
    const withCommands = makeTenantSettings({ approvalPolicy: "on-request", allowCommandExecution: true });
    const draft = draftFrom(withCommands, { approvalPolicyKind: "never" });
    const highlights = deriveImpactHighlights(buildDraft(withCommands), draft);
    expect(highlights).toHaveLength(1);
    // No command row states the sandbox condition for a mode-only edit.
    expect(highlights[0]?.detail).toMatch(/sandbox key \(E2B\)/);
    expect(highlights[0]?.detail).toMatch(/manual approval still ask/);
    expect(highlights[0]?.detail).toMatch(/Policy Center/);
    expect(change(diffAgentBehavior(buildDraft(withCommands), draft), "approvalPolicy").effect)
      .toMatch(/run shell commands in a sandbox/);
  });

  test("Never require approval with commands off does not claim shell commands", () => {
    const changes = diffAgentBehavior(buildDraft(saved), draftFrom(saved, { approvalPolicyKind: "never" }));
    const policy = change(changes, "approvalPolicy");
    expect(policy.tone).toBe("widens");
    expect(policy.effect).not.toMatch(/change files, run shell commands/);
    expect(policy.effect).toMatch(/cannot run shell commands while command execution is off/);
    expect(policy.effect).toMatch(/available connection tools/);
    expect(policy.note).toMatch(/manual approval still ask/);
    expect(policy.note).toMatch(/Policy Center/);
    expect(deriveImpactHighlights(buildDraft(saved), draftFrom(saved, { approvalPolicyKind: "never" }))).toEqual([]);
  });

  test("no highlight when the saved settings already allowed it", () => {
    const open = makeTenantSettings({ approvalPolicy: "never", allowCommandExecution: true });
    expect(deriveImpactHighlights(buildDraft(open), draftFrom(open, { developerInstructions: "x" }))).toEqual([]);
  });

  test("commands with approval on ask before each command", () => {
    const changes = diffAgentBehavior(buildDraft(saved), draftFrom(saved, { allowCommandExecution: true }));
    expect(change(changes, "allowCommandExecution").effect).toMatch(/Each command asks for approval/);
    expect(deriveImpactHighlights(buildDraft(saved), draftFrom(saved, { allowCommandExecution: true }))).toEqual([]);
  });

  test("turning commands off keeps file tools", () => {
    const withCommands = makeTenantSettings({ allowCommandExecution: true });
    const changes = diffAgentBehavior(buildDraft(withCommands), draftFrom(withCommands, { allowCommandExecution: false }));
    expect(change(changes, "allowCommandExecution")).toMatchObject({ before: "On", after: "Off", tone: "narrows" });
    expect(change(changes, "allowCommandExecution").effect).toMatch(/keep the file tools/);
  });

  test("the read-only bypass depends on the approval mode", () => {
    const gatedOff = makeTenantSettings({ approvalPolicy: "on-request", autoApproveReadOnlyTools: false });
    const widened = change(
      diffAgentBehavior(buildDraft(gatedOff), draftFrom(gatedOff, { autoApproveReadOnlyTools: true })),
      "autoApproveReadOnlyTools"
    );
    expect(widened.tone).toBe("widens");
    expect(widened.effect).toMatch(/read, and search files .* without asking/);

    const narrowed = change(
      diffAgentBehavior(buildDraft(saved), draftFrom(saved, { autoApproveReadOnlyTools: false })),
      "autoApproveReadOnlyTools"
    );
    expect(narrowed.tone).toBe("narrows");

    const never = makeTenantSettings({ approvalPolicy: "never", autoApproveReadOnlyTools: false });
    const inert = change(
      diffAgentBehavior(buildDraft(never), draftFrom(never, { autoApproveReadOnlyTools: true })),
      "autoApproveReadOnlyTools"
    );
    expect(inert).toMatchObject({ tone: "neutral" });
    expect(inert.effect).toMatch(/No effect while approval mode is Never/);
  });

  test("turning approval on follows the read-only bypass", () => {
    const never = makeTenantSettings({ approvalPolicy: "never", autoApproveReadOnlyTools: false });
    const policy = change(
      diffAgentBehavior(buildDraft(never), draftFrom(never, { approvalPolicyKind: "on-request" })),
      "approvalPolicy"
    );
    expect(policy.tone).toBe("narrows");
    expect(policy.effect).toMatch(/before they read or change files/);
    // Default settings have command execution off.
    expect(policy.effect).not.toMatch(/shell commands/);
    expect(policy.note).toMatch(/Shell commands stay off/);

    const withCommands = makeTenantSettings({ approvalPolicy: "never", allowCommandExecution: true });
    const gated = change(
      diffAgentBehavior(buildDraft(withCommands), draftFrom(withCommands, { approvalPolicyKind: "on-request" })),
      "approvalPolicy"
    );
    expect(gated.effect).toMatch(/run shell commands/);
    expect(gated.note).toBeUndefined();
  });

  test("switching between gated modes does not claim a behavior change", () => {
    const policy = change(
      diffAgentBehavior(buildDraft(saved), draftFrom(saved, { approvalPolicyKind: "granular" })),
      "approvalPolicy"
    );
    expect(policy).toMatchObject({ tone: "neutral", savedOnly: false });
    expect(policy.effect).toBe("Agents ask for approval in the same way as before.");
  });

  test("values the runtime does not read are marked saved only", () => {
    const changes = diffAgentBehavior(
      buildDraft(saved),
      draftFrom(saved, {
        webSearchMode: "cached",
        approvalReviewer: "guardian_subagent",
        approvalPolicyKind: "granular",
        granularFlags: { ...buildDraft(saved).granularFlags, rules: true }
      })
    );
    for (const field of ["webSearchMode", "approvalReviewer", "granularCategories"]) {
      expect(change(changes, field)).toMatchObject({ savedOnly: true, tone: "neutral" });
      expect(change(changes, field).effect).toMatch(/^No change to agent behavior/);
    }
    expect(change(changes, "webSearchMode").note).toMatch(/does not use this value/);
  });

  test("affectsApprovals flags only approval-related changes", () => {
    const base = buildDraft(saved);
    expect(affectsApprovals(diffAgentBehavior(base, draftFrom(saved, { developerInstructions: "x" })))).toBe(false);
    expect(affectsApprovals(diffAgentBehavior(base, draftFrom(saved, { autoApproveReadOnlyTools: false })))).toBe(true);
  });
});

describe("rebaseDraft", () => {
  test("keeps another administrator's fields and applies only my edits", () => {
    const from = buildDraft(saved);
    const mine = draftFrom(saved, {
      developerInstructions: "Mine",
      enabledToolIds: ["read_file", "write_report"]
    });
    const latest = makeTenantSettings({
      ...saved,
      version: 2,
      webSearchMode: "live",
      allowCommandExecution: true,
      enabledToolIds: ["search_docs", "read_file", "list_tickets"]
    });

    const rebased = rebaseDraft(from, mine, buildDraft(latest));

    expect(rebased).toMatchObject({
      webSearchMode: "live",
      allowCommandExecution: true,
      developerInstructions: "Mine"
    });
    // Mine added write_report and removed search_docs; theirs added list_tickets.
    expect([...rebased.enabledToolIds].sort()).toEqual(["list_tickets", "read_file", "write_report"]);
    expect(diffAgentBehavior(buildDraft(latest), rebased).map((entry) => entry.field)).toEqual([
      "enabledToolIds",
      "developerInstructions"
    ]);
  });

  test("an unchanged draft becomes the latest settings", () => {
    const latest = buildDraft(makeTenantSettings({ ...saved, version: 3, approvalReviewer: "guardian_subagent" }));
    expect(diffAgentBehavior(latest, rebaseDraft(buildDraft(saved), buildDraft(saved), latest))).toEqual([]);
  });

  test("merges granular flags one by one", () => {
    const stored = makeTenantSettings({
      approvalPolicy: { granular: { sandbox_approval: false, mcp_elicitations: false, rules: false } }
    });
    const mine = draftFrom(stored, { granularFlags: { ...buildDraft(stored).granularFlags, rules: true } });
    const latest = buildDraft(makeTenantSettings({
      version: 2,
      approvalPolicy: { granular: { sandbox_approval: true, mcp_elicitations: false, rules: false } }
    }));
    expect(rebaseDraft(buildDraft(stored), mine, latest).granularFlags).toMatchObject({
      sandbox_approval: true,
      rules: true
    });
  });

  test("keeps the selected granular policy, with its unticked categories, when the draft switched to granular", () => {
    const from = buildDraft(saved);
    const mine = draftFrom(saved, { approvalPolicyKind: "granular" });
    const latest = buildDraft(makeTenantSettings({
      ...saved,
      version: 2,
      approvalPolicy: { granular: { sandbox_approval: false, mcp_elicitations: false, rules: true } }
    }));

    const rebased = rebaseDraft(from, mine, latest);

    expect(rebased.approvalPolicyKind).toBe("granular");
    expect(Object.values(rebased.granularFlags).every((flag) => !flag)).toBe(true);
    const changes = diffAgentBehavior(latest, rebased);
    expect(changes.map((entry) => entry.field)).toEqual(["granularCategories"]);
    expect(change(changes, "granularCategories")).toMatchObject({ added: [], removed: ["Rules"] });
  });
});

describe("toBehaviorInput", () => {
  test("sends only Agent behavior fields with the baseline version", () => {
    const input = toBehaviorInput(
      draftFrom(saved, { developerInstructions: "  Trim me  ", showEffortSelector: true }),
      7
    );
    expect(Object.keys(input).sort()).toEqual([
      "allowCommandExecution",
      "approvalPolicy",
      "approvalReviewer",
      "approvedSandboxEgressDomains",
      "autoApproveReadOnlyTools",
      "developerInstructions",
      "enabledToolIds",
      "expectedVersion",
      "webSearchMode"
    ]);
    expect(input).toMatchObject({ expectedVersion: 7, developerInstructions: "Trim me" });
    expect(toBehaviorInput(draftFrom(saved, { developerInstructions: " " }), 1).developerInstructions).toBeNull();
  });
});

describe("approved sandbox hosts", () => {
  const withHosts = (hosts: string[], extra: Partial<TenantSettings> = {}) =>
    makeTenantSettings({ ...saved, allowCommandExecution: true, approvedSandboxEgressDomains: hosts, ...extra });

  test("ignores edits that save the same hosts: order, duplicates, case, spaces and invalid lines", () => {
    const stored = withHosts(["*.example.com", "pypi.org"]);
    const draft = draftFrom(stored, { sandboxEgressText: "  PyPI.org \n*.example.com\n\npypi.org\n" });
    expect(diffAgentBehavior(buildDraft(stored), draft)).toEqual([]);
    // A line that fails the host check is not a host, so it does not count as a change either.
    expect(diffAgentBehavior(buildDraft(stored), draftFrom(stored, { sandboxEgressText: "*.example.com\npypi.org\n*.com" })))
      .toEqual([]);
  });

  test("approving a host widens access and says when it applies", () => {
    const stored = withHosts([]);
    const changes = diffAgentBehavior(buildDraft(stored), draftFrom(stored, { sandboxEgressText: "pypi.org\n*.example.com" }));
    expect(change(changes, "approvedSandboxEgressDomains")).toMatchObject({
      display: "set",
      label: "Sandbox network access",
      added: ["*.example.com", "pypi.org"],
      removed: [],
      tone: "widens",
      savedOnly: false
    });
    expect(change(changes, "approvedSandboxEgressDomains").effect).toContain("next turn");
    // The network of a sandbox is fixed at creation, so a change replaces the sandbox. The admin is told before saving.
    expect(change(changes, "approvedSandboxEgressDomains").effect)
      .toContain("sandbox is replaced at its next turn, and files that only existed in the old sandbox are lost");
    expect(change(changes, "approvedSandboxEgressDomains").effect).not.toContain("updated in place");
    // A sandbox that could not be stopped keeps the network that it was created with. The admin is told that too.
    expect(change(changes, "approvedSandboxEgressDomains").effect)
      .toContain("If an old sandbox cannot be stopped, it keeps its old network access until it expires.");
    // The limits of the filter are stated where the admin decides.
    expect(change(changes, "approvedSandboxEgressDomains").note).toContain("DNS lookups");
  });

  test("removing every host narrows access to no network", () => {
    const stored = withHosts(["pypi.org"]);
    const changes = diffAgentBehavior(buildDraft(stored), draftFrom(stored, { sandboxEgressText: "" }));
    expect(change(changes, "approvedSandboxEgressDomains")).toMatchObject({
      added: [],
      removed: ["pypi.org"],
      tone: "narrows"
    });
    expect(change(changes, "approvedSandboxEgressDomains").effect).toContain("no network access");
    // For a narrowing this matters most: a sandbox that is not stopped keeps the hosts that were removed.
    expect(change(changes, "approvedSandboxEgressDomains").effect).toContain("cannot be stopped");
  });

  test("with command execution off, the note says that nothing runs yet", () => {
    const stored = makeTenantSettings({ ...saved, allowCommandExecution: false, approvedSandboxEgressDomains: [] });
    const changes = diffAgentBehavior(buildDraft(stored), draftFrom(stored, { sandboxEgressText: "pypi.org" }));
    expect(change(changes, "approvedSandboxEgressDomains").note).toContain("Command execution is off");
  });

  test("sends the checked, sorted list and leaves invalid lines out", () => {
    const input = toBehaviorInput(draftFrom(saved, { sandboxEgressText: "PyPI.org\n*.com\nfiles.pythonhosted.org\npypi.org" }), 3);
    expect(input.approvedSandboxEgressDomains).toEqual(["files.pythonhosted.org", "pypi.org"]);
    expect(toBehaviorInput(draftFrom(saved, { sandboxEgressText: "" }), 3).approvedSandboxEgressDomains).toEqual([]);
  });

  test("a rebase keeps another administrator's hosts and applies only my edits", () => {
    const from = buildDraft(withHosts(["pypi.org", "old.example.com"]));
    const mine = draftFrom(withHosts(["pypi.org", "old.example.com"]), { sandboxEgressText: "pypi.org\nmine.example.com" });
    const latest = buildDraft(withHosts(["pypi.org", "old.example.com", "theirs.example.com"], { version: 2 }));

    const rebased = rebaseDraft(from, mine, latest);

    // Mine added mine.example.com and removed old.example.com. Theirs added theirs.example.com.
    expect(rebased.sandboxEgressText.split("\n")).toEqual(["mine.example.com", "pypi.org", "theirs.example.com"]);
    expect(diffAgentBehavior(latest, rebased).map((entry) => entry.field)).toEqual(["approvedSandboxEgressDomains"]);
  });

  test("a draft that did not change the hosts takes the latest list as it is", () => {
    const from = buildDraft(withHosts(["pypi.org"]));
    const mine = draftFrom(withHosts(["pypi.org"]), { developerInstructions: "Mine" });
    const latest = buildDraft(withHosts(["pypi.org", "files.pythonhosted.org"], { version: 2 }));

    expect(rebaseDraft(from, mine, latest).sandboxEgressText).toBe(latest.sandboxEgressText);
  });
});
