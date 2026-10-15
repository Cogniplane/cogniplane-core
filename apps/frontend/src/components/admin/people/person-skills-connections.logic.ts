import type {
  AdminPersonAccessResponse,
  PersonAccessGate,
  PersonAccessGateCheck,
  PersonAccessGateResult,
  PersonAccessItem,
  PersonAccessItemStatus,
  PersonAccessNotCovered,
  PersonAccessReason
} from "@cogniplane/shared-types";

// The backend decides every result. This module only orders, filters, and
// words those results; it must not calculate eligibility.

export const PERSON_TAB_PARAM = "tab";
export const SKILLS_CONNECTIONS_TAB = "skills-connections";
export type PersonTab = "activity" | typeof SKILLS_CONNECTIONS_TAB;

export function personTabFromParam(value: string | null): PersonTab {
  return value === SKILLS_CONNECTIONS_TAB ? SKILLS_CONNECTIONS_TAB : "activity";
}

/** The same path with only the tab parameter changed. Activity is the default and has no parameter. */
export function personTabHref(pathname: string, params: URLSearchParams, tab: PersonTab): string {
  const next = new URLSearchParams(params.toString());
  if (tab === "activity") next.delete(PERSON_TAB_PARAM);
  else next.set(PERSON_TAB_PARAM, tab);
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export type StatusFilter = "not_included" | "included" | "all";

export type StatusCounts = Record<PersonAccessItemStatus, number>;

export function countByStatus(items: readonly PersonAccessItem[]): StatusCounts {
  const counts: StatusCounts = { excluded: 0, unknown: 0, included: 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

/** Start with what needs attention. If nothing does, show everything. */
export function defaultStatusFilter(counts: StatusCounts): StatusFilter {
  return counts.excluded + counts.unknown > 0 ? "not_included" : "all";
}

const STATUS_ORDER: Record<PersonAccessItemStatus, number> = { excluded: 0, unknown: 1, included: 2 };

export function visibleItems(items: readonly PersonAccessItem[], filter: StatusFilter, search: string): PersonAccessItem[] {
  const term = search.trim().toLocaleLowerCase();
  return items
    .filter((item) => filter === "all"
      || (filter === "included" ? item.status === "included" : item.status !== "included"))
    .filter((item) => !term
      || item.name.toLocaleLowerCase().includes(term)
      || item.id.toLocaleLowerCase().includes(term))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      || a.id.localeCompare(b.id));
}

/** The first check that did not pass. Later checks were not evaluated. */
export function firstBlocker(item: PersonAccessItem): PersonAccessGateCheck | null {
  return item.gates.find((check) => check.result === "fail" || check.result === "unknown") ?? null;
}

export const STATUS_LABEL: Record<PersonAccessItemStatus, string> = {
  excluded: "Excluded",
  unknown: "Unknown",
  included: "Included"
};

export const RESULT_LABEL: Record<PersonAccessGateResult, string> = {
  pass: "Passed",
  fail: "Failed",
  unknown: "Could not check",
  not_checked: "Not checked"
};

export function gateLabel(gate: PersonAccessGate, name: string): string {
  switch (gate) {
    case "visible_to_member": return `Turned on and released to ${name}`;
    case "allowed_for_organization": return "Allowed for the organization";
    case "in_member_defaults": return `In ${name}'s defaults for new chats`;
    case "has_instructions": return "Has instructions for the agent";
    case "personal_sign_in": return `${name}'s sign-in`;
  }
}

export function reasonText(reason: PersonAccessReason, name: string): string {
  switch (reason) {
    case "turned_off": return "Turned off.";
    case "test_users_only": return "Released to test users only.";
    case "not_allowed_for_organization": return "Not allowed for the organization.";
    case "not_in_member_defaults": return `Not in ${name}'s defaults for new chats.`;
    case "no_instructions": return "Has no instructions, so the agent does not get it.";
    case "member_not_connected": return `${name} has not signed in to this connection.`;
    case "member_must_reconnect": return `${name} must sign in again.`;
    case "personal_sign_in_not_configured": return "Personal sign-in is not set up for this connection.";
    case "sign_in_not_accepted": return `The connection's current setup does not accept ${name}'s sign-in.`;
    case "legacy_settings_pending": return "Saved connection settings need review. Sign-in cannot be checked until then.";
  }
}

/** One line under the resource name. */
export function itemSummary(item: PersonAccessItem, name: string, emptyDefaults: boolean): string {
  const blocker = firstBlocker(item);
  if (!blocker) return item.status === "included" ? "Included in new chats." : "Could not be checked.";
  if (!blocker.reason) return blocker.result === "unknown" ? "Could not be checked." : "A check failed.";
  // The notice above the list explains empty defaults once.
  if (blocker.reason === "not_in_member_defaults" && emptyDefaults) return "Not in defaults. See the note above.";
  return reasonText(blocker.reason, name);
}

export type MemberAction = { label: string; path: string; instruction: string };

export const MEMBER_DEFAULTS_PATH = "/settings/capabilities?tab=defaults";
export const MEMBER_CONNECTIONS_PATH = "/settings/connections";

/** Member-side fixes. Admins copy the link; it opens the member's own settings when they sign in. */
export function memberAction(reason: PersonAccessReason | undefined, name: string): MemberAction | null {
  if (reason === "not_in_member_defaults") {
    return {
      label: `Copy settings link for ${name}`,
      path: MEMBER_DEFAULTS_PATH,
      instruction: `${name} can add it under Chat defaults.`
    };
  }
  if (reason === "member_not_connected" || reason === "member_must_reconnect") {
    return {
      label: `Copy sign-in link for ${name}`,
      path: MEMBER_CONNECTIONS_PATH,
      instruction: `${name} can sign in under Connected accounts.`
    };
  }
  return null;
}

export function resourceHref(item: Pick<PersonAccessItem, "kind" | "id">): string {
  return item.kind === "skill"
    ? `/admin/skills?skill=${encodeURIComponent(item.id)}`
    : `/admin/connections?connection=${encodeURIComponent(item.id)}`;
}

type SourceFields = Pick<PersonAccessItem, "runtimeSource" | "adminPageSource">;

/** True when the member gets a different version than the admin page shows. */
function sourcesDiffer(item: SourceFields): boolean {
  return item.runtimeSource !== null && item.runtimeSource !== item.adminPageSource;
}

export function resourceLabel(item: Pick<PersonAccessItem, "kind"> & SourceFields): string {
  // The link always opens the admin page version. Name it when the member gets the other one.
  if (sourcesDiffer(item)) return item.adminPageSource === "system" ? "Open the built-in version" : "Open the organization copy";
  return item.kind === "skill" ? "Open the skill" : "Open the connection";
}

/** The source label is the version the member gets. With no eligible version, it is the admin page version. */
export function kindLabel(item: Pick<PersonAccessItem, "kind" | "signIn"> & SourceFields): string {
  const kind = item.kind === "skill" ? "Skill" : "Connection";
  const source = (item.runtimeSource ?? item.adminPageSource) === "system" ? "Built in" : "Organization";
  const signIn = item.signIn === "personal" ? "Personal sign-in" : item.signIn === "organization" ? "Organization sign-in" : null;
  return [kind, source, signIn].filter(Boolean).join(" · ");
}

export function sourceNote(item: SourceFields, name: string): string | null {
  if (!sourcesDiffer(item)) return null;
  return item.runtimeSource === "system"
    ? `Uses the built-in version. The organization copy is not available to ${name}.`
    : "Uses the organization copy, not the built-in version.";
}

export const NOT_COVERED_LABEL: Record<PersonAccessNotCovered, string> = {
  projects: "Project chats",
  existing_chats: "Chats that already exist",
  personal_skills: "Private skills",
  project_skills: "Project skills",
  built_in_integrations: "Built-in integration permissions",
  tool_permissions: "Tool permissions",
  policy_rules: "Policy rules for each action",
  models_and_budgets: "Models and budgets",
  live_connection_health: "Whether a connected service is working now"
};

export function defaultsNote(member: AdminPersonAccessResponse["member"], name: string): string {
  switch (member.defaults) {
    case "inherited": return `${name} uses the organization's defaults for new chats.`;
    case "custom": return `${name} chose their own defaults for new chats.`;
    case "empty": return `${name} chose no defaults for new chats.`;
  }
}
