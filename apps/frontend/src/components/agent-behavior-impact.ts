import type { TenantSettingsInput } from "../hooks/use-tenant-settings";
import {
  defaultGranularFlags,
  parseSandboxEgressText,
  toApprovalPolicy,
  type ApprovalPolicyKind,
  type FormDraft,
  type GranularFlags
} from "./tenant-settings-form.logic";

// Effect copy in this file describes the current Deep Agents runtime:
// resolveTurnApprovalSettings (runtime-contracts.ts) and buildInterruptOn
// (deep-agents-graph.ts). Recheck both before you change a sentence.

export const APPROVAL_POLICY_LABELS: Record<ApprovalPolicyKind, string> = {
  never: "Never require approval",
  "on-request": "Require approval",
  granular: "Granular (per category)"
};

export const GRANULAR_CATEGORY_LABELS: Record<keyof GranularFlags, string> = {
  sandbox_approval: "Sandbox operations",
  mcp_elicitations: "MCP elicitations",
  rules: "Rules",
  request_permissions: "Permission requests",
  skill_approval: "Skill invocations"
};

const GRANULAR_KEYS = Object.keys(GRANULAR_CATEGORY_LABELS) as Array<keyof GranularFlags>;

const WEB_SEARCH_LABELS: Record<FormDraft["webSearchMode"], string> = {
  disabled: "Disabled",
  cached: "Cached",
  live: "Live"
};

const REVIEWER_LABELS: Record<FormDraft["approvalReviewer"], string> = {
  user: "User (human in the loop)",
  guardian_subagent: "Guardian sub-agent"
};

/** The Agent behavior fields in the form that has no-op edits removed. */
export type BehaviorSnapshot = Pick<
  FormDraft,
  | "webSearchMode"
  | "approvalPolicyKind"
  | "granularFlags"
  | "approvalReviewer"
  | "allowCommandExecution"
  | "autoApproveReadOnlyTools"
  | "developerInstructions"
  | "enabledToolIds"
> & {
  /** The approved sandbox hosts that pass the check, sorted and without duplicates. */
  approvedSandboxEgressDomains: string[];
};

/**
 * Remove differences that do not change what is saved: surrounding spaces in
 * instructions (the form saves trimmed text), tool order and duplicates, and
 * category flags when the policy is not granular.
 */
export function normalizeBehavior(draft: FormDraft): BehaviorSnapshot {
  return {
    webSearchMode: draft.webSearchMode,
    approvalPolicyKind: draft.approvalPolicyKind,
    granularFlags:
      draft.approvalPolicyKind === "granular" ? { ...draft.granularFlags } : { ...defaultGranularFlags },
    approvalReviewer: draft.approvalReviewer,
    allowCommandExecution: draft.allowCommandExecution,
    autoApproveReadOnlyTools: draft.autoApproveReadOnlyTools,
    developerInstructions: draft.developerInstructions.trim(),
    enabledToolIds: [...new Set(draft.enabledToolIds)].sort(),
    approvedSandboxEgressDomains: parseSandboxEgressText(draft.sandboxEgressText).domains
  };
}

export type ImpactTone = "widens" | "narrows" | "neutral";

type ChangeBase = {
  field: string;
  label: string;
  /** The result of the change for agents, in plain words. */
  effect: string;
  /** A condition or exception that the administrator must know. */
  note?: string;
  tone: ImpactTone;
  /** True when the current runtime does not read this value. */
  savedOnly: boolean;
};

export type BehaviorChange =
  | (ChangeBase & { display: "values"; before: string; after: string })
  | (ChangeBase & { display: "set"; added: string[]; removed: string[] })
  | (ChangeBase & { display: "text"; before: string; after: string });

const SANDBOX_NOTE = "Commands need a sandbox key (E2B) on the server. Without one, agents cannot run commands.";

function gates(kind: ApprovalPolicyKind): boolean {
  return kind !== "never";
}

function onOff(value: boolean): string {
  return value ? "On" : "Off";
}

function setDelta(before: string[], after: string[]) {
  return {
    added: after.filter((id) => !before.includes(id)),
    removed: before.filter((id) => !after.includes(id))
  };
}

function enabledCategories(flags: GranularFlags): string[] {
  return GRANULAR_KEYS.filter((key) => flags[key]).map((key) => GRANULAR_CATEGORY_LABELS[key]);
}

function approvalPolicyChange(before: BehaviorSnapshot, after: BehaviorSnapshot): BehaviorChange {
  const values = {
    display: "values" as const,
    field: "approvalPolicy",
    label: "Approval mode",
    before: APPROVAL_POLICY_LABELS[before.approvalPolicyKind],
    after: APPROVAL_POLICY_LABELS[after.approvalPolicyKind],
    savedOnly: false
  };
  if (!gates(after.approvalPolicyKind)) {
    return {
      ...values,
      tone: "widens",
      effect: after.allowCommandExecution
        ? "Agents change files, run shell commands in a sandbox, and use their available connection tools without asking for approval."
        : "Agents change files and use their available connection tools without asking for approval. They cannot run shell commands while command execution is off.",
      // With commands on, the commands-without-approval highlight states the sandbox condition.
      note:
        "Enforced Policy Center rules still apply to connection tools. Projects set to manual approval still ask."
    };
  }
  if (!gates(before.approvalPolicyKind)) {
    const commands = after.allowCommandExecution ? " run shell commands," : "";
    return {
      ...values,
      tone: "narrows",
      effect: after.autoApproveReadOnlyTools
        ? `Agents ask for approval before they change files,${commands} or use available connection tools that can change data. Read-only tools run without a prompt.`
        : `Agents ask for approval before they read or change files,${commands} or use available connection tools.`,
      note: after.allowCommandExecution ? undefined : "Shell commands stay off while command execution is off."
    };
  }
  return {
    ...values,
    tone: "neutral",
    effect: "Agents ask for approval in the same way as before.",
    note: "The current runtime does not read single categories. A granular policy asks for approval like Require approval."
  };
}

function granularCategoriesChange(
  before: BehaviorSnapshot,
  after: BehaviorSnapshot
): BehaviorChange | null {
  if (after.approvalPolicyKind !== "granular") return null;
  const { added, removed } = setDelta(
    enabledCategories(before.granularFlags),
    enabledCategories(after.granularFlags)
  );
  if (added.length === 0 && removed.length === 0) return null;
  return {
    display: "set",
    field: "granularCategories",
    label: "Granular categories",
    added,
    removed,
    tone: "neutral",
    savedOnly: true,
    effect: "No change to agent behavior. The categories are saved with the organization settings.",
    note: "The current runtime does not read single categories. A granular policy asks for approval like Require approval."
  };
}

function readOnlyChange(before: BehaviorSnapshot, after: BehaviorSnapshot): BehaviorChange {
  const values = {
    display: "values" as const,
    field: "autoApproveReadOnlyTools",
    label: "Auto-approve read-only tools",
    before: onOff(before.autoApproveReadOnlyTools),
    after: onOff(after.autoApproveReadOnlyTools),
    savedOnly: false
  };
  if (!gates(after.approvalPolicyKind)) {
    return {
      ...values,
      tone: "neutral",
      effect:
        "No effect while approval mode is Never require approval, because agents do not ask before tools.",
      note: "This setting applies again when approval is turned on."
    };
  }
  if (after.autoApproveReadOnlyTools) {
    return {
      ...values,
      tone: "widens",
      effect:
        "Agents list, read, and search files and use read-only connection tools without asking. File changes, shell commands, and other connection tools still ask.",
      note: "Projects set to manual approval still ask before read-only tools."
    };
  }
  return {
    ...values,
    tone: "narrows",
    effect:
      "Agents ask for approval before they list, read, or search files and before they use read-only connection tools."
  };
}

function commandChange(after: BehaviorSnapshot): BehaviorChange {
  const values = {
    display: "values" as const,
    field: "allowCommandExecution",
    label: "Allow command execution",
    before: onOff(!after.allowCommandExecution),
    after: onOff(after.allowCommandExecution),
    savedOnly: false
  };
  if (!after.allowCommandExecution) {
    return {
      ...values,
      tone: "narrows",
      effect: "Agents cannot run shell commands. They keep the file tools in their workspace."
    };
  }
  return {
    ...values,
    tone: "widens",
    effect: gates(after.approvalPolicyKind)
      ? "Agents can run shell commands in a sandbox. Each command asks for approval first."
      : "Agents can run shell commands in a sandbox without asking for approval.",
    note: SANDBOX_NOTE
  };
}

function instructionsChange(before: string, after: string): BehaviorChange {
  const effect =
    after === ""
      ? "Agents stop using organization instructions from their next turn."
      : before === ""
        ? "Agents get these instructions in their system prompt from their next turn."
        : "Agents use the new instructions in their system prompt from their next turn.";
  return {
    display: "text",
    field: "developerInstructions",
    label: "Organization instructions",
    before,
    after,
    effect,
    tone: "neutral",
    savedOnly: false
  };
}

function toolsChange(before: string[], after: string[]): BehaviorChange | null {
  const { added, removed } = setDelta(before, after);
  if (added.length === 0 && removed.length === 0) return null;
  const sentences = [
    added.length > 0
      ? "Added tools become available to agents from their next turn, if the connection and its audience allow it."
      : null,
    removed.length > 0 ? "Agents stop getting the removed tools from their next turn." : null
  ].filter(Boolean);
  return {
    display: "set",
    field: "enabledToolIds",
    label: "Advanced tool access",
    added,
    removed,
    effect: sentences.join(" "),
    tone: added.length > 0 ? "widens" : "narrows",
    savedOnly: false
  };
}

const NETWORK_NOTE =
  "The network filter judges a request by the host name it states. Approve only hosts that you would let " +
  "agent-run code send data to. While any host is approved, DNS lookups also work for every name.";

function sandboxNetworkChange(before: string[], after: string[], commandsOn: boolean): BehaviorChange | null {
  const { added, removed } = setDelta(before, after);
  if (added.length === 0 && removed.length === 0) return null;
  const sentences = [
    added.length > 0
      ? "Commands that agents run in the sandbox can reach the added hosts from each session's next turn."
      : null,
    removed.length > 0
      ? "Commands can no longer reach the removed hosts from each session's next turn."
      : null,
    after.length === 0 ? "The sandbox then has no network access." : null,
    // The network of a sandbox is fixed when it is created, so a sandbox that does not match the new list is replaced.
    "Each session's sandbox is replaced at its next turn, and files that only existed in the old sandbox are lost.",
    // The old sandbox is killed with retries. If every try fails, it runs until the provider expires it.
    "If an old sandbox cannot be stopped, it keeps its old network access until it expires."
  ].filter(Boolean);
  return {
    display: "set",
    field: "approvedSandboxEgressDomains",
    label: "Sandbox network access",
    added,
    removed,
    effect: sentences.join(" "),
    tone: added.length > 0 ? "widens" : "narrows",
    savedOnly: false,
    note: commandsOn
      ? NETWORK_NOTE
      : "Command execution is off, so no sandbox runs. The hosts are saved and apply when command execution is on."
  };
}

/** Changed Agent behavior fields, in form order, with their effect. */
export function diffAgentBehavior(baseline: FormDraft, draft: FormDraft): BehaviorChange[] {
  const before = normalizeBehavior(baseline);
  const after = normalizeBehavior(draft);
  const changes: Array<BehaviorChange | null> = [];

  if (before.webSearchMode !== after.webSearchMode) {
    changes.push({
      display: "values",
      field: "webSearchMode",
      label: "Web search",
      before: WEB_SEARCH_LABELS[before.webSearchMode],
      after: WEB_SEARCH_LABELS[after.webSearchMode],
      tone: "neutral",
      savedOnly: true,
      effect: "No change to agent behavior. The value is saved and shown in audit records.",
      note: "The current runtime does not use this value to turn web search on or off, or to select cached or live results."
    });
  }
  if (before.approvalPolicyKind !== after.approvalPolicyKind) {
    changes.push(approvalPolicyChange(before, after));
  }
  changes.push(granularCategoriesChange(before, after));
  if (before.approvalReviewer !== after.approvalReviewer) {
    changes.push({
      display: "values",
      field: "approvalReviewer",
      label: "Approval reviewer",
      before: REVIEWER_LABELS[before.approvalReviewer],
      after: REVIEWER_LABELS[after.approvalReviewer],
      tone: "neutral",
      savedOnly: true,
      effect: "No change to agent behavior. The value is saved with the organization settings.",
      note: "The current runtime does not read this value. The person who runs the turn answers each approval prompt."
    });
  }
  if (before.autoApproveReadOnlyTools !== after.autoApproveReadOnlyTools) {
    changes.push(readOnlyChange(before, after));
  }
  if (before.allowCommandExecution !== after.allowCommandExecution) {
    changes.push(commandChange(after));
  }
  changes.push(sandboxNetworkChange(before.approvedSandboxEgressDomains, after.approvedSandboxEgressDomains, after.allowCommandExecution));
  changes.push(toolsChange(before.enabledToolIds, after.enabledToolIds));
  if (before.developerInstructions !== after.developerInstructions) {
    changes.push(instructionsChange(before.developerInstructions, after.developerInstructions));
  }

  return changes.filter((change): change is BehaviorChange => change !== null);
}

export type ImpactHighlight = { id: string; title: string; detail: string };

/**
 * Combined results that no single row states. Only shown when this change
 * causes them, not when the saved settings already had them.
 */
export function deriveImpactHighlights(baseline: FormDraft, draft: FormDraft): ImpactHighlight[] {
  const before = normalizeBehavior(baseline);
  const after = normalizeBehavior(draft);
  const commandsWithoutApproval = (snapshot: BehaviorSnapshot) =>
    snapshot.allowCommandExecution && !gates(snapshot.approvalPolicyKind);

  if (commandsWithoutApproval(after) && !commandsWithoutApproval(before)) {
    return [
      {
        id: "commands-without-approval",
        title: "All members' agents can run shell commands without approval.",
        detail: `${SANDBOX_NOTE} Projects set to manual approval still ask. Enforced Policy Center rules still apply to connection tools.`
      }
    ];
  }
  return [];
}

/** True when a change touches how agents ask for approval. */
export function affectsApprovals(changes: BehaviorChange[]): boolean {
  return changes.some((change) =>
    ["approvalPolicy", "autoApproveReadOnlyTools", "allowCommandExecution"].includes(change.field)
  );
}

/**
 * Apply the edits that were made on `from` to `onto`. A field that the draft
 * did not change takes its value from `onto`, so another administrator's
 * change to that field is kept. Tool IDs merge as added and removed sets.
 * Granular flags merge one by one only when the draft kept the granular mode.
 * When the draft selected granular, its full category set is kept.
 */
export function rebaseDraft(from: FormDraft, draft: FormDraft, onto: FormDraft): FormDraft {
  const base = normalizeBehavior(from);
  const edited = normalizeBehavior(draft);
  const pick = <K extends keyof BehaviorSnapshot & keyof FormDraft>(key: K): FormDraft[K] =>
    (base[key] === edited[key] ? onto[key] : draft[key]) as FormDraft[K];

  const selectedGranular =
    base.approvalPolicyKind !== edited.approvalPolicyKind && edited.approvalPolicyKind === "granular";
  const granularFlags = selectedGranular ? { ...edited.granularFlags } : { ...onto.granularFlags };
  if (!selectedGranular) {
    for (const key of GRANULAR_KEYS) {
      if (base.granularFlags[key] !== edited.granularFlags[key]) {
        granularFlags[key] = edited.granularFlags[key];
      }
    }
  }

  const { added, removed } = setDelta(base.enabledToolIds, edited.enabledToolIds);
  const enabledToolIds = [
    ...onto.enabledToolIds.filter((id) => !removed.includes(id)),
    ...added.filter((id) => !onto.enabledToolIds.includes(id))
  ];

  // Approved hosts merge as added and removed sets, like tool IDs. A draft that
  // did not change them takes the text of `onto` as it is.
  const hosts = setDelta(base.approvedSandboxEgressDomains, edited.approvedSandboxEgressDomains);
  const ontoHosts = parseSandboxEgressText(onto.sandboxEgressText).domains;
  const sandboxEgressText = hosts.added.length === 0 && hosts.removed.length === 0
    ? onto.sandboxEgressText
    : [
        ...ontoHosts.filter((host) => !hosts.removed.includes(host)),
        ...hosts.added.filter((host) => !ontoHosts.includes(host))
      ].sort().join("\n");

  return {
    ...onto,
    webSearchMode: pick("webSearchMode"),
    approvalPolicyKind: pick("approvalPolicyKind"),
    granularFlags,
    approvalReviewer: pick("approvalReviewer"),
    allowCommandExecution: pick("allowCommandExecution"),
    autoApproveReadOnlyTools: pick("autoApproveReadOnlyTools"),
    developerInstructions:
      base.developerInstructions === edited.developerInstructions
        ? onto.developerInstructions
        : draft.developerInstructions,
    enabledToolIds,
    sandboxEgressText
  };
}

/**
 * The save payload. Only Agent behavior fields: models, effort selector,
 * connections, and policy enforcement belong to other pages.
 */
export function toBehaviorInput(draft: FormDraft, expectedVersion: number): TenantSettingsInput {
  return {
    expectedVersion,
    webSearchMode: draft.webSearchMode,
    approvalPolicy: toApprovalPolicy(draft.approvalPolicyKind, draft.granularFlags),
    approvalReviewer: draft.approvalReviewer,
    allowCommandExecution: draft.allowCommandExecution,
    autoApproveReadOnlyTools: draft.autoApproveReadOnlyTools,
    developerInstructions: draft.developerInstructions.trim() || null,
    enabledToolIds: draft.enabledToolIds,
    approvedSandboxEgressDomains: parseSandboxEgressText(draft.sandboxEgressText).domains
  };
}
